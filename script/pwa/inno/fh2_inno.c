/* fh2_inno.c -- decoders for the payload of an Inno Setup 5.6.2 (unicode) installer.

   This module is deliberately dumb: it owns no knowledge of *where* anything lives in
   the installer and it never performs I/O. The JavaScript side (files/emscripten/inno.js)
   parses the format, works out the exact byte range of one compressed chunk, feeds that
   range in here a slice at a time and collects the decoded bytes. Two reasons for the
   split: wasm cannot await a Blob read, and keeping the pump synchronous means the heap
   never holds more than the window the caller chose (see the iOS note in index.html).

   Everything below is a transcription of the reference format reader in innoextract
   (dscharrer, Zlib licence) -- the file:line citations in the comments point at the copy
   that was read while writing this (see LICENSES.md for the licence terms of everything
   actually linked in).

   Contract (pointers into module memory, no JS callbacks, no exceptions, no asyncify):
     fh2_probe            recognise a header block
     fh2_block_decode     whole header block -> plaintext (Stored | LZMA1)
     fh2_slice_open       one chunk decoder for a given compression + props
     fh2_slice_pump       push compressed bytes in, get plaintext out
     fh2_slice_consumed   input bytes eaten so far
     fh2_slice_error      sticky error code of a handle
     fh2_slice_close      release everything
     fh2_alloc/fh2_free   scratch memory for the caller
*/

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "zlib.h"

#include "LzmaDec.h"
#include "Lzma2Dec.h"

/* Compression ids are Inno Setup's own numbering, taken from stream/chunk.hpp:29-36
   (Stored, Zlib, BZip2, LZMA1, LZMA2, UnknownCompression) so that the JavaScript side can
   hand over the value it read out of the setup header record without re-mapping it. */
#define FH2_STORED   0
#define FH2_ZLIB     1
#define FH2_BZIP2    2
#define FH2_LZMA1    3
#define FH2_LZMA2    4

/* Error codes are the only channel this module has, so they name the failure rather than
   the call site: the UI shows them after translating, and the tests assert them. */
#define FH2_OK                 0
#define FH2_ERR_ARGS          -1  /* null/short/negative input the caller should have caught */
#define FH2_ERR_PROPS         -2  /* compression properties are not encodable */
#define FH2_ERR_CORRUPT       -3  /* decoder says the compressed data is broken */
#define FH2_ERR_DICT          -4  /* dictionary larger than the safety cap */
#define FH2_ERR_NOMEM         -5  /* allocation failed */
#define FH2_ERR_STATE         -6  /* bad handle or wrong call order */
#define FH2_ERR_CRC           -8  /* CRC32 of a block or sub-block does not match */
#define FH2_ERR_UNSUPPORTED   -9  /* compression this build cannot do (bzip2) */
#define FH2_ERR_FULL         -10  /* more plaintext than outCap allows */

/* The dictionary size comes straight from attacker-influenced bytes and neither liblzma
   nor the SDK validates it beyond the props encoding, so a hostile installer could ask
   for gigabytes and iOS would kill the tab instead of raising an error
   (stream/lzma.cpp:100-104 does no such check). 64 MiB is far above anything Inno Setup
   itself emits (this installer uses 2 MiB LZMA1 for its header blocks and 64 KiB LZMA2
   dictionaries for its payload) yet small enough to fail cleanly inside a browser. */
#define FH2_MAX_DICT (64u * 1024u * 1024u)

/* ------------------------------------------------------------------ CRC32 -- */
/* Inno Setup's CRC32 is the standard reflected CRC-32 with the 0xFFFFFFFF init/xor pair that
   crypto/crc32.hpp expresses as CRC32_NEGL: it initialises the register to ~0, updates it in
   place and finalises by inverting. zlib keeps the register inverted internally, so passing 0
   to crc32() reproduces exactly that (verified against the header block of the 5.6.2 sample). */
static uint32_t fh2_crc32(const void *data, size_t len)
{
    return (uint32_t)crc32(0L, (const Bytef *)data, (uInt)len);
}

/* --------------------------------------------------------------- handles -- */

typedef struct {
    int kind;          /* FH2_STORED / FH2_ZLIB / FH2_LZMA1 / FH2_LZMA2 */
    int error;         /* sticky, FH2_OK until something goes wrong */
    size_t consumed;   /* input bytes eaten so far, reported by fh2_slice_consumed */
    int finished;      /* decoder reached its natural end */

    z_stream zs;       /* FH2_ZLIB */

    ISzAlloc alloc;    /* lzma side allocator (malloc/free) */

    CLzmaDec lzma1;    /* FH2_LZMA1 */
    CLzma2Dec lzma2;   /* FH2_LZMA2 */
} fh2_slice;

