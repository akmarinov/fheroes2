/* Oracle harness for the browser-side Inno Setup 5.6.2 reader.

 * What is verified, and against what:
 *   - the wasm codec (script/pwa/inno/fh2_inno.c) in isolation, with synthetic streams, so every
 *     supported compression id and every one of its error codes is covered;
 *   - the format parser (files/emscripten/inno.js) against `innoextract --list-sizes -m`, the
 *     reference reader's own entry list, for the DATA/MAPS/MUSIC tiers, on name and size;
 *   - extracted bytes against `innoextract`'s own output files, by SHA-256 -- including the 267 MiB
 *     raw-mode CD image, an LZMA2 file and the animation films inside the image (read in place
 *     through files/emscripten/iso9660.js);
 *   - the failure modes: truncated payload, corrupt offset-table CRC, bogus chunk compression id,
 *     a chunk record whose size overruns the next chunk's magic, a lying plaintext size;
 *   - the ingest contract index.html relies on: tier classification, language resolution, no
 *     temporary entries, Blob output, bounded memory;
 *   - the ingest UI itself, by evaluating index.html's own script against a DOM stub and running a
 *     ZIP archive and the real installer through it, so the picker wiring is tested rather than the
 *     harness's idea of it. Those two imports allocate the size of the game, which is why they run in
 *     child processes (`--ui-probe 0|1`, `--memory-probe <exe>`) that report what they did: node's
 *     peak RSS is a per-process high-water mark and would otherwise be charged to whichever check
 *     happened to run last.
 *
 * Run:
 *   FH2_INNO_EXE=/path/to/setup_heroes_of_might_and_magic_2_gold_1.01_*.exe \
 *     node script/pwa/test/test-inno.mjs
 * With no installer the codec suite still runs and the installer suite reports SKIP (exit 0), so
 * this is safe to wire into a build that has no game file to hand.
 *
 * Optional:
 *   FH2_INNO_ORACLE=<innoextract>   default: `innoextract` on PATH
 *   FH2_INNO_ORACLE_LIST=<file>     default: run the oracle to produce the listing
 *   FH2_INNO_WASM=<inno.wasm>       default: build/pwa/inno.wasm, else script/pwa/inno/inno.wasm
 *   FH2_KEEP_TMP=1                  keep the oracle's extracted files instead of deleting them
 *
 * `innoextract` on macOS links Boost, whose start-up misbehaves when its stdout is redirected to a
 * file, so the oracle is driven through spawnSync's pipes. Its output files are hashed by streaming
 * them, never slurped: one of them is the 267 MiB disc image. Without the oracle binary every
 * oracle-dependent check reports SKIP rather than failing; the codec suite and the parser checks
 * still run. */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, existsSync, statSync, rmSync, mkdirSync, writeFileSync }
  from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
/* script/pwa/test -> the repository root. */
const repoRoot = path.resolve(here, '..', '..', '..');
const EXE = process.env.FH2_INNO_EXE || '';
const WASM = process.env.FH2_INNO_WASM
  || (existsSync(path.join(repoRoot, 'build/pwa/inno.wasm'))
    ? path.join(repoRoot, 'build/pwa/inno.wasm')
    : path.join(repoRoot, 'script/pwa/inno/inno.wasm'));
const TMP = '/tmp/fh2-inno-harness';
const READER = path.join(repoRoot, 'files/emscripten/inno.js');
const ISO = path.join(repoRoot, 'files/emscripten/iso9660.js');

/* ------------------------------------------------------------------ report -- */