#define FH2_MAX_SLICES 4  /* one per chunk being decoded at a time; the UI uses one */

static fh2_slice *fh2_slots[FH2_MAX_SLICES];

/* The SDK decoders take an ISzAlloc for the dictionary; malloc is enough here because
   fh2_slice_close() frees through the same decoder free function. */
static void *fh2_sz_alloc(ISzAllocPtr pp, size_t size)
{
    (void)pp;
    return malloc(size);
}

static void fh2_sz_free(ISzAllocPtr pp, void *address)
{
    (void)pp;
    free(address);
}

/* LZMA1 properties are 1 props byte + 4-byte little endian dictionary (stream/lzma.cpp:90-99
   splits the byte into pb/lc/lp exactly as the SDK's LzmaProps_Decode does); the SDK expects
   that same 5-byte array, so it is passed through unchanged after the sanity checks. */
static int fh2_check_lzma1_props(const uint8_t *props, int32_t propsLen)
{
    uint32_t dict;

    if (propsLen != 5) {
        return FH2_ERR_PROPS;
    }
    if (props[0] > 9 * 5 * 5) {
        return FH2_ERR_PROPS;
    }
    dict = (uint32_t)props[1] | ((uint32_t)props[2] << 8)
         | ((uint32_t)props[3] << 16) | ((uint32_t)props[4] << 24);
    if (dict == 0 || dict > FH2_MAX_DICT) {
        return FH2_ERR_DICT;
    }
    return FH2_OK;
}

/* LZMA2 properties are a single byte encoding the dictionary: 40 means "unknown" (the
   reference expands it to 0xffffffff, stream/lzma.cpp:126-133, which no bounded pump can
   honour) and anything else is (2 | (p & 1)) << (p / 2 + 11). */
static int fh2_check_lzma2_props(const uint8_t *props, int32_t propsLen)
{
    uint32_t dict;

    if (propsLen != 1) {
        return FH2_ERR_PROPS;
    }
    if (props[0] > 40) {
        return FH2_ERR_PROPS;
    }
    if (props[0] == 40) {
        return FH2_ERR_DICT;
    }
    dict = ((uint32_t)2 | (uint32_t)(props[0] & 1)) << (props[0] / 2 + 11);
    if (dict > FH2_MAX_DICT) {
        return FH2_ERR_DICT;
    }
    return FH2_OK;
}

int32_t fh2_slice_open(int32_t compression, const uint8_t *props, int32_t propsLen)
{
    fh2_slice *s;
    int i, slot = -1;
    int check;

    if (compression == FH2_BZIP2) {
        /* Not vendored: no chunk of this installer is bzip2 (no 'BZh' magic anywhere in the
           data section, and header.compression says LZMA2) so the code and its licence text
           would be dead weight. Fail loudly instead of silently producing garbage. */
        return FH2_ERR_UNSUPPORTED;
    }
    if (compression != FH2_STORED && compression != FH2_ZLIB
        && compression != FH2_LZMA1 && compression != FH2_LZMA2) {
        return FH2_ERR_PROPS;
    }

    for (i = 0; i < FH2_MAX_SLICES; i++) {
        if (fh2_slots[i] == NULL) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        /* Every slot is busy: the caller asked for more concurrent decoders than this module can
           hold, which is the same thing it must handle when calloc fails. */
        return FH2_ERR_NOMEM;
    }

    s = (fh2_slice *)calloc(1, sizeof(*s));
    if (s == NULL) {
        return FH2_ERR_NOMEM;
    }
    s->kind = (int)compression;
    s->error = FH2_OK;
    s->alloc.Alloc = fh2_sz_alloc;
    s->alloc.Free = fh2_sz_free;

    if (compression == FH2_LZMA1) {
        check = fh2_check_lzma1_props(props, propsLen);
        if (check != FH2_OK) {
            free(s);
            return check;
        }
        LzmaDec_Init(&s->lzma1);
        if (LzmaDec_Allocate(&s->lzma1, props, (unsigned)propsLen, &s->alloc) != SZ_OK) {
            free(s);
            return FH2_ERR_NOMEM;
        }
        LzmaDec_Init(&s->lzma1);
    }
    else if (compression == FH2_LZMA2) {
        check = fh2_check_lzma2_props(props, propsLen);
        if (check != FH2_OK) {
            free(s);
            return check;
        }
        Lzma2Dec_Init(&s->lzma2);
        if (Lzma2Dec_Allocate(&s->lzma2, props[0], &s->alloc) != SZ_OK) {
            free(s);
            Lzma2Dec_Free(&s->lzma2, &s->alloc);
            free(s);
            return FH2_ERR_NOMEM;
        }
        Lzma2Dec_Init(&s->lzma2);
    }
    else if (compression == FH2_ZLIB) {
        /* windowBits 15: the zlib (RFC 1950) wrapper, which is what Inno writes -- adding 16
           there would ask for a gzip wrapper instead. stream/chunk.cpp:174 pipes each chunk
           through boost's zlib_decompressor (a plain inflateInit), so this matches it. */
        if (inflateInit2(&s->zs, 15) != Z_OK) {
            free(s);
            return FH2_ERR_NOMEM;
        }
    }

    fh2_slots[slot] = s;
    return slot + 1; /* handle 0 would collide with the "no handle" convention */
}

int32_t fh2_slice_pump(int32_t h, const uint8_t *in, int32_t inLen,
                       uint8_t *out, int32_t outCap)
{
    fh2_slice *s;
    SizeT inPos;
    SizeT outPos;
    SRes res;
    ELzmaStatus status;

    if (h < 1 || h > FH2_MAX_SLICES) {
        return FH2_ERR_STATE;
    }
    s = fh2_slots[h - 1];
    if (s == NULL) {
        return FH2_ERR_STATE;
    }
    if (s->error != FH2_OK) {
        return s->error;
    }
    if (inLen < 0 || outCap < 0 || (inLen > 0 && in == NULL) || (outCap > 0 && out == NULL)) {
        s->error = FH2_ERR_ARGS;
        return s->error;
    }

    switch (s->kind) {

    case FH2_STORED:
        outPos = (SizeT)(inLen < outCap ? inLen : outCap);
        memcpy(out, in, outPos);
        s->consumed += outPos;
        return (int32_t)outPos;

    case FH2_ZLIB:
        /* inflate() writes through next_out, so unlike the LZMA decoders it cannot be asked
           for "at most outCap" and then clipped: the budget is handed to it up front. */
        s->zs.next_in = (Bytef *)in;
        s->zs.avail_in = (uInt)inLen;
        s->zs.next_out = out;
        s->zs.avail_out = (uInt)outCap;
        for (;;) {
            int code = inflate(&s->zs, Z_NO_FLUSH);
            if (code == Z_OK || code == Z_BUF_ERROR) {
                break; /* ran out of input and/or output, both fine mid-stream */
            }
            if (code == Z_STREAM_END) {
                s->finished = 1;
                break;
            }
            s->error = FH2_ERR_CORRUPT;
            return s->error;
        }
        outPos = (SizeT)(outCap - (int32_t)s->zs.avail_out);
        s->consumed += (size_t)((int32_t)inLen - (int32_t)s->zs.avail_in);
        return (int32_t)outPos;

    case FH2_LZMA1:
        /* Raw LZMA1 carries no uncompressed size and needs no end marker, so reaching the
           end of the requested output with input left over is normal, and so is the SDK
           reporting "maybe finished" when the input runs out (stream/lzma.cpp:63-65).
           Both *Len arguments of DecodeToBuf are in/out: they carry the capacity and the
           byte count in, and the number consumed out. Passing zero would tell the decoder
           it may write nothing and fed it nothing, which returns SZ_OK forever. */
        inPos = (SizeT)inLen;
        outPos = (SizeT)outCap;
        res = LzmaDec_DecodeToBuf(&s->lzma1, out, &outPos, in, &inPos,
                                  LZMA_FINISH_ANY, &status);
        if (res != SZ_OK) {
            s->error = (res == SZ_ERROR_MEM) ? FH2_ERR_NOMEM : FH2_ERR_CORRUPT;
            return s->error;
        }
        if (status == LZMA_STATUS_FINISHED_WITH_MARK) {
            s->finished = 1;
        }
        s->consumed += inPos;
        return (int32_t)outPos;

    default: /* FH2_LZMA2 */
        /* Same in/out capacity contract as LZMA1 above; an LZMA2 stream is a chain of chunks
           and the decoder stays open across them, so the dictionary carries over (which is why
           a solid archive can only be decoded from its start, and why a chunk is never fed to
           two handles). */
        inPos = (SizeT)inLen;
        outPos = (SizeT)outCap;
        res = Lzma2Dec_DecodeToBuf(&s->lzma2, out, &outPos, in, &inPos,
                                   LZMA_FINISH_ANY, &status);
        if (res != SZ_OK) {
            s->error = (res == SZ_ERROR_MEM) ? FH2_ERR_NOMEM : FH2_ERR_CORRUPT;
            return s->error;
        }
        if (status == LZMA_STATUS_FINISHED_WITH_MARK) {
            s->finished = 1;
        }
        s->consumed += inPos;
        return (int32_t)outPos;
    }
}