const results = [];
function note(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok === true ? 'ok  ' : ok === 'SKIP' ? 'skip' : 'FAIL'}  ${name}`
    + (detail ? `   ${detail}` : ''));
}
/* A check says "wrong" by throwing and says "right, and here is the number that proves it" by
   returning a string. Keeping the two channels apart is what lets the result table carry the
   measurements (sizes, hashes, timings) instead of bare ticks. */
function fail(message) { throw new Error(message); }
function check(name, fn) {
  try {
    note(name, ...settle(fn()));
  } catch (error) {
    note(name, false, firstLine(error));
  }
}
async function checkAsync(name, fn) {
  try {
    note(name, ...settle(await fn()));
  } catch (error) {
    note(name, false, firstLine(error));
  }
}
function settle(result) {
  if (typeof result !== 'string') { return [true, '']; }
  /* Anything starting with SKIP is a skipped check; the rest of the string says why. */
  return result.startsWith('SKIP') ? ['SKIP', result.replace(/^SKIP\s*/, '')] : [true, result];
}
const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0];

/* ------------------------------------------------------------------- utils -- */

const K = 1024;
const MB = 1024 * K;
/* Node normalises ru_maxrss to kilobytes on Darwin and Linux alike. */
const peakMiB = () => process.resourceUsage().maxRSS / K;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const READ_CHUNK = 64 * K;
/* Read a whole Blob through Node's crypto without an intermediate copy of its bytes. */
async function hashBlob(blob) {
  const hash = createHash('sha256');
  hash.update(new Uint8Array(await blob.arrayBuffer()));
  return hash.digest('hex');
}

/* A source that claims the real length but has no bytes past `cut`, which is how a partially
   downloaded file behaves: the parser sees a plausible file and only extraction notices. */
function fullSizeButTruncatedReads(file, cut) {
  return {
    size: file.size,
    slice: (start, end) => (start >= cut
      ? Promise.resolve(new Blob(new Uint8Array(0)))
      : file.slice(start, Math.min(end, cut))),
  };
}

/* The other source shape in this harness: iso9660.js reads through {size, read(offset, length)},
   which is what a caller backed by a file handle offers. Bounded by the same window. */
function readableFile(filePath) {
  const size = statSync(filePath).size;
  return {
    size,
    read(offset, length) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        const stream = createReadStream(filePath, {
          start: offset, end: Math.min(offset + length, size) - 1, highWaterMark: READ_CHUNK,
        });
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
        stream.on('error', reject);
      });
    },
  };
}

/* A File-like source over a real path, offering only the two members the reader asks of a browser
   File (.size and .slice(start, end) -> Blob), with a bounded read window so that no test can pass
   by accident by slurping the installer. */
function fileSource(filePath) {
  const size = statSync(filePath).size;
  return {
    size,
    async slice(start, end) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath, { start, end: Math.min(end, size) - 1 });
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      return new Blob(chunks);
    },
  };
}

let oracleUsable;
function oracle(args, cwd) {
  const bin = process.env.FH2_INNO_ORACLE || 'innoextract';
  if (oracleUsable === false) { return null; }
  const run = spawnSync(bin, args, { cwd, encoding: 'buffer', maxBuffer: 64 * MB });
  if (run.error && run.error.code === 'ENOENT') {
    oracleUsable = false;
    return null;
  }
  if (run.error) { throw run.error; }
  return { status: run.status, stdout: run.stdout.toString('utf8'), stderr: run.stderr.toString('utf8') };
}

/* The oracle's own output, hashed without ever holding it: the disc image it writes is 267 MiB and
   reading it into a Buffer would make this harness, not the reader, the thing that blows the
   memory budget. */
async function oracleHash(absPath) {
  if (oracle(['--version']) === null) { return null; }
  if (!existsSync(absPath)) { throw new Error(`the oracle produced no ${absPath}`); }
  const hash = createHash('sha256');
  const size = statSync(absPath).size;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absPath, { highWaterMark: READ_CHUNK });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { hash: hash.digest('hex'), size };
}

/* ------------------------------------------------ part one: the wasm codec -- */

/* Instantiated straight from the file with no DOM and no emscripten runtime: a module that needed
   either could not get past this line, which is most of the "DOM-free" acceptance criterion. The
   single import emscripten leaves behind (a memory-growth notification) is a no-op, because the
   reader rebuilds its heap view on every use. */
const wasmBytes = readFileSync(WASM);
const wasmModule = new WebAssembly.Module(wasmBytes);

let codec;
async function loadCodec() {
  if (codec) { return codec; }
  /* Given bytes, instantiate() resolves to a [module, instance] pair; given an already-compiled
     module, which is what we hand it, it resolves to the instance alone. */
  const loaded = await WebAssembly.instantiate(wasmModule, {
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const instance = loaded instanceof WebAssembly.Instance ? loaded
    : Array.isArray(loaded) ? loaded[1] : loaded.instance;
  const e = instance.exports;
  codec = {
    exports: e,
    heap: () => new Uint8Array(e.memory.buffer),
    /* Buffers come from the module's own allocator, which is also what the decoders use, so a test
       that leaks a buffer costs wasm heap pages and nothing else. */
    give(bytes) {
      const at = e.fh2_alloc(bytes.length) >>> 0;
      if (!at) { throw new Error('the codec refused to allocate'); }
      codec.heap().set(bytes, at);
      return at;
    },
  };
  return codec;
}

/* The codec's only error channel is its return code; CODEC_ERRORS above maps the same
   numbers to the sentences users see, and a check below keeps the two in step. */
const CODEC_ERRORS = {
  [-1]: 'bad arguments',
  [-2]: 'bad decoder properties',
  [-3]: 'the compressed data is corrupt',
  [-4]: 'the dictionary size is out of range for a browser',
  [-5]: 'out of memory in the extractor',
  [-6]: 'bad extractor handle',
  [-8]: 'CRC mismatch: the installer data is corrupt or this is not an Inno installer',
  [-9]: 'this compression method is not built into the extractor',
  [-10]: 'more plaintext than the output window holds',
};

/* The standard reflected CRC-32 Inno uses (crypto/crc32.hpp's CRC32_NEGL), needed to forge broken
   inputs; the reader has its own copy, which is checked against these values. */
const CRC32 = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    table[n] = c >>> 0;
  }
  return (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) { c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
  };
})();

const u32le = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff,
  (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/* A stored header block: u32 crc32 of the next five bytes, u32 stored_size, u8 compressed flag,
   then sub-blocks of `u32 crc32 + up to 4096 plaintext bytes` (stream/block.cpp:153-212). */
function storedBlock(plaintext, compressed = 0) {
  return blockOf(plaintext, compressed);
}

/* stream/block.cpp:60-72: after the 9-byte header comes `stored_size` bytes laid out as
   [u32 crc32][up to 4096 bytes], repeated. A block that skipped the 4 KiB split would only ever
   decode its own first page, which is exactly the mistake this helper used to make. */
function blockOf(payload, compressed) {
  const parts = [];
  let stored = 0;
  for (let at = 0; at < payload.length || at === 0; at += 4096) {
    const piece = payload.subarray(at, Math.min(at + 4096, payload.length));
    parts.push(u32le(CRC32(piece)), piece);
    stored += 4 + piece.length;
  }
  const flags = new Uint8Array([...u32le(stored), compressed]);
  return join(u32le(CRC32(flags)), flags, ...parts);
}

/* Stands in for Inno's chunk id 1 (deflate with a zlib wrapper) and writes the test archives. */
const zlib = await import('node:zlib');

/* Compressible but not trivially repeating test data. */
function sample() {
  const out = new Uint8Array(300000);
  for (let i = 0; i < out.length; i++) {
    out[i] = i % 997 < 800 ? (i * 13 + (i >> 5)) & 0xff : 0x20;
  }
  return out;
}

/* LZMA test vectors come from the `xz` command line: `--format=lzma` yields the properties Inno
 * stores (1 props byte + u32 little-endian dictionary, stream/lzma.cpp:90-99) in front of a raw
 * LZMA1 stream, and `--format=raw --lzma2=` yields a bare LZMA2 chunk stream, which is what one
 * Inno chunk body holds. A round trip through Node's own zlib-free path proves the vectors are
 * honest before the codec is asked to decode them. */
function xzFile(args, bytes) {
  mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `vector-${args.join('').replace(/[^a-z0-9]/gi, '')}.bin`);
  writeFileSync(file, bytes);
  const run = spawnSync('xz', [...args, file], { maxBuffer: 64 * MB });
  if (run.error && run.error.code === 'ENOENT') { return null; }
  if (run.error) { throw run.error; }
  if (run.status !== 0) { throw new Error(`xz ${args.join(' ')}: ${run.stderr}`); }
  return new Uint8Array(run.stdout);   /* -c sends the compressed bytes to stdout */
}
function lzma1Vector() {
  const plain = sample();
  const container = xzFile(['--format=lzma', '--lzma1=preset=6,dict=1MiB', '-c'], plain);
  if (container === null) { return null; }
  /* The .lzma container is props byte + u32 dict + u64 size, then the raw stream. */
  return { props: container.subarray(0, 5), compressed: container.subarray(13), plain };
}
function lzma2Vector() {
  const plain = sample();
  const compressed = xzFile(['--format=raw', '--lzma2=preset=6,dict=1MiB', '-c'], plain);
  if (compressed === null) { return null; }
  /* LZMA2 repeats the dictionary size inside the stream; the properties byte only sets the
     initial allocation, so a generous code is used here and the in-band reset takes over (Inno's
     own chunks, by contrast, carry no in-band reset, which is why the single byte is enough for
     them -- see the LZMA2 file in the installer suite below). */
  return { props: new Uint8Array([23]), compressed, plain };   /* 23 -> (2|1) << 22 = 12 MiB */
}

async function codecSuite() {
  check('inno.wasm is smaller than 400 KB', () => {
    if (wasmBytes.length >= 400 * K) { fail(`too big: ${wasmBytes.length} bytes`); }
    return `${wasmBytes.length} bytes`;
  });

  check('inno.wasm needs nothing from JavaScript but a memory-growth hook', () => {
    const imports = WebAssembly.Module.imports(wasmModule);
    const strays = imports.filter((i) => !(i.module === 'env'
      && i.name === 'emscripten_notify_memory_growth'));
    if (strays.length) { fail(`JS imports: ${strays.map((i) => `${i.module}.${i.name}`).join(', ')}`); }
    return `${imports.length} import(s), none DOM-related`;
  });

  check('inno.wasm exports the codec ABI', () => {
    const names = WebAssembly.Module.exports(wasmModule)
      .filter((x) => x.kind === 'function').map((x) => x.name);
    const need = ['fh2_abi_version', 'fh2_probe', 'fh2_block_decode', 'fh2_slice_open',
      'fh2_slice_pump', 'fh2_slice_consumed', 'fh2_slice_finished', 'fh2_slice_error',
      'fh2_slice_close', 'fh2_alloc', 'fh2_free'];
    const missing = need.filter((n) => !names.includes(n));
    if (missing.length) { fail(`missing ${missing.join(', ')}`); }
    return `${names.length} functions`;
  });

  const c = await loadCodec();
  const e = c.exports;   /* the module keeps its wasm instance alive for loadCodec() again */
  check('the codec reports its ABI version', () => {
    const abi = e.fh2_abi_version();
    if (abi !== 1) { fail(`fh2_abi_version() = ${abi}`); }
    return 'ABI version 1';
  });

  check('the reader\'s CRC32 agrees with the reference polynomial', () => {
    const reader = readFileSync(READER, 'utf8');
    if (!reader.includes('0xedb88320')) { fail('inno.js no longer uses the reflected CRC-32'); }
    if (CRC32(new TextEncoder().encode('123456789')) !== 0xcbf43926) { fail('wrong CRC-32 check value'); }
    return 'CRC-32("123456789") = 0xcbf43926';
  });

  check('codec: a stored header block decodes', () => {
    const plain = new Uint8Array(12000);
    for (let i = 0; i < plain.length; i++) { plain[i] = (i * 31 + (i >> 9)) & 0xff; }
    const framed = storedBlock(plain);
    const outAt = e.fh2_alloc(plain.length) >>> 0;
    const got = e.fh2_block_decode(c.give(framed), framed.length, outAt, plain.length);
    if (got !== plain.length) { fail(`fh2_block_decode -> ${got} (${CODEC_ERRORS[got] || '?'})`); }
    const out = c.heap().subarray(outAt, outAt + got);
    if (!out.every((v, i) => v === plain[i])) { fail('plaintext mismatch'); }
    return `${got} bytes across 2 sub-blocks`;
  });

  check('codec: a bad block header CRC is refused', () => {
    const framed = storedBlock(new Uint8Array(300).fill(7));
    framed[0] ^= 0xff;
    const got = e.fh2_block_decode(c.give(framed), framed.length, e.fh2_alloc(512) >>> 0, 512);
    if (got !== -8) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `header CRC flip -> ${CODEC_ERRORS[got]}`;
  });

  check('codec: a bad sub-block CRC is refused', () => {
    const framed = storedBlock(new Uint8Array(5000).fill(0x5a));   /* two sub-blocks */
    framed[9 + 4 + 4096 - 1] ^= 0xff;
    const got = e.fh2_block_decode(c.give(framed), framed.length, e.fh2_alloc(8192) >>> 0, 8192);
    if (got !== -8) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `sub-block CRC flip -> ${CODEC_ERRORS[got]}`;
  });

  check('codec: a truncated stored block errors instead of running past the data', () => {
    const framed = storedBlock(new Uint8Array(9000).fill(3));   /* three sub-blocks */
    const cut = framed.subarray(0, framed.length - 17);
    const got = e.fh2_block_decode(c.give(cut), cut.length, e.fh2_alloc(16384) >>> 0, 16384);
    if (got >= 0) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `${got} (${CODEC_ERRORS[got]})`;
  });

  check('codec: an LZMA1 block larger than the output window asks for a bigger one', () => {
    const vector = lzma1Vector();
    if (vector === null) { return 'SKIP (no xz on PATH)'; }
    const { props, compressed, plain } = vector;
    /* compressed = 1 means the sub-block stream holds an LZMA1 stream including its own properties
       header -- the shape of the real setup header (stream/block.cpp:166). */
    const whole = blockOf(join(props, compressed), 1);
    const outAt = e.fh2_alloc(plain.length) >>> 0;
    const got = e.fh2_block_decode(c.give(whole), whole.length, outAt, plain.length);
    if (got !== -10) { fail(`an exact-fit window answered ${got} (${CODEC_ERRORS[got] || '?'})`); }
    /* -10 is a request, not a verdict: the reader grows its window and calls again, which is what
       the whole-block decode below does to get the real plaintext out. */
    const grown = e.fh2_block_decode(c.give(whole), whole.length, e.fh2_alloc(2 * plain.length) >>> 0,
      2 * plain.length);
    if (grown !== plain.length) {
      fail(`a doubled window answered ${grown} (${CODEC_ERRORS[grown] || '?'})`);
    }
    if (!/cap \*= 2/.test(readFileSync(READER, 'utf8'))) {
      fail('inno.js no longer grows its window on FH2_ERR_FULL');
    }
    return `${whole.length} B -> -10 at ${plain.length} B, ${grown} B on the retry`;
  });

  check('codec: a truncated LZMA1 block errors instead of padding', () => {
    const vector = lzma1Vector();
    if (vector === null) { return 'SKIP (no xz on PATH)'; }
    const { props, compressed, plain } = vector;
    const payload = join(props, compressed);
    /* Re-frame the block around a shortened payload, CRCs and all: the sub-block checks are then
       satisfied and the only thing wrong with the data is that the LZMA1 stream stops early. Zeroing
       bytes instead would be caught by the CRC first, which proves nothing about the decoder. */
    const cut = blockOf(payload.subarray(0, payload.length - 40), 1);
    const short = e.fh2_block_decode(c.give(cut), cut.length, e.fh2_alloc(2 * plain.length) >>> 0,
      2 * plain.length);
    if (!(short < 0 || short < plain.length)) {
      fail(`a ${cut.length}-byte block still claimed all ${plain.length} bytes`);
    }
    return `${payload.length - 40} of ${payload.length} LZMA1 bytes -> `
      + `${short} (${CODEC_ERRORS[short] || 'a short count'})`;
  });

  /* -- the four chunk codecs Inno can write, plus stored ----------------- */
  const vectors = [
    { name: 'stored', id: 0, props: new Uint8Array(0), payload: null },
    { name: 'zlib', id: 1, props: new Uint8Array(0), payload: null },
    { name: 'lzma1', id: 3, props: null, payload: null },
    { name: 'lzma2', id: 4, props: null, payload: null },
  ];
  for (const vector of vectors) {
    await checkAsync(`codec: a ${vector.name} chunk pumps back the plaintext`, async () => {
      const plain = sample();
      let made = { props: vector.props, plain };
      if (vector.name === 'stored') { made.compressed = plain; }
      else if (vector.name === 'zlib') {
        made.compressed = new Uint8Array(zlib.deflateSync(Buffer.from(plain), { level: 9 }));
      } else {
        const built = vector.name === 'lzma1' ? lzma1Vector() : lzma2Vector();
        if (built === null) { return 'SKIP (no xz on PATH)'; }
        made = built;
      }
      const h = e.fh2_slice_open(vector.id, made.props.length ? c.give(made.props) : 0,
        made.props.length);
      if (h < 0) { fail(`fh2_slice_open -> ${h} (${CODEC_ERRORS[h] || '?'})`); }
      const payload = made.compressed;
      const inAt = c.give(payload);
      const outCap = 65536;
      const outAt = e.fh2_alloc(outCap) >>> 0;
      /* fh2_slice_pump returns plaintext written and fh2_slice_consumed counts input eaten, so the
         driver has to keep the two tallies apart -- exactly what the reader's own pump() does. */
      const got = [];
      let fed = 0, written = 0, guard = 0;
      for (;;) {
        const wrote = e.fh2_slice_pump(h, inAt + fed, payload.length - fed, outAt, outCap);
        if (wrote < 0) { fail(`fh2_slice_pump -> ${wrote} (${CODEC_ERRORS[wrote] || '?'})`); }
        if (wrote > 0) { got.push(c.heap().slice(outAt, outAt + wrote)); }
        written += wrote;
        const now = e.fh2_slice_consumed(h);
        if (now < 0) { fail(`fh2_slice_consumed -> ${now}`); }
        const stuck = e.fh2_slice_error(h);
        if (stuck < 0) { fail(`sticky error ${stuck} (${CODEC_ERRORS[stuck] || '?'})`); }
        const moved = now > fed || wrote > 0;
        fed = now;
        if (fed >= payload.length || e.fh2_slice_finished(h)) { break; }
        if (!moved && ++guard > 8) { fail('the pump stopped making progress'); }
      }
      const finished = e.fh2_slice_finished(h);
      e.fh2_slice_close(h);
      if (written !== plain.length) {
        fail(`decoded ${written} bytes from ${payload.length} (input eaten ${fed},`
          + ` finished=${finished})`);
      }
      const out = new Uint8Array(written);
      let at = 0;
      for (const part of got) { out.set(part, at); at += part.length; }
      if (!out.every((v, i) => v === plain[i])) { fail('plaintext mismatch'); }
      return `${payload.length} -> ${written} bytes`
        + (finished ? ', end marker seen' : ' (raw stream, no end marker)');
    });
  }

  /* -- every rejection path --------------------------------------------- */
  check('codec: an unknown compression id is refused', () => {
    const got = e.fh2_slice_open(99, 0, 0);
    if (got !== -2) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `id 99 -> ${CODEC_ERRORS[got]}`;
  });
  check('codec: bzip2 is refused rather than silently mis-decoded', () => {
    const got = e.fh2_slice_open(2, 0, 0);
    if (got !== -9) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `id 2 -> ${CODEC_ERRORS[got]}`;
  });
  check('codec: nonsense LZMA1 properties are refused', () => {
    const got = e.fh2_slice_open(3, c.give(new Uint8Array([0xff, 0, 0, 0, 0])), 5);
    if (got !== -2) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `props 0xff -> ${CODEC_ERRORS[got]}`;
  });
  check('codec: the LZMA2 "dictionary unknown" code is refused', () => {
    const got = e.fh2_slice_open(4, c.give(new Uint8Array([40])), 1);
    if (got !== -4) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `props 40 -> ${CODEC_ERRORS[got]}`;
  });
  check('codec: a dictionary above the browser cap is refused, not attempted', () => {
    /* Code 31 -> (2|1) << 26 = 192 MiB, over the 64 MiB cap that protects an iOS tab from a
       hostile installer (the reference does no such check, stream/lzma.cpp:100-104). */
    const got = e.fh2_slice_open(4, c.give(new Uint8Array([31])), 1);
    if (got !== -4) { fail(`got ${got} (${CODEC_ERRORS[got] || '?'})`); }
    return `props 31 (192 MiB) -> ${CODEC_ERRORS[got]}`;
  });
  check('codec: a corrupt LZMA2 payload errors instead of spinning', () => {
    const made = lzma2Vector();
    if (made === null) { return 'SKIP (no xz on PATH)'; }
    const bad = new Uint8Array(made.compressed);
    for (let i = 2; i < bad.length; i++) { bad[i] = (bad[i] * 31 + 7) & 0xff; }
    const h = e.fh2_slice_open(4, c.give(made.props), made.props.length);
    if (h < 0) { fail(`open -> ${h}`); }
    const inAt = c.give(bad);
    const outAt = e.fh2_alloc(MB) >>> 0;
    let consumed = 0, produced = 0, guard = 0, result = 0;
    for (;;) {
      const used = e.fh2_slice_pump(h, inAt + consumed, bad.length - consumed, outAt + produced,
        65536);
      if (used < 0) { result = used; break; }
      consumed += used;
      if (used === 0 || consumed >= bad.length || ++guard > 400) { break; }
    }
    const sticky = e.fh2_slice_error(h);
    e.fh2_slice_close(h);
    if (!(result === -3 || sticky === -3)) {
      fail(`no corruption reported (pump ${result}, sticky ${sticky}, ${consumed} bytes eaten)`);
    }
    return `pump ${result} after ${consumed}/${bad.length} bytes, sticky ${sticky}, ${guard} turns`;
  });
  check('codec: a bad handle is reported rather than crashing the module', () => {
    const pump = e.fh2_slice_pump(999, 0, 0, 0, 1024);
    const consumed = e.fh2_slice_consumed(999);
    e.fh2_slice_close(999);                        /* must be survivable too */
    if (!(pump === -6 && consumed === -6)) { fail(`pump ${pump}, consumed ${consumed}`); }
    return `handle 999 -> ${pump} from pump and consumed alike`;
  });
  check('codec: slice slots are bounded and the exhaustion is named', () => {
    const handles = [];
    for (let i = 0; i < 4; i++) { handles.push(e.fh2_slice_open(0, 0, 0)); }
    const extra = e.fh2_slice_open(0, 0, 0);
    for (const h of handles) { e.fh2_slice_close(h); }
    if (extra !== -5) { fail(`5th open -> ${extra} (${CODEC_ERRORS[extra] || '?'})`); }
    return '4 slots, the 5th open -> FH2_ERR_NOMEM';
  });
  check('codec: fh2_probe recognises a header block and rejects everything else', () => {
    const good = storedBlock(new Uint8Array(64));
    const badCrc = new Uint8Array(good);
    badCrc[0] ^= 0x80;
    const badFlag = new Uint8Array(good);
    badFlag[8] = 4;                                /* the compressed flag is 0 or 1, nothing else */
    badFlag.set(u32le(CRC32(badFlag.subarray(4, 9))), 0);   /* so the CRC is not what trips first */
    const probe = (bytes) => e.fh2_probe(c.give(bytes), bytes.length);
    const cases = [['valid block', probe(good), 0], ['bad CRC', probe(badCrc), -8],
      ['bad flag', probe(badFlag), -2], ['short input', probe(new Uint8Array(4)), -1]];
    for (const [what, got, want] of cases) {
      if (got !== want) { fail(`${what} -> ${got}, wanted ${want}`); }
    }
    return cases.map(([what, got]) => `${what}=${got}`).join(', ');
  });
  check('codec: the reader\'s error table covers every code the codec can return', () => {
    const source = readFileSync(path.join(repoRoot, 'script/pwa/inno/fh2_inno.c'), 'utf8');
    const codes = [...source.matchAll(/#define\s+FH2_ERR_[A-Z]+\s+(-\d+)/g)]
      .map((m) => Number(m[1]));
    const unmapped = codes.filter((code) => CODEC_ERRORS[code] === undefined);
    if (unmapped.length) { fail(`no message for ${unmapped.join(', ')}`); }
    const reader = readFileSync(READER, 'utf8');
    const missing = codes.filter((code) => !reader.includes(`[${code}]:`));
    if (missing.length) { fail(`inno.js has no message for ${missing.join(', ')}`); }
    return `${codes.length} codes mapped in both`;
  });
}

/* ------------------------------------------------ part two: the real installer -- */

/* Files the oracle extracts once, and which pin both the extraction and the codec choice: the two
   .AGG archives, one map and one track cover the zlib path the GOG Galaxy payload uses, the .ico is
   LZMA2, and the disc image covers the 26-chunk solid case. `oracle` is the path under the oracle's
   output directory, where {app} becomes app/ and everything else keeps its install path. */
const SAMPLES = [
  { name: 'DATA/HEROES2.AGG', find: 'DATA/HEROES2.AGG', oracle: 'DATA/HEROES2.AGG' },
  { name: 'DATA/HEROES2X.AGG', find: 'DATA/HEROES2X.AGG', oracle: 'DATA/HEROES2X.AGG' },
  { name: 'MAPS/MINERALW.MP2', find: 'MAPS/MINERALW.MP2', oracle: 'MAPS/MINERALW.MP2' },
  { name: 'MUSIC/homm2_35.ogg', find: 'MUSIC/homm2_35.ogg', oracle: 'MUSIC/homm2_35.ogg' },
  { name: 'app/goggame-1207658785.ico (lzma2)', find: /^\{app\}\/goggame-1207658785\.ico$/i,
    oracle: 'app/goggame-1207658785.ico' },
  { name: 'homm2.gog', find: 'homm2.gog', oracle: 'homm2.gog' },
];
const TIER = /^(data|maps|music)\//;
/* Pinned from `innoextract --include DATA/HEROES2.AGG` so that a change which silently altered the
   bytes the UI stores cannot pass unnoticed. */
/* Filled in by the videos check below, which reads CHOOSE.SMK out of the disc image. */
let DISC_CHOOSE_SHA = null;

const ORACLE_AGG_SHA = '7a11c86db8ec8fbf19d810c1f7ebf9d8520f63fbdc42d6f51f7538654004315d';

async function installerSuite() {
  const reader = await import(pathToFileURL(READER).href);
  const { InnoInstaller, codecSupport } = reader;
  const source = fileSource(EXE);

  let installer = null;
  await checkAsync('parse: header, offset table and every table', async () => {
    const started = Date.now();
    installer = await InnoInstaller.open(source, { wasmUrl: pathToFileURL(WASM).href });
    return `${installer.version}; ${installer.entryCount} entries from `
      + `${installer.setup.fileCount} file records and ${installer.setup.dataEntryCount} chunks `
      + `in ${Date.now() - started} ms`;
  });
  if (!installer) { return; }

  check('parse: the version record is the trailer magic', () =>
    () => {
    if (installer.version !== 'Inno Setup Setup Data (5.6.2) (u)') { fail(installer.version); }
    return installer.version;
  });

  check('parse: the language table is read', () => {
    const names = installer.languages.map((l) => l.name);
    const missing = ['english', 'german', 'french'].filter((n) => !names.includes(n));
    if (missing.length) { fail(`missing ${missing.join(', ')} of ${names.join(',')}`); }
    if (!installer.languages.every((l) => Number.isInteger(l.languageId))) {
      fail('a language record has no numeric LCID');
    }
    return `${names.length} languages (${names.slice(0, 4).join(', ')}…), all LCIDs numeric`;
  });

  check('parse: the setup header names the game and its payload codec', () => {
    if (!/Heroes of Might and Magic/.test(installer.appName) || installer.setup.compression !== 4) {
      fail(`${installer.appName} / compression ${installer.setup.compression}`);
    }
    return `${installer.appName}; header compression = lzma2`;
  });

  check('parse: the chunk table agrees with the file layout', () => {
    const last = installer.dataEntries.reduce((a, b) => (b.offset > a.offset ? b : a));
    const end = installer.payloadOffset + last.offset + last.chunkSize;
    if (!(end <= source.size && installer.payloadOffset < installer.headerOffset
        && installer.headerOffset < source.size)) {
      fail(`payload would end at ${end}, the file holds ${source.size}`);
    }
    return `payload ${installer.payloadOffset}..${end} of ${source.size}, header at `
      + `${installer.headerOffset}, offset table at ${installer.offsetTableOffset}`;
  });

  /* -- the entry list against `innoextract --list-sizes -m` -------------- */
  let oracleRows = null;
  const listFile = process.env.FH2_INNO_ORACLE_LIST;
  let listText = null;
  if (listFile && existsSync(listFile)) {
    listText = readFileSync(listFile, 'utf8');
  } else {
    const run = oracle(['--list-sizes', '-m', EXE]);
    if (run !== null && run.status === 0) { listText = run.stdout; }
  }
  if (listText === null) {
    note('oracle: --list-sizes -m available', 'SKIP', 'innoextract not usable here');
  } else {
    oracleRows = parseListSizes(listText);
    const tiers = [...oracleRows.keys()].filter((n) => TIER.test(n)).length;
    note('oracle: --list-sizes -m available', true,
      `${oracleRows.size} names, ${tiers} in DATA/MAPS/MUSIC (${listFile ? 'cached file' : 'generated'})`);
  }

  const mine = new Map();
  for (const entry of installer.entries) {
    mine.set(entry.path.replace(/\\/g, '/').toLowerCase(), entry);
  }

  check('oracle: every DATA/MAPS/MUSIC name the oracle lists is ours, with a matching size', () => {
    if (oracleRows === null) { return 'SKIP'; }
    const problems = [];
    let compared = 0;
    for (const [name, printed] of oracleRows) {
      if (!TIER.test(name)) { continue; }
      const entry = mine.get(name);
      if (!entry) { problems.push(`missing ${name}`); continue; }
      compared++;
      /* Recompute the oracle's own rendering from the size we parsed. Equal strings means equal
         bytes -- a differing byte count renders differently unless it differs by less than the
         last printed digit, which the SHA-256 checks below rule out anyway. */
      const ours = printBytes(entry.size);
      if (ours !== printed) { problems.push(`${name}: ours ${entry.size} -> "${ours}", oracle "${printed}"`); }
    }
    if (problems.length) { fail(problems.slice(0, 5).join('; ')); }
    return `${compared} names matched on name and size interval`;
  });

  check('oracle: we claim no DATA/MAPS/MUSIC file the oracle does not', () => {
    if (oracleRows === null) { return 'SKIP'; }
    const extra = [...mine.keys()].filter((n) => TIER.test(n) && !oracleRows.has(n));
    if (extra.length) { fail(`${extra.length} extra: ${extra.slice(0, 5).join(', ')}`); }
    return 'no DATA/MAPS/MUSIC file claimed that the oracle does not list';
  });

  check('entries: no temporary entry is offered', () => {
    const temp = installer.entries.filter((entry) => /^\{tmp\}/i.test(entry.path));
    if (temp.length) { fail(`${temp.length} {tmp} entries still listed`); }
    const offered = installer.entries.filter((entry) => installer.isRelevant(entry));
    const stray = offered.filter((entry) => !TIER.test(entry.path.replace(/\\/g, '/').toLowerCase())
      && entry.path.toLowerCase() !== 'homm2.gog');
    if (stray.length) {
      fail(`${stray.length} irrelevant offered: ${stray.slice(0, 3).map((e) => e.path).join(', ')}`);
    }
    return `${offered.length} of ${installer.entryCount} entries offered, none under {tmp}`;
  });

  await checkAsync('entries: language tags resolve the way a Windows install would', async () => {
    /* DATA/STANDARD.HS is tagged [en-US] by the installer (the oracle prints the tag), while
       DATA/CAMPAIGN.HS carries no tag at all. Selecting another language must drop the tagged
       file and keep the untagged one -- that is the whole of Inno's per-language selection. */
    const tagged = installer.findEntry('DATA/STANDARD.HS');
    const untagged = installer.findEntry('DATA/CAMPAIGN.HS');
    if (tagged < 0 || untagged < 0) {
      fail(`missing a control entry (tagged=${tagged}, untagged=${untagged})`);
    }
    const german = await InnoInstaller.open(source, {
      wasmUrl: pathToFileURL(WASM).href, language: 'de-DE',
    });
    try {
      const lost = german.findEntry('DATA/STANDARD.HS');
      const kept = german.findEntry('DATA/CAMPAIGN.HS');
      if (lost >= 0 || kept < 0) {
        fail(`de-DE kept the tagged file (${lost >= 0}) or dropped the untagged one (${kept < 0})`);
      }
      return `en-US picks both; de-DE drops ${installer.entries[tagged].path} `
        + `(${german.entryCount} vs ${installer.entryCount} entries)`;
    } finally {
      german.dispose();
    }
  });

  check('entries: chunk records cover each entry exactly, in offset order', () => {
    const referenced = new Set();
    let shared = 0;
    for (const entry of installer.entries) {
      let sum = 0;
      let previous = -1;
      for (const index of entry.locations) {
        if (index >= installer.dataEntries.length) {
          fail(`${entry.path}: chunk ${index} is past the end of the chunk table`);
        }
        if (index <= previous) {
          fail(`${entry.path}: locations are not in ascending order`);
        }
        previous = index;
        if (referenced.has(index)) { shared++; }
        referenced.add(index);
        sum += installer.dataEntries[index].plainSize;
      }
      if (sum !== entry.size) {
        fail(`${entry.path}: chunks hold ${sum} bytes, the entry says ${entry.size}`);
      }
    }
    /* Nine payloads are referenced twice on purpose: Inno lists the same bytes under two names
       (MUSIC/homm2_09.ogg and MUSIC/pol/homm2_09.ogg), which the oracle prints on one row. */
    return `${referenced.size} of ${installer.dataEntries.length} chunks referenced, `
      + `${shared} shared between two names`;
  });

  /* -- extraction against the oracle's own files ------------------------- */
  rmSync(TMP, { recursive: true, force: true });
  const haveOracle = oracle(['--version']) !== null;
  await checkAsync('oracle: extract the reference files with innoextract', async () => {
    if (!haveOracle) { return 'SKIP'; }
    const args = ['-q', '-m', '-d', TMP];
    for (const sample of SAMPLES) { args.push('--include', sample.oracle); }
    args.push(EXE);
    const run = oracle(args);
    if (run.status !== 0) { fail(`innoextract: ${run.stderr.trim().split('\n').slice(-1)}`); }
    const missing = SAMPLES.filter((sample) => !existsSync(path.join(TMP, sample.oracle)));
    if (missing.length) { fail(`no output for ${missing.map((s) => s.name).join(', ')}`); }
    return `${SAMPLES.length} reference files, ${peakMiB().toFixed(1)} MiB peak so far`;
  });

  for (const sample of SAMPLES) {
    await checkAsync(`extract: ${sample.name} is byte-identical to innoextract's copy`, async () => {
      const reference = await oracleHash(path.join(TMP, sample.oracle));
      if (reference === null) { return 'SKIP'; }
      const index = installer.findEntry(sample.find);
      if (index < 0) { fail(`our table has no "${sample.find}"`); }
      const hash = createHash('sha256');
      const peakBefore = peakMiB();
      const result = await installer.extract(index, (view) => hash.update(view),
        { keepBytes: false });
      const ours = hash.digest('hex');
      if (ours !== reference.hash || result.bytes !== reference.size) {
        fail(`${result.bytes} bytes sha ${ours.slice(0, 16)}… != `
          + `${reference.size} ${reference.hash.slice(0, 16)}…`);
      }
      return `${result.bytes} B, ${installer.entries[index].locations.length} chunk(s), `
        + `sha ${ours.slice(0, 16)}…, peak +${(peakMiB() - peakBefore).toFixed(1)} MiB`;
    });
  }

  await checkAsync('extract: keepBytes hands the UI a Blob of the same content', async () => {
    const reference = await oracleHash(path.join(TMP, 'MAPS/MINERALW.MP2'));
    if (reference === null) { return 'SKIP'; }
    const { blob } = await installer.extract(installer.findEntry('MAPS/MINERALW.MP2'), null,
      { keepBytes: true });
    if (!(blob instanceof Blob)) { fail('no Blob returned'); }
    if (blob.size !== reference.size) { fail(`blob ${blob.size} != ${reference.size}`); }
    const hash = createHash('sha256');
    hash.update(new Uint8Array(await blob.arrayBuffer()));
    if (hash.digest('hex') !== reference.hash) { fail('Blob content differs'); }
    return `${blob.size} bytes behind one Blob handle`;
  });

  /* -- memory profile: the 267 MiB CD image ----------------------------- */
  /* Peak RSS is a high-water mark for the whole process, so measuring it here would charge this
     harness for the checks above as well: they have already decoded dozens of files and V8 keeps the
     pages they took. The measurement therefore runs in a fresh node process that does only the two
     things being measured -- open the installer, then stream the CD image through the codec while
     retaining nothing -- and reports its own peak. `--memory-probe` below is that process. */
  await checkAsync('memory: extracting homm2.gog (267 MiB) stays below 300 MB peak RSS', async () => {
    const probe = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [process.argv[1], '--memory-probe', EXE], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });
    const last = probe.out.trim().split('\n').pop() || '';
    const match = /^(\d+) (\d+) (\d+)$/.exec(last);
    if (probe.code !== 0 || !match) {
      fail(`probe exited ${probe.code}: ${firstLine(probe.err || last)}`);
    }
    const peak = Number(match[1]) / 1024;
    const bytes = Number(match[2]);
    const milliseconds = Number(match[3]);
    if (bytes !== 280706496) { fail(`the probe produced ${bytes} of plaintext`); }
    if (peak >= 300) { fail(`peak ${peak.toFixed(1)} MiB`); }
    return `peak ${peak.toFixed(1)} MiB in a clean process; ${bytes} bytes of plaintext in `
      + `${(milliseconds / 1000).toFixed(1)} s`;
  });

  check('memory: the pump owns two windows, not a file', () => {
    /* READ_WINDOW of compressed input plus OUT_WINDOW of plaintext are the only buffers the codec
       wrapper holds (files/emscripten/inno.js): if either grew past a few megabytes, the reader
       would be accumulating bytes somewhere. */
    const text = readFileSync(READER, 'utf8');
    const windowOf = (name) => {
      const m = new RegExp(`const ${name} = ([^;]+);`).exec(text);
      if (!m) { throw new Error(`${name} not found in inno.js`); }
      return Number(Function(`"use strict"; return (${m[1]});`)());
    };
    const read = windowOf('READ_WINDOW');
    const out = windowOf('OUT_WINDOW');
    if (!(read > 0 && read <= 8 * MB && out > 0 && out <= 8 * MB)) {
      fail(`READ_WINDOW ${read}, OUT_WINDOW ${out}`);
    }
    return `READ_WINDOW ${read / K} KiB + OUT_WINDOW ${out / K} KiB `
      + `= ${(read + out) / K} KiB total`;
  });

  /* -- the videos tier: the ANIM films inside the CD image --------------- */
  await checkAsync('videos: the CD image is readable in place, one film at a time', async () => {
    if (!existsSync(ISO)) { return 'SKIP (no files/emscripten/iso9660.js)'; }
    const { Iso9660 } = await import(pathToFileURL(ISO).href);
    const index = installer.findEntry('homm2.gog');
    const range = installer.createRangeSource(index);
    if (range.size !== installer.entries[index].size) { return 'range source size mismatch'; }
    const iso = await Iso9660.open(range);
    const films = iso.list('heroes2/anim').filter((entry) => /\.smk$/i.test(entry.path));
    if (films.length !== 178) { fail(`${films.length} ANIM films, expected 178`); }
    const film = films.find((entry) => /CHOOSE\.SMK$/i.test(entry.path));
    const bytes = new Uint8Array(await (await iso.read(film)).arrayBuffer());
    /* Smacker header: four signature bytes 'SMK2' or 'SMK4', then width and height as u32 little
       endian. HoMM2's films are 640x480 'SMK2' files; reading the two dimensions back out proves
       the bytes came from the right sector rather than merely looking like text. */
    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(4, true);
    const height = view.getUint32(8, true);
    if (!(sig === 'SMK2' || sig === 'SMK4') || width === 0 || width > 4096 || height === 0
        || height > 4096) {
      fail(`${film.path} is not a Smacker film (signature ${JSON.stringify(sig)}, `
        + `${width}x${height})`);
    }
    /* Second film, far into the image, to prove the chunk cache advances rather than sticks. */
    const late = films.reduce((a, b) => (b.lba > a.lba ? b : a), films[0]);  /* furthest into the image */
    const lateBytes = new Uint8Array(await (await iso.read(late)).arrayBuffer());
    if (lateBytes.length !== late.size) {
      fail(`${late.path}: read ${lateBytes.length} of ${late.size}`);
    }
    /* Remembered for the UI suite: it compares the film the page stores against the same film read
       through this ISO path, without having to open the installer a second time to find out. */
    DISC_CHOOSE_SHA = sha256(bytes);
    return `${films.length} films; ${film.path} ${bytes.length} B ${sig} ${width}x${height}, `
      + `${late.path} ${lateBytes.length} B; peak ${peakMiB().toFixed(1)} MiB`;
  });

  await checkAsync('videos: every film the image holds hashes to what the image holds', async () => {
    /* Cross-check the seekable path against the sequential one: the oracle's extracted image is a
       plain file (its SHA-256 was matched above), so the same film read out of it by a second
       reader must hash identically. */
    if (!existsSync(path.join(TMP, 'homm2.gog')) || !existsSync(ISO)) { return 'SKIP'; }
    const { Iso9660 } = await import(pathToFileURL(ISO).href);
    /* The oracle's extracted image read through a windowed file handle, so the comparison costs a
       read window rather than 267 MiB. iso9660.js takes {size, read(offset, length)}, which is a
       different shape from the File-like one InnoInstaller.open() wants. */
    const onDisk = await Iso9660.open(readableFile(path.join(TMP, 'homm2.gog')));
    const index = installer.findEntry('homm2.gog');
    const inInstaller = await Iso9660.open(installer.createRangeSource(index));
    /* Modest films only: what is under test is that the in-installer view and the extracted-file
       view agree, and a 21 MB intro would make this check the biggest memory user in the harness. */
    const wanted = ['heroes2/anim/choose.smk', 'heroes2/anim/credits.smk'];
    const lines = [];
    for (const name of wanted) {
      const a = onDisk.list('heroes2/anim').find((e) => e.path.toLowerCase() === name);
      const b = inInstaller.list('heroes2/anim').find((e) => e.path.toLowerCase() === name);
      if (!a || !b) { fail(`${name} missing from one of the two views`); }
      const ha = await hashBlob(await onDisk.read(a));
      const hb = await hashBlob(await inInstaller.read(b));
      if (ha !== hb) {
        fail(`${name}: ${ha.slice(0, 12)} on disk != ${hb.slice(0, 12)} in installer`);
      }
      lines.push(`${name.split('/').pop()} ${b.size} B ${ha.slice(0, 12)}…`);
    }
    return lines.join('; ');
  });

  /* -- the failure modes, on the real installer ------------------------- */
  await checkAsync('negative: a file cut short before its header is refused at parse time',
    async () => {
      const cut = 300 * MB;   /* the header lives at 488398789, so it is simply not there */
      const short = { size: cut, slice: (start, end) => source.slice(start, Math.min(end, cut)) };
      const started = Date.now();
      let message = '';
      try {
        const partial = await InnoInstaller.open(short, { wasmUrl: pathToFileURL(WASM).href });
        partial.dispose();
        message = 'no error at all';
      } catch (error) { message = firstLine(error); }
      const elapsed = Date.now() - started;
      if (!(/points outside this file|ends inside|loader table/i.test(message) && elapsed < 30000)) {
        fail(`unexpected: "${message}" after ${elapsed} ms`);
      }
      return `"${message}" in ${elapsed} ms`;
    });

  await checkAsync('negative: a payload whose bytes are simply missing is named during extraction',
    async () => {
      /* The tables are intact and every chunk record points somewhere plausible; the bytes behind
         the later chunks are gone. The reader must say so rather than return short data. */
      const cut = 300 * MB;
      const started = Date.now();
      let message = '';
      let partial = null;
      try {
        partial = await InnoInstaller.open(fullSizeButTruncatedReads(source, cut),
          { wasmUrl: pathToFileURL(WASM).href });
        await partial.extract(partial.findEntry('MUSIC/sw/homm2_06.ogg'), null,
          { keepBytes: false });
        message = 'no error at all';
      } catch (error) { message = firstLine(error); } finally {
        if (partial) { partial.dispose(); }
      }
      const elapsed = Date.now() - started;
      if (!/too early|ends inside|outside/i.test(message) || elapsed > 60000) {
        fail(`unexpected: "${message}" after ${elapsed} ms`);
      }
      return `"${message}" in ${elapsed} ms`;
    });

  await checkAsync('negative: a payload that ends early is named during extraction', async () => {
    /* Same file, but still claiming its full length: the offsets all parse, and the damage only
       shows when the reader asks for a chunk that is no longer there. homm2.gog is the entry whose
       chunks reach furthest into the installer. */
    const cut = 300 * MB;
    const short = {
      size: source.size,
      slice: (start, end) => (start >= cut
        ? Promise.resolve(new Blob(new Uint8Array(0)))
        : source.slice(start, Math.min(end, cut))),
    };
    const started = Date.now();
    let message = '';
    let partial = null;
    try {
      /* The header itself is at the very end of the file, so a truncated installer cannot be parsed
         at all -- which the check above covers. To reach the chunk reader, lie about the size while
         refusing reads past the cut: the tables then come from a source that pretends to be whole. */
      partial = await InnoInstaller.open(fullSizeButTruncatedReads(source, cut),
        { wasmUrl: pathToFileURL(WASM).href });
      await partial.extract(partial.findEntry('homm2.gog'), null, { keepBytes: false });
      message = 'no error at all';
    } catch (error) { message = firstLine(error); } finally {
      if (partial) { partial.dispose(); }
    }
    const elapsed = Date.now() - started;
    if (!/too early|ends inside|outside/i.test(message) || elapsed > 60000) {
      fail(`unexpected: "${message}" after ${elapsed} ms`);
    }
    return `"${message}" in ${elapsed} ms`;
  });

  await checkAsync('negative: a corrupt offset-table CRC aborts the parse', async () => {
    /* Byte 12 of the table is exe_offset, inside the 40 bytes its trailing CRC covers. Flip a bit
       there and the reader must refuse the whole table instead of trusting the offsets. */
    const at = installer.offsetTableOffset;
    const tampered = {
      size: source.size,
      async slice(start, end) {
        const bytes = new Uint8Array(await (await source.slice(start, end)).arrayBuffer());
        if (start <= at + 12 && at + 12 < end) { bytes[at + 12 - start] ^= 0x40; }
        return new Blob([bytes]);
      },
    };
    try {
      const bad = await InnoInstaller.open(tampered, { wasmUrl: pathToFileURL(WASM).href });
      bad.dispose();
      fail('a corrupt offset table was accepted');
    } catch (error) {
      if (!/CRC|corrupt/i.test(firstLine(error))) { fail(`wrong failure: ${firstLine(error)}`); }
      return `"${firstLine(error)}"`;
    }
  });

  await checkAsync('negative: a chunk record whose size overruns the next magic is refused', async () => {
    /* The shape a corrupt chunk table would have: every CRC intact, only the length lying. */
    const index = installer.findEntry('DATA/HEROES2.AGG');
    const first = installer.entries[index].locations[0];
    const saved = installer.dataEntries[first].chunkSize;
    installer.dataEntries[first].chunkSize = 0x40000000;
    let message = '';
    try {
      await installer.extract(index, null, { keepBytes: false });
      message = 'no error at all';
    } catch (error) { message = firstLine(error); } finally {
      installer.dataEntries[first].chunkSize = saved;
    }
    if (!/chunk claims|next chunk starts/i.test(message)) { fail(`wrong failure: "${message}"`); }
    return `"${message}"`;
  });

  await checkAsync('negative: a compression id the codec does not know is refused', async () => {
    const index = installer.findEntry('DATA/HEROES2.AGG');
    const first = installer.entries[index].locations[0];
    const saved = installer.dataEntries[first].compression;
    installer.dataEntries[first].compression = 77;
    let message = '';
    try {
      await installer.extract(index, null, { keepBytes: false });
      message = 'no error at all';
    } catch (error) { message = firstLine(error); } finally {
      installer.dataEntries[first].compression = saved;
    }
    if (!/not implemented by the extractor/.test(message)) {
      fail(`wrong failure: "${message}"`);
    }
    const verdicts = [];
    for (const id of [0, 1, 2, 3, 4, 77]) {
      const verdict = await codecSupport(id, { wasmUrl: pathToFileURL(WASM).href });
      verdicts.push(`${id}=${verdict.ok ? 'ok' : verdict.message.split(':')[0]}`);
    }
    return `"${message}" | codecSupport ${verdicts.join(' ')}`;
  });

  await checkAsync('negative: a lying plaintext size is caught, not padded', async () => {
    const index = installer.findEntry('MUSIC/homm2_35.ogg');
    const only = installer.entries[index].locations[0];
    const saved = installer.dataEntries[only].plainSize;
    installer.dataEntries[only].plainSize = saved - 1000;
    let message = '';
    try {
      await installer.extract(index, null, { keepBytes: false });
      message = 'no error at all';
    } catch (error) { message = firstLine(error); } finally {
      installer.dataEntries[only].plainSize = saved;
    }
    if (!/decoded .*declares/.test(message)) { fail(`wrong failure: "${message}"`); }
    return `"${message}"`;
  });

  /* -- the ingest contract index.html relies on ------------------------- */
  check('ui: the three mandatory tiers are all populated', () => {
    const counts = { data: 0, maps: 0, music: 0, cd: 0 };
    for (const entry of installer.entries) {
      const tier = installer.tierOf(entry);
      if (tier) { counts[tier]++; }
    }
    if (!(counts.data === 11 && counts.maps === 144 && counts.music === 54 && counts.cd === 1)) {
      fail(`unexpected tier counts ${JSON.stringify(counts)}`);
    }
    return JSON.stringify(counts);
  });

  check('ui: install paths fold into the keys the engine looks for', () => {
    const entry = installer.entries.find((e) => /^DATA\\HEROES2\.AGG$/i.test(e.path));
    if (!entry) { fail('no DATA entry to fold'); }
    const key = `data/${entry.path.replace(/\\/g, '/').split('/').slice(1).join('/')}`.toLowerCase();
    if (key !== 'data/heroes2.agg') { fail(`${entry.path} -> ${key}`); }
    return `${entry.path} -> ${key}`;
  });

  check('ui: the videos tier offers the disc image and nothing else', () => {
    const cd = installer.entries.filter((entry) => installer.tierOf(entry) === 'cd');
    if (!(cd.length === 1 && /^homm2\.gog$/i.test(cd[0].path) && !cd[0].incomplete)) {
      fail(`cd tier holds ${cd.map((entry) => entry.path).join(', ') || 'nothing'}`);
    }
    return `${cd[0].path}: ${cd[0].size} bytes in ${cd[0].locations.length} chunks`;
  });

  check('ui: an incomplete Galaxy file is never offered', () => {
    const broken = installer.entries.filter((entry) => entry.incomplete);
    if (!broken.every((entry) => !installer.isRelevant(entry))) {
      fail('an incomplete entry is offered');
    }
    return `${broken.length} incomplete entries, none offered`;
  });

  await checkAsync('ui: every offered entry decodes with a codec the loaded wasm supports', async () => {
    /* One open() per distinct compression id actually used by the offered files, which is what the
       UI can warn about before starting a long extraction. */
    const ids = new Set(installer.entries.filter((entry) => installer.isRelevant(entry))
      .map((entry) => (entry.comp === -1 ? 'mixed' : entry.comp)));
    const verdicts = [];
    for (const id of ids) {
      if (id === 'mixed') { verdicts.push('mixed'); continue; }
      const verdict = await codecSupport(id, { wasmUrl: pathToFileURL(WASM).href });
      if (!verdict.ok) { fail(`id ${id} cannot be decoded: ${verdict.message}`); }
      verdicts.push(`${id}=ok`);
    }
    return verdicts.join(' ');
  });

  installer.dispose();
  await checkAsync('lifecycle: a disposed installer refuses to extract', async () => {
    try {
      await installer.extract(0, null, { keepBytes: false });
      fail('extraction after dispose() succeeded');
    } catch (error) {
      if (!/disposed/.test(firstLine(error))) { fail(`wrong failure: ${firstLine(error)}`); }
      return `"${firstLine(error)}"`;
    }
  });
}