int32_t fh2_slice_consumed(int32_t h)
{
    if (h < 1 || h > FH2_MAX_SLICES || fh2_slots[h - 1] == NULL) {
        return FH2_ERR_STATE;
    }
    return (int32_t)fh2_slots[h - 1]->consumed;
}
/* The pump is push-based, so the caller has to learn when a stream is over: a zlib chunk ends
   at its own adler32, an LZMA2 chunk at its 0x00 terminator, and in both cases there may be
   padding after that which must not be fed to the next chunk's decoder (this installer puts
   two such bytes after every LZMA2 chunk). 1 once the decoder saw its end marker. */
int32_t fh2_slice_finished(int32_t h)
{
    if (h < 1 || h > FH2_MAX_SLICES || fh2_slots[h - 1] == NULL) {
        return FH2_ERR_STATE;
    }
    return fh2_slots[h - 1]->finished ? 1 : 0;
}

int32_t fh2_slice_error(int32_t h)
{
    if (h < 1 || h > FH2_MAX_SLICES || fh2_slots[h - 1] == NULL) {
        return FH2_ERR_STATE;
    }
    return fh2_slots[h - 1]->error;
}

void fh2_slice_close(int32_t h)
{
    fh2_slice *s;

    if (h < 1 || h > FH2_MAX_SLICES) {
        return;
    }
    s = fh2_slots[h - 1];
    if (s == NULL) {
        return;
    }
    fh2_slots[h - 1] = NULL;

    if (s->kind == FH2_ZLIB) {
        inflateEnd(&s->zs);
    }
    else if (s->kind == FH2_LZMA1) {
        LzmaDec_Free(&s->lzma1, &s->alloc);
    }
    else if (s->kind == FH2_LZMA2) {
        Lzma2Dec_Free(&s->lzma2, &s->alloc);
    }
    free(s);
}

/* -------------------------------------------------------- header blocks -- */

/* Every compressed table stream of an Inno installer >= 4.0.9 is one block:
     u32 crc32 of the five bytes that follow
     u32 stored_size  (bytes of the sub-block stream, CRCs included)
     u8  compressed   (0 = stored, else zlib before 4.1.6 and LZMA1 from 4.1.6)
   then sub-blocks of 4 KiB plaintext, each preceded by its own CRC32, the last one short.
   See stream/block.cpp:153-212 for the reference reader and 164-184 for the version split;
   this build targets 5.6.2, where the >= 4.0.9 branch is the only reachable one.

   `in` is the block starting at its CRC, `out` receives the plaintext. Inno only ever uses
   Stored or LZMA1 here, which is why the block path needs no LZMA2 support even though the
   chunk path does (stream/block.cpp:145-149 picks zlib/LZMA1 with the 4.1.6 flag). */