/* `innoextract --list-sizes -m` prints one row per payload, rows naming several files that share
   one payload:
     ` - "DATA/HEROES2.AGG" [en-US] (41.4 MiB)`
     ` - "MUSIC/homm2_09.ogg", "MUSIC/pol/homm2_09.ogg" (3.51 MiB)`
   The size in brackets is produced by util::print_bytes (util/output.hpp:198-238): divide the byte
   count by 1024 until the whole part is under 1024, then print the whole part as an integer if it
   is >= 100 (so truncated, not rounded), otherwise print whole + remainder/1024 as a float with
   three significant digits. Reproducing that here means every row can be compared as text against
   our own byte count -- far sharper than allowing a rounding interval. */
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
function printBytes(size) {
  let whole = size;
  let frac = 0;
  let unit = 0;
  while (whole >= 1024 && unit < SIZE_UNITS.length - 1) {
    frac = whole % 1024;
    whole = Math.floor(whole / 1024);
    unit++;
  }
  if (whole >= 100) { return `${whole} ${SIZE_UNITS[unit]}`; }
  const num = Math.fround(whole) + Math.fround(frac / 1024);
  return `${Number(Math.fround(num).toPrecision(3))} ${SIZE_UNITS[unit]}`;
}

function parseListSizes(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const row = /^\s*-\s+(.*?)\s+\(([\d.]+) (B|KiB|MiB|GiB|TiB)\)\s*$/.exec(line);
    if (!row) { continue; }
    const printed = `${parseFloat(row[2])} ${row[3]}`;
    for (const name of row[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      rows.set(name[1].replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase(), printed);
    }
  }
  return rows;
}

/* ------------------------------------------------ part three: the ingest UI -- */

/* The picker wiring lives inside index.html's own <script>: not a module, and full of page-level
   state, so it cannot be imported as it stands. The page script is therefore extracted verbatim, given
   an export list by a generated wrapper, and imported from a scratch directory that also holds copies
   of inno.js, iso9660.js and a copy of inno.wasm -- so the page's own `import("./inno.js")` and its
   `new URL('inno.wasm', import.meta.url)` both resolve for real. What runs is the code users get, not
   a transcription of it; a stale copy cannot happen because every load copies afresh. */
const UI = path.join(repoRoot, 'files/emscripten/index.html');

function pageScript() {
  const html = readFileSync(UI, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) { fail('index.html has no inline script to test'); }
  return html.slice(start + '<script>'.length, end);
}

/* A ZIP writer, because the harness has to hand importArchive() a real archive rather than a
   transcription of one. Only what a reader looks at is emitted: a local header and payload per entry, a
   central directory, and the end-of-central-directory record. */
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const body = file.method === 8 ? zlib.deflateRawSync(file.body) : file.body;
    const crc = zlib.crc32(file.body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(file.method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(file.body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(file.method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(file.body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + body.length;
  }
  const body = Buffer.concat(local);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

async function uiProbe(videos) {
  const report = await new Promise((resolve, reject) => {
    /* --expose-gc so the fake store can emulate a browser reclaiming each file after storing it. */
    const child = spawn(process.execPath,
      ['--expose-gc', process.argv[1], '--ui-probe', videos ? '1' : '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  if (report.code !== 0) { fail(`probe exited ${report.code}: ${firstLine(report.err || report.out)}`); }
  try {
    return JSON.parse(report.out.trim().split('\n').pop());
  } catch {
    fail(`probe printed no report: ${firstLine(report.out)}`);
  }
}

/* The functions below are the ones the checks call; everything else in the page keeps running with
   its own private state, exactly as a browser tab's would. */
const UI_EXPORTS = ['importInstaller', 'importArchive', 'listAssets', 'gamePath', 'homeLoosePath',
  'normalizePath'];

async function loadUi() {
  const dir = path.join(TMP, 'ui');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of ['inno.js', 'iso9660.js']) {
    const source = path.join(repoRoot, 'files/emscripten', name);
    if (!existsSync(source)) { return null; }
    writeFileSync(path.join(dir, name), readFileSync(source), 'utf8');
  }
  writeFileSync(path.join(dir, 'inno.wasm'), readFileSync(WASM));
  writeFileSync(path.join(dir, 'ui-page.mjs'),
    `${pageScript()}\nexport { ${UI_EXPORTS.join(', ')} };\n`, 'utf8');

  /* A DOM stub just deep enough for the page's own start-up: elements carrying the few properties the
     page touches, a fake IndexedDB that records what would be stored, and nothing else. A property the
     page reaches for that is missing throws rather than being papered over, which is the point. */
  const stored = new Map();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, disabled: false, checked: false, value: '', textContent: '',
        style: {}, files: null,
        setAttribute() {}, getAttribute() { return null; },
        addEventListener() {},
        getBoundingClientRect: () => ({ width: 640, height: 480 }),
      });
    }
    return elements.get(id);
  };
  for (const id of ['gate-track', 'boot-track']) {
    Object.assign(element(id), { firstElementChild: { style: {} } });
  }
  Object.assign(element('canvas'), { width: 640, height: 480 });

  /* IndexedDB would hand the bytes to a file; a Map would not, and reading all 333 MiB of an import
     through JS just to remember its length would make this harness the memory hog it is measuring. So
     only the keys named below are hashed -- a stronger statement about their bytes than keeping them --
     and the rest are recorded by length, which is everything the tier-count checks look at. */
  const DIGEST = new Set(['data/heroes2.agg', 'anim/choose.smk']);
  const objectStore = {
    put: (blob, key) => {
      /* Test fixtures are tiny and are kept whole so a check can read their bytes back; the keys of a
         real import are hashed instead of held, below. */
      const keep = DIGEST.has(key) || blob.size < 64 * 1024;
      const record = { size: blob.size, sha256: null, blob: keep ? blob : null };
      stored.set(key, record);
      /* A browser frees the blob once IndexedDB has taken a copy of it, so the working set of an
         import is one file at a time. Node has no reason to be that prompt about the blob it just
         handed us, and would keep several hundred megabytes of dead files resident; where the
         harness was started with --expose-gc, the collector is asked to do what the browser would, so
         the peak that gets measured is the reader's working set rather than the garbage heap. */
      globalThis.gc?.();
    },
    clear: () => stored.clear(),
    /* listAssets() reads `request.result`, so the result has to be on the request as well as in the
       event object a browser would hand the handler. */
    getAllKeys: () => {
      const request = { result: null };
      Object.defineProperty(request, 'onsuccess', {
        set(handler) { request.result = [...stored.keys()]; handler({ target: request }); },
      });
      return request;
    },
  };
  const database = {
    transaction: () => ({
      objectStore: () => objectStore,
      set oncomplete(handler) { queueMicrotask(handler); },
      set onerror(handler) { void handler; },
      set onabort(handler) { void handler; },
    }),
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
  };

  /* Node's `navigator` is an accessor with no setter, so globals are swapped through descriptors
     rather than assignment, and restored the same way. */
  const saved = new Map();
  const put = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  put('document', {
    hidden: false,
    getElementById: element,
    querySelectorAll: () => [],
    createElement: () => ({ style: {} }),
    addEventListener() {},
    head: { append() {} },
  });
  put('window', {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false, wakeLock: null },
    confirm: () => true,
    /* Present on purpose: without it the page falls back to setInterval, which would keep this process
       alive after the last check. */
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  put('navigator', { standalone: false, wakeLock: null, serviceWorker: null });
  put('location', { protocol: 'https:', hostname: 'localhost', reload() {} });
  /* The page probes for directory-pick support with `"webkitdirectory" in HTMLInputElement.prototype`,
     which decides whether the folder button is offered. Reporting it absent is the honest answer for a
     stub that cannot pick a directory, and matches an old iOS Safari. */
  put('HTMLInputElement', class {
  });
  /* The page tests `"ResizeObserver" in window` but then names the global, so both have to be there:
     with the global absent the page would fall back to setInterval and keep this process alive. */
  put('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  put('indexedDB', {
    open: () => ({
      result: database,
      set onsuccess(handler) { queueMicrotask(() => handler({ target: { result: database } })); },
      set onerror(handler) { void handler; },
      set onupgradeneeded(handler) { void handler; },
      set onblocked(handler) { void handler; },
    }),
  });

  let page = null;
  try {
    page = await import(pathToFileURL(path.join(dir, 'ui-page.mjs')).href);
  } finally {
    for (const [name, previous] of saved) {
      delete globalThis[name];
      if (previous) { Object.defineProperty(globalThis, name, previous); }
    }
  }
  return { page, stored, element };
}

/* The page hands installer entries to putAsset() through the same path folding the ZIP and folder
   imports use, so the acceptance question is concrete: which keys land in the asset store, and is the
   mandatory aggregate among them. */
async function uiSuite() {
  const { InnoInstaller } = await import(pathToFileURL(READER).href);
  if (!existsSync(path.join(repoRoot, 'files/emscripten/iso9660.js'))) {
    note('ui suite', 'SKIP', 'files/emscripten/iso9660.js is not there yet');
    return;
  }
  const ui = await loadUi();
  if (!ui) {
    note('ui suite', 'SKIP', 'the extractor modules are not built yet');
    return;
  }
  const { page, stored, element } = ui;

  /* listAssets() is the page's own IndexedDB read, run during start-up; a broken request shape there
     would be swallowed by the try/catch that tolerates a device with nothing imported yet, so it is
     called directly instead. */
  await checkAsync('ui: the page reads its asset store back through listAssets()', async () => {
    stored.set('data/heroes2.agg', { size: 1, sha256: null });
    stored.set('maps/arena.mp2', { size: 1, sha256: null });
    const keys = await page.listAssets();
    if (keys.length !== 2 || !keys.includes('data/heroes2.agg')) {
      fail(`read back ${JSON.stringify(keys)}`);
    }
    return `${keys.length} keys read back through the page's own code`;
  });

  check('ui: the installer picker and the videos opt-in are in the page', () => {
    const html = readFileSync(UI, 'utf8');
    const need = {
      'an .exe file input': /<input id="inno-input" type="file"[^>]*accept="[^"]*\.exe/,
      'a label that opens it': /<label class="button" for="inno-input"/,
      'the videos checkbox': /<input id="videos-input" type="checkbox">/,
      'its change handler': /innoInput\.addEventListener\("change"/,
      'that both are disabled while busy': /\[zipInput, innoInput, folderInput, filesInput, videosInput/,
      'a style for the checkbox': /\.checkbox \{/,
    };
    const missing = Object.entries(need).filter(([, re]) => !re.test(html)).map(([what]) => what);
    if (missing.length) { fail(`missing in index.html: ${missing.join(', ')}`); }
    return `${Object.keys(need).length} wiring points present`;
  });

  check('ui: the offline shell carries the extractor', () => {
    const worker = readFileSync(path.join(repoRoot, 'files/emscripten/sw.js'), 'utf8');
    const missing = ['./inno.js', './inno.wasm', './iso9660.js']
      .filter((name) => !worker.includes(`"${name}"`));
    if (missing.length) { fail(`not precached: ${missing.join(', ')}`); }
    return 'inno.js, inno.wasm and iso9660.js are all in SHELL';
  });

  check('ui: the build copies and brotli-compresses the extractor', () => {
    const build = readFileSync(path.join(repoRoot, 'script/pwa/build.sh'), 'utf8');
    if (!/script\/pwa\/inno\/build\.sh/.test(build)) { fail('build.sh never builds the extractor'); }
    const missing = ['inno.js', 'inno.wasm', 'iso9660.js']
      .filter((name) => !build.includes(name));
    if (missing.length) { fail(`build.sh does not handle ${missing.join(', ')}`); }
    return 'built, copied, compressed and folded into the cache digest';
  });

  /* The acceptance criterion is that the older import paths still work after the installer picker was
     added; they share requireMandatory() and the path folding with it, so a mistake there breaks both.
     A synthetic archive of a handful of bytes is enough to drive importArchive() end to end through the
     same DOM stub: stored and deflated entries, and a file that is not part of the game. */
  await checkAsync('ui: ZIP import still works', async () => {
    const files = [
      { name: 'Heroes2/data/HEROES2.AGG', body: new TextEncoder().encode('agg-a'), method: 0 },
      { name: 'Heroes2/maps/arena.mp2', body: new TextEncoder().encode('m'.repeat(500)), method: 8 },
      { name: 'Heroes2/music/sw/homm2_06.ogg', body: new TextEncoder().encode('o'.repeat(900)), method: 8 },
      { name: 'Heroes2/anim/choose.smk', body: new TextEncoder().encode('s'.repeat(120)), method: 8 },
      { name: 'EULA.txt', body: new TextEncoder().encode('not a game file'), method: 0 },
    ];
    stored.clear();
    element('videos-input').checked = false;
    const result = await page.importArchive(new Blob([makeZip(files)]));
    if (result.count !== 4) { fail(`${result.count} of 4 game files stored`); }
    const keys = [...stored.keys()].sort();
    const want = ['anim/choose.smk', 'data/heroes2.agg', 'maps/arena.mp2', 'music/sw/homm2_06.ogg'];
    if (JSON.stringify(keys) !== JSON.stringify(want)) {
      fail(`stored ${JSON.stringify(keys)}, expected ${JSON.stringify(want)}`);
    }
    if (stored.get('maps/arena.mp2').size !== 500) { fail('a deflated entry came out the wrong size'); }
    const agg = new Uint8Array(await stored.get('data/heroes2.agg').blob.arrayBuffer());
    if (new TextDecoder().decode(agg) !== 'agg-a') { fail('a stored entry did not survive the round trip'); }
    return `${result.count} entries unpacked, the non-game entry ignored`;
  });

  await checkAsync('ui: an archive without the mandatory aggregate is refused', async () => {
    stored.clear();
    let message = '';
    try {
      await page.importArchive(new Blob([makeZip([
        { name: 'Heroes2/maps/arena.mp2', body: new TextEncoder().encode('x'), method: 0 },
      ])]));
    } catch (error) { message = firstLine(error); }
    if (!/HEROES2\.AGG/.test(message)) { fail(`unexpected: "${message}"`); }
    if (stored.size !== 0) { fail('files were stored despite the refusal'); }
    return 'refused before anything was stored';
  });

  if (!EXE || !existsSync(EXE)) {
    note('ui: importing the real installer stores the keys the engine reads', 'SKIP',
      'FH2_INNO_EXE is not set');
    return;
  }

  /* Importing the whole game through the page is the path a user takes, so it is worth measuring
     honestly: peak RSS is a per-process high-water mark, and 333 MiB of Blob garbage from an import
     would otherwise be charged to whatever check ran after it. Both imports therefore run in a fresh
     node process (see --ui-probe below) which reports what it stored and how high it climbed; the
     assertions stay here, where a failure names the expectation it missed. */
  await checkAsync('ui: importing the real installer stores the keys the engine reads', async () => {
    const report = await uiProbe(false);
    if (!report || report.count === 0) { fail(`the import stored nothing (${JSON.stringify(report)})`); }
    if (report.resultBytes <= 0) { fail('the import reported zero bytes'); }
    if (report.stray.length) { fail(`stored outside the game's folders: ${report.stray.slice(0, 4)}`); }
    if (report.tiers.maps !== 144 || report.tiers.music !== 54 || report.tiers.data < 2) {
      fail(`unexpected tier counts ${JSON.stringify(report.tiers)}`);
    }
    /* An unticked box must keep the 267 MiB image and every film out of the store. */
    if (report.tiers.anim !== 0) { fail('videos imported although unticked'); }
    if (report.discStored) { fail('the raw CD image was stored as if it were a game file'); }
    if (report.skippedVideos !== true) { fail('the import did not report the skipped video tier'); }
    if (report.aggSize !== 43363026) { fail(`data/heroes2.agg stored as ${report.aggSize} bytes`); }
    if (report.aggSha !== ORACLE_AGG_SHA) {
      fail(`${report.aggSha} is not the aggregate innoextract produces (${ORACLE_AGG_SHA})`);
    }
    /* What the page is responsible for is not holding on to what it stored: its JS heap has to stay at
       engine size no matter how much game data passed through it. (The brief's 300 MB ceiling is about
       the extraction itself and is measured by the streaming check above; node's own RSS peak in an
       import of this size is blob copies and pages V8 keeps after freeing them, which a browser does
       not pay for in the same way, so it is reported here rather than asserted on.) */
    if (report.usage.heapTotal > 64) {
      fail(`the page holds ${report.usage.heapTotal} MiB of heap after a `
        + `${(report.resultBytes / MB).toFixed(0)} MiB import`);
    }
    return `${report.count} files, ${(report.resultBytes / MB).toFixed(1)} MiB in `
      + `${(report.ms / 1000).toFixed(1)} s; ${JSON.stringify(report.tiers)}; `
      + `${report.usage.heapTotal} MiB heap retained, node RSS peak ${report.peakMiB.toFixed(1)} MiB`;
  });

  await checkAsync('ui: ticking the videos box stores the films, never the disc image', async () => {
    const report = await uiProbe(true);
    if (report.films !== 178) { fail(`${report.films} films stored, expected 178`); }
    if (report.discStored) { fail('the raw CD image was stored as if it were a game file'); }
    if (report.skippedVideos) { fail('the import claimed to skip videos that it stored'); }
    if (report.badFilms.length) {
      fail(`film stored under an unexpected key: ${report.badFilms.slice(0, 3)}`);
    }
    if (report.chooseSize !== 1742576) {
      fail(`anim/choose.smk stored as ${report.chooseSize} bytes`);
    }
    /* Cross-checked against the same film read straight out of the disc image through iso9660.js,
       which is a second, independent path to those bytes. */
    if (!report.chooseSha) { fail('anim/choose.smk was never read back'); }
    if (DISC_CHOOSE_SHA && report.chooseSha !== DISC_CHOOSE_SHA) {
      fail('the film the UI stored is not the film that is on the disc');
    }
    if (report.usage.heapTotal > 64) {
      fail(`the page holds ${report.usage.heapTotal} MiB of heap after a `
        + `${(report.resultBytes / MB).toFixed(0)} MiB import`);
    }
    return `${report.count} files, ${(report.resultBytes / MB).toFixed(1)} MiB in `
      + `${(report.ms / 1000).toFixed(1)} s, ${report.films} films folded under anim/, `
      + `${report.usage.heapTotal} MiB heap retained, node RSS peak `
      + `${report.peakMiB.toFixed(1)} MiB`;
  });

  await checkAsync('ui: a file that is not an installer is refused with a message', async () => {
    const started = Date.now();
    let message = '';
    try {
      await page.importInstaller(new Blob([new Uint8Array(2 * MB)]));
    } catch (error) { message = firstLine(error); }
    const elapsed = Date.now() - started;
    if (!/loader table|not an Inno|heroes of might/i.test(message) || elapsed > 30000) {
      fail(`unexpected: "${message}" after ${elapsed} ms`);
    }
    return `"${message}" in ${elapsed} ms`;
  });
}

/* ------------------------------------------------------------------ driver -- */

if (!existsSync(WASM)) {
  console.error(`inno.wasm not found at ${WASM}; run script/pwa/inno/build.sh first`);
  process.exit(1);
}

/* UI probe mode: --ui-probe 0|1 <exe>. Loads index.html's own script against the DOM stub, runs
   importInstaller() with the videos box in the given state, and prints one JSON line describing what
   landed in the fake asset store plus this process's peak RSS. It exists so that the several hundred
   megabytes an import allocates cannot be blamed on the process that keeps running the other checks;
   the assertions live in uiSuite(), which reads this report. */
if (process.argv[2] === '--ui-probe') {
  const videos = process.argv[3] === '1';
  const { page, stored, element } = await loadUi();
  element('videos-input').checked = videos;
  const started = Date.now();
  const outcome = await page.importInstaller(fileSource(EXE));
  /* The two hashed keys are filled in on a microtask; let the queue drain before reading them back. */
  await new Promise((resolve) => setImmediate(resolve));
  const keys = [...stored.keys()];
  const tiers = { data: 0, maps: 0, music: 0, anim: 0 };
  const stray = [];
  const badFilms = [];
  for (const key of keys) {
    const tier = key.split('/')[0];
    if (tier in tiers) { tiers[tier]++; } else { stray.push(key); }
    if (tier === 'anim' && !/^anim\/[^/]+\.smk$/.test(key)) { badFilms.push(key); }
  }
  /* Content is verified by hashing, and hashing means materialising the bytes -- so it happens here,
     after the import has finished and released every file it decoded, rather than inside put() where it
     would overlap the decoder's own copy of the same file. A browser never materialises these bytes at
     all: IndexedDB takes the blob as it stands. */
  for (const record of stored.values()) {
    if (record.blob) {
      record.sha256 = sha256(new Uint8Array(await record.blob.arrayBuffer()));
      record.blob = null;
    }
  }
  console.log(JSON.stringify({
    count: outcome.count,
    resultBytes: outcome.bytes,
    skippedVideos: outcome.skippedVideos,
    tiers,
    stray,
    badFilms,
    films: tiers.anim,
    discStored: keys.some((key) => key.includes('homm2.gog')),
    aggSize: stored.get('data/heroes2.agg')?.size ?? -1,
    aggSha: stored.get('data/heroes2.agg')?.sha256 ?? null,
    chooseSize: stored.get('anim/choose.smk')?.size ?? -1,
    chooseSha: stored.get('anim/choose.smk')?.sha256 ?? null,
    peakMiB: peakMiB(),
    usage: (() => {
      globalThis.gc?.();
      const m = process.memoryUsage();
      return Object.fromEntries(Object.entries(m)
        .map(([k, v]) => [k, Math.round(v / 1048576)]));
    })(),
    ms: Date.now() - started,
  }));
  process.exit(0);
}

/* Memory probe mode: the second half of the memory check above, run on its own so that nothing this
   process did earlier can show up in its peak. Prints "<peakKiB> <plaintextBytes> <milliseconds>". */
if (process.argv[2] === '--memory-probe') {
  const target = process.argv[3];
  const { InnoInstaller } = await import(pathToFileURL(READER).href);
  const started = Date.now();
  const probed = await InnoInstaller.open(fileSource(target),
    { wasmUrl: pathToFileURL(WASM).href });
  const digest = createHash('sha256');
  /* keepBytes is off: this is the shape a browser uses when it copies each part straight into its
     asset store, which is the case the 300 MB budget is about. */
  const outcome = await probed.extract(probed.findEntry('homm2.gog'),
    (view) => digest.update(view), { keepBytes: false });
  probed.dispose();
  /* The digest is not printed -- the caller only needs the peak, the byte count and the duration; it
     is computed here so that keeping the hash live proves it costs nothing to hold one. */
  console.log([process.resourceUsage().maxRSS, outcome.bytes, Date.now() - started,
    digest.digest('hex').slice(0, 0)].slice(0, 3).join(' '));
  process.exit(0);
}
console.log(`codec     ${WASM} (${wasmBytes.length} bytes)`);
console.log(`node      ${process.version} on ${process.platform}, peak RSS at start ${peakMiB().toFixed(1)} MiB`);
console.log('');

await codecSuite();
if (!EXE) {
  note('installer suite', 'SKIP', 'FH2_INNO_EXE is not set');
} else if (!existsSync(EXE)) {
  note('installer suite', 'SKIP', `${EXE} does not exist`);
} else {
  console.log(`installer ${EXE} (${(statSync(EXE).size / MB).toFixed(1)} MiB)\n`);
  await installerSuite();
  await uiSuite();
}

if (!process.env.FH2_KEEP_TMP) { rmSync(TMP, { recursive: true, force: true }); }

const passed = results.filter((r) => r.ok === true).length;
const skipped = results.filter((r) => r.ok === 'SKIP').length;
const failed = results.filter((r) => r.ok === false).length;
console.log('\n================ result ================');
for (const r of results) {
  console.log(`${r.ok === true ? 'ok  ' : r.ok === 'SKIP' ? 'skip' : 'FAIL'}  ${r.name}`
    + (r.detail ? `   ${r.detail}` : ''));
}
console.log(`========================================\n${passed} passed, ${skipped} skipped, ${failed} failed;`
  + ` peak RSS ${peakMiB().toFixed(1)} MiB`);
process.exit(failed ? 1 : 0);