int32_t fh2_block_decode(const uint8_t *in, int32_t inLen, uint8_t *out, int32_t outCap)
{
    uint32_t wantCrc, storedSize;
    uint8_t compressed;
    size_t pos, got, left;
    uint8_t *plain;

    if (in == NULL || out == NULL || inLen < 9 || outCap < 0) {
        return FH2_ERR_ARGS;
    }

    wantCrc = (uint32_t)in[0] | ((uint32_t)in[1] << 8) | ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
    storedSize = (uint32_t)in[4] | ((uint32_t)in[5] << 8) | ((uint32_t)in[6] << 16) | ((uint32_t)in[7] << 24);
    compressed = in[8];

    if (fh2_crc32(in + 4, 5) != wantCrc) {
        return FH2_ERR_CRC;
    }
    if (storedSize > (uint32_t)(inLen - 9)) {
        return FH2_ERR_ARGS; /* truncated: the sub-block stream cannot be complete */
    }

    /* Strip the per-sub-block CRCs first: the decoders want a contiguous stream, and a
       4 KiB CRC-checked unit is exactly what stream/block.cpp:68-137 hands them. */
    plain = (uint8_t *)malloc(storedSize ? storedSize : 1);
    if (plain == NULL) {
        return FH2_ERR_NOMEM;
    }
    pos = 9;
    left = storedSize;
    got = 0;
    while (left > 0) {
        uint32_t subCrc, n;
        if (left < 4) {
            free(plain);
            return FH2_ERR_CRC; /* trailing data: 0 < stored_size % 4100 < 5 */
        }
        subCrc = (uint32_t)in[pos] | ((uint32_t)in[pos + 1] << 8)
               | ((uint32_t)in[pos + 2] << 16) | ((uint32_t)in[pos + 3] << 24);
        pos += 4;
        n = (left - 4 < 4096) ? left - 4 : 4096;
        if (fh2_crc32(in + pos, n) != subCrc) {
            free(plain);
            return FH2_ERR_CRC;
        }
        memcpy(plain + got, in + pos, n);
        got += n;
        pos += n;
        left -= 4 + n;
    }

    if (!compressed) {
        if (got > (size_t)outCap) {
            free(plain);
            return FH2_ERR_FULL;
        }
        memcpy(out, plain, got);
        free(plain);
        return (int32_t)got;
    }
    if (got < 5) {
        free(plain);
        return FH2_ERR_PROPS; /* an LZMA1 block without properties cannot be decoded */
    }
    {
        int32_t handle = fh2_slice_open(FH2_LZMA1, plain, 5);
        size_t total = 0;
        int32_t used = 0;

        if (handle < 0) {
            free(plain);
            return handle;
        }
        /* Drain the block. One pump call can stop because the caller's output window is
           full, and then the rest of the plaintext has to be asked for. fh2_slice_consumed
           counts from the start of the stream, so `used` is read back rather than added to,
           which keeps the input pointer honest across calls. */
        for (;;) {
            int32_t wrote = fh2_slice_pump(handle, plain + 5 + used, (int32_t)(got - 5 - used),
                                           out + total, (int32_t)(outCap - total));
            int32_t now;
            if (wrote < 0) {
                fh2_slice_close(handle);
                free(plain);
                return wrote;
            }
            total += (size_t)wrote;
            now = fh2_slice_consumed(handle);
            if (now < 0) {
                fh2_slice_close(handle);
                free(plain);
                return now;
            }
            used = now;
            if (fh2_slice_finished(handle)) {
                break;
            }
            if (used >= (int32_t)(got - 5)) {
                /* Input exhausted: a raw LZMA1 stream carries no end marker, so filling the
                   window exactly with the last of the input is success, not overflow. The order
                   of the two tests below is what makes a block whose plaintext is exactly outCap
                   bytes long decode instead of being refused. */
                break;
            }
            if (total >= (size_t)outCap) {
                fh2_slice_close(handle);
                free(plain);
                return FH2_ERR_FULL; /* caller must retry with a bigger window */
            }
        }
        fh2_slice_close(handle);
        free(plain);
        return (int32_t)total;
    }
}

/* Recognise a header block without decoding it: the leading u32 must be the CRC32 of the
   five bytes after it. That is a 32-bit check over a structure the caller already believes
   it located, so a false positive needs the wrong offset *and* a colliding CRC. */
int32_t fh2_probe(const uint8_t *in, int32_t inLen)
{
    uint32_t wantCrc;

    if (in == NULL || inLen < 9) {
        return FH2_ERR_ARGS;
    }
    wantCrc = (uint32_t)in[0] | ((uint32_t)in[1] << 8) | ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
    if (fh2_crc32(in + 4, 5) != wantCrc) {
        return FH2_ERR_CRC;
    }
    if (in[8] > 1) {
        return FH2_ERR_PROPS; /* the compressed flag is a single 0/1 byte */
    }
    return FH2_OK;
}

/* -------------------------------------------------------------- memory -- */

void *fh2_alloc(int32_t n)
{
    if (n <= 0) {
        return NULL;
    }
    return malloc((size_t)n);
}

void fh2_free(void *p)
{
    free(p);
}

/* ABI marker for the JavaScript side: bumped whenever the meaning of an id or a return
   code changes, so inno.js can refuse a stale cached .wasm instead of misreading it. */
int32_t fh2_abi_version(void)
{
    return 1;
}
