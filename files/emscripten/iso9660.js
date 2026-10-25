/*
 * Reading single files out of a CD image, without ever holding the image in memory.
 *
 * The GOG distribution of Heroes of Might and Magic II ships the animation videos inside `homm2.gog`, a
 * raw 2352-byte-per-sector dump of the original CD rather than a plain 2048-byte ISO. Every standard
 * reader (bsdtar/libarchive, 7-Zip, libcdio) only understands the 2048-byte shape, which is why the
 * desktop extraction script in script/homm2/extract_homm2_resources.sh first strips the sector headers
 * into a temporary file. A browser cannot afford that detour - the image is 260 MB and the phone caps a
 * tab's memory - so this module performs the same conversion, but sector by sector inside bounded
 * windows: it reads only the sectors a file occupies and hands back a Blob.
 *
 * What is parsed: the volume descriptor set (ECMA-119 7.1), directory records with their both-endian
 * fields and their zero-byte/one-byte quirks (ECMA-119 9.1), multi-extent files, and the System Use
 * Sharing Protocol records that carry the real filenames - Rock Ridge ER/SP/NM/PF/CL/RE/CE/ZF and the
 * UCS-2 levelling of a Joliet supplementary volume descriptor.
 *
 * Anything that would produce the wrong bytes - a mode 2 form 2 sector, an interleaved file, a zisofs
 * stream, an extent past the end of the volume - raises Iso9660Error. Never a silent guess.
 */

/** Raised for malformed or unsupported images; `code` names the rule that failed. */
export class Iso9660Error extends Error {
    constructor(code, message) {
        super(message);
        this.name = "Iso9660Error";
        this.code = code;
    }
}

const LOGICAL_SECTOR = 2048;         // ECMA-119 7.1.1: the unit the whole format is indexed in.
const FIRST_VOLUME_DESCRIPTOR = 16;  // 8 reserved system areas + 8 vendor ones, then the primary descriptor.
const MAX_VOLUME_DESCRIPTORS = 64;   // Sanity bound: a real set is the primary, a couple of supplementary, a terminator.
const MAX_WINDOW_SECTORS = 256;      // 512 KiB of user data per source read; 602 KiB when the image is raw.
const MAX_DIRECTORY_DEPTH = 32;      // Deeper than any CD tree in the wild, and it breaks reference cycles.
const MAX_CONTINUATION_HOPS = 8;     // Rock Ridge 1.12 4.1.3 allows chaining CE records; this is the stop loss.
const MAX_CONTINUATION_BYTES = 1 << 20;

// Raw and unmodelled layouts. `header` is where the 2048 user bytes begin, `mode` is the offset of the
// control byte whose low two bits name the sector mode (ECMA-130 8.3.1), and `sync` says whether the
// 12-byte frame sync of ECMA-130 8.2.2 is present so the stride can be confirmed against the file.
const GEOMETRIES = [
    { stride: 2048, header: 0, mode: -1, sync: false },   // already unmodelled: ISO 9660 as the spec draws it
    { stride: 2352, header: 16, mode: 15, sync: true },   // raw mode 1 - the shape of homm2.gog
    { stride: 2352, header: 24, mode: 15, sync: true },   // raw mode 2 form 1 (CD-ROM XA)
    { stride: 2336, header: 4, mode: 3, sync: false }     // raw without the sync field and the four zero bytes
];

const FRAME_SYNC = [ 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00 ];

// Directory record file flags, ECMA-119 9.1.16, numbered from the low bit of the byte at 25. The values
// matter: 0x02 is the directory bit, and reading it for something else makes every directory look like a
// multi-extent file. Interleaving is NOT one of these bits - 9.1.14/9.1.15 express it by a non-zero file
// unit size or gap size, which is checked at those fields.
const FLAG_EXTENDED_ATTRIBUTE = 0x01;
const FLAG_DIRECTORY = 0x02;
const FLAG_ASSOCIATED = 0x04;
const FLAG_CONTAINS_EXTENTS = 0x08;   // only meaningful for extended attribute records
const FLAG_PROTECTED = 0x10;
const FLAG_MULTI_EXTENT = 0x20;
const FLAG_OWN_DIRECTORY = 0x40;

// Field offsets inside a directory record (ECMA-119 9.1), used instead of magic numbers at each site.
const REC_EXTENT_LBA = 2;           // 4 bytes little-endian, mirrored big-endian at +4
const REC_EXTENT_SIZE = 10;         // 4 bytes little-endian, mirrored big-endian at +4
const REC_FLAGS = 25;
const REC_FILE_UNIT = 26;
const REC_GAP = 27;
const REC_NAME_LENGTH = 32;
const REC_NAME = 33;

// ECMA-119 7.4.1.2 permits code page 437 in a name field. Only the upper half differs from ASCII, and
// the lower half has to pass through untouched because 0x00 and 0x01 are structural there.
const CP437_HIGH =
    "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5" +
    "\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7" +
    "\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab" +
    "\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b" +
    "\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c" +
    "\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590" +
    "\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5" +
    "\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";

function decodeCp437(bytes) {
    let text = "";

    for (let i = 0; i < bytes.length; i += 1) {
        const byte = bytes[i];
        text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    }

    return text;
}

// Joliet identifiers are big-endian UCS-2 (the Windows console byte order), so they need their own decoder.
function decodeUtf16Be(bytes) {
    let text = "";

    for (let i = 0; i + 1 < bytes.length; i += 2) {
        text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }

    return text;
}

function readU16le(bytes, at) {
    return bytes[at] | (bytes[at + 1] << 8);
}

function readU32le(bytes, at) {
    // Multiplication rather than `<< 24`, which would turn a length above 2 GiB into a negative number.
    return ((bytes[at + 3] * 16777216) + (bytes[at + 2] << 16) + (bytes[at + 1] << 8) + bytes[at]) >>> 0;
}

function readU32be(bytes, at) {
    return ((bytes[at] * 16777216) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
}

/**
 * Normalise whatever the caller handed us into `{ size, read(offset, length) }`.
 *
 * A Blob or File is sliced rather than converted, so one read touches only the requested window and the
 * peak stays flat however large the image is. A typed array is used in place - the tests pass small
 * hand-assembled images, and copying them would only obscure what is being asserted. Anything else may
 * supply its own `read`, which is how a caller backed by a file handle or an HTTP range avoids loading
 * the whole image.
 */
function adaptSource(source) {
    if (source instanceof Uint8Array) {
        const bytes = source;

        return {
            size: bytes.length,
            read: async(offset, length) => {
                if (offset < 0 || offset + length > bytes.length) {
                    throw new Iso9660Error("short-read", `wanted ${length} bytes at ${offset}, source holds ${bytes.length}`);
                }

                return bytes.subarray(offset, offset + length);
            }
        };
    }

    if (typeof source?.slice === "function" && typeof source?.arrayBuffer === "function" && typeof source?.size === "number") {
        const blob = source;

        return {
            size: blob.size,
            read: async(offset, length) => {
                // Blob.slice clamps silently, so a window running off the end has to be caught by length.
                const view = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

                if (view.length !== length) {
                    throw new Iso9660Error("short-read", `wanted ${length} bytes at ${offset}, blob holds ${blob.size}`);
                }

                return view;
            }
        };
    }

    if (typeof source?.read === "function") {
        const custom = source;

        return {
            size: typeof custom.size === "number" ? custom.size : undefined,
            read: async(offset, length) => {
                const view = await custom.read(offset, length);

                if (!(view instanceof Uint8Array)) {
                    throw new Iso9660Error("bad-source", "source.read() must resolve to a Uint8Array");
                }

                if (view.length !== length) {
                    throw new Iso9660Error("short-read", `wanted ${length} bytes at ${offset}, source returned ${view.length}`);
                }

                return view;
            }
        };
    }

    throw new Iso9660Error("bad-source", "expected a Blob/File, a Uint8Array or { size, read(offset, length) }");
}

function hasFrameSync(bytes, at) {
    if (at + FRAME_SYNC.length > bytes.length) {
        return false;
    }

    for (let i = 0; i < FRAME_SYNC.length; i += 1) {
        if (bytes[at + i] !== FRAME_SYNC[i]) {
            return false;
        }
    }

    return true;
}

function isCd001(bytes, at) {
    return bytes[at] === 0x43 && bytes[at + 1] === 0x44 && bytes[at + 2] === 0x30
        && bytes[at + 3] === 0x30 && bytes[at + 4] === 0x31;
}

/**
 * Locate the volume descriptor set, without assuming the geometry.
 *
 * `'CD001'` sits one byte past the descriptor type, so the probe is anchored on it at sector 16 under
 * each stride/offset hypothesis: that is what tells a plain 2048-byte ISO from a raw dump, where the
 * same descriptor hides behind a 16- or 24-byte sector header. Raw hypotheses then have to prove the
 * stride by showing the frame sync at a spread of sectors, because a stray `CD001` inside arbitrary
 * file data would otherwise be read as a filesystem.
 */
async function detectGeometry(src) {
    for (const geometry of GEOMETRIES) {
        // A descriptor can sit anywhere in 16..23 - a hidden boot area or an HFS hybrid pushes the set
        // later - so every hypothesis is probed across that window. The window is clamped to the source
        // rather than skipped when the source is short: a small image with its primary at sector 16 is a
        // real image, and refusing to look at it because it is under 24 sectors would be arbitrary.
        const span = (FIRST_VOLUME_DESCRIPTOR + 8) * geometry.stride;
        const limit = src.size === undefined ? span : Math.min(span, src.size);
        const window = await src.read(0, limit);
        let descriptorSector = -1;

        for (let sector = FIRST_VOLUME_DESCRIPTOR; sector < FIRST_VOLUME_DESCRIPTOR + 8; sector += 1) {
            const head = sector * geometry.stride + geometry.header;

            if (head + 7 > window.length) {
                break;
            }

            // 7.1: type byte then 'CD001'; 0 = unused, 1 = primary, 2 = supplementary, 255 = terminator.
            if (isCd001(window, head + 1) && (window[head] <= 2 || window[head] === 0xff)) {
                descriptorSector = sector;
                break;
            }
        }

        if (descriptorSector < 0) {
            continue;
        }

        if (!geometry.sync) {
            return { geometry, descriptorSector };
        }

        // Check a spread of frames so a constant-filled or coincidentally-matching region cannot fake it.
        const frames = src.size === undefined ? descriptorSector + 16 : Math.floor(src.size / geometry.stride);

        if (frames <= descriptorSector) {
            continue;
        }

        const samples = new Set([ 0, 1, descriptorSector, Math.floor(frames / 2), frames - 1 ]);
        let trustworthy = true;

        for (const sector of samples) {
            if (sector >= frames) {
                continue;
            }

            const frame = await src.read(sector * geometry.stride, FRAME_SYNC.length);

            if (!hasFrameSync(frame, 0)) {
                trustworthy = false;
                break;
            }
        }

        if (trustworthy) {
            return { geometry, descriptorSector };
        }
    }

    throw new Iso9660Error("no-volume-descriptor",
        "no ISO 9660 volume descriptor ('CD001' at sector 16) under any of the 2048, 2352+16, 2352+24 or 2336 sector layouts");
}

/**
 * Cut the user data out of one physical window, deciding the sector mode sector by sector.
 *
 * A 1996 data track can interleave mode 1 and mode 2 sectors, so the mode is never inferred once per
 * file or per track. Mode 2 form 2 carries 2324 payload bytes instead of 2048, and reading it as though
 * it were form 1 shifts every following byte - which is exactly the corruption the desktop script's
 * `else` fallthrough invites, since it treats any mode that is not 2 as mode 1.
 */
function decodeWindow(physical, geometry, firstSector) {
    if (geometry.stride === LOGICAL_SECTOR) {
        return physical;
    }

    const frames = Math.floor(physical.length / geometry.stride);
    const logical = new Uint8Array(frames * LOGICAL_SECTOR);

    for (let frame = 0; frame < frames; frame += 1) {
        const base = frame * geometry.stride;
        const sector = firstSector + frame;

        if (geometry.sync && !hasFrameSync(physical, base)) {
            throw new Iso9660Error("bad-sync", `sector ${sector} does not start with the ECMA-130 frame sync`);
        }

        const control = physical[base + geometry.mode];

        if (control === undefined) {
            throw new Iso9660Error("short-sector", `sector ${sector} is shorter than its own header`);
        }

        const mode = control & 0x03;

        if (mode !== 1 && mode !== 2) {
            throw new Iso9660Error("bad-mode",
                `sector ${sector} control byte 0x${control.toString(16).padStart(2, "0")} is neither mode 1 nor mode 2`);
        }

        // ECMA-130 8.3.1: bit 4 set means the block carries no user data at all (and bit 6 that the
        // sector only fills out the end of a file), so neither can contribute 2048 file bytes.
        if (control & 0x10) {
            throw new Iso9660Error("bad-block-type",
                `sector ${sector} control byte 0x${control.toString(16).padStart(2, "0")} is not a user-data block`);
        }

        if (control & 0x40) {
            throw new Iso9660Error("residual-sector", `sector ${sector} is flagged residual, so its tail is padding rather than data`);
        }

        let header = geometry.header;

        if (mode === 1) {
            header = geometry.mode + 1;  // mode 1: 4 zero + 1 mode + 1 reserved, then the user bytes
        }
        else if (geometry.stride === 2352) {
            // Mode 2 form 1 is recognised by the two file/record-number bytes being zero; anything else
            // is form 2 (2324 payload bytes) or an XA attribute segment, and neither is 2048 file bytes.
            if (physical[base + 16] !== 0 || physical[base + 17] !== 0) {
                throw new Iso9660Error("mode2-form2",
                    `sector ${sector} is mode 2 with a non-form-1 body, whose 2324-byte payload cannot be read as 2048 bytes`);
            }

            header = 24;  // 4 zero + mode + channel + 4 file/record + 4 XA attributes
        }

        logical.set(physical.subarray(base + header, base + header + LOGICAL_SECTOR), frame * LOGICAL_SECTOR);
    }

    return logical;
}

/**
 * Where a record's System Use area starts.
 *
 * ECMA-119 9.1 pads the file identifier so the identifier - its length byte included - ends on an even
 * byte, so the padding exists when 33 + length lands odd, which is when the identifier length is EVEN.
 * Getting that one bit backwards is not cosmetic: it either reads the padding byte as a record header
 * and gives up on the area, or starts one byte inside the first real record. Either way Rock Ridge names
 * are lost without a complaint, which is how a mixed-case image silently turns into `alpha.txt`. Linux's
 * get_elt_offset, libarchive and pycdlib all round the same way; the byte dump of a pycdlib image
 * confirms it - a name length of 11 and one of 10 both put their `NM` tag at byte 44.
 */
function systemUseOffset(record) {
    const nameLength = record[REC_NAME_LENGTH];

    return REC_NAME + nameLength + (1 - (nameLength & 1));
}

/** Walk the System Use Sharing Protocol records of a record (Rock Ridge 1.12 4.2: tag, length, version). */
function* systemUseRecords(bytes, start, end) {
    let at = start;

    while (at + 4 <= end) {
        const length = bytes[at + 2];

        if (length < 4 || at + length > end) {
            return;  // a malformed entry ends the sharing-protocol area rather than derailing the parse
        }

        yield {
            tag: String.fromCharCode(bytes[at], bytes[at + 1]),
            version: bytes[at + 3],
            data: bytes.subarray(at + 4, at + length)
        };

        at += length;
    }
}

/**
 * A read-only ISO 9660 reader over a flat random-access source.
 *
 * Fields set by `open`:
 *   volumeId            - volume identifier from the primary descriptor, padded spaces trimmed
 *   volumeSpaceSize     - block count claimed by the primary descriptor
 *   sectorStride        - detected physical sector size: 2048, 2352 or 2336
 *   sectorHeader        - byte offset of the user data inside a physical sector
 *   nameSource          - 'iso-9660', 'rock-ridge', 'joliet' or 'rock-ridge+joliet'
 *   rockRidgeExtensions - the ER extension identifiers the image announced
 *   skipped             - entries the image advertises but that hold no readable bytes, with a reason
 */
export class Iso9660 {
    /** @param source a Blob/File, a Uint8Array, or `{ size?, read(offset, length) -> Uint8Array }`. */
    static async open(source) {
        const iso = new Iso9660();

        await iso._open(source);

        return iso;
    }

    async _open(source) {
        this._src = adaptSource(source);

        const probe = await detectGeometry(this._src);

        this._geometry = probe.geometry;
        this.sectorStride = probe.geometry.stride;
        this.sectorHeader = probe.geometry.header;

        // The descriptor set is a run of 2048-byte sectors starting at the probe's sector, ended by a type
        // 255 descriptor. Plenty of writers end it with nothing at all instead, and ECMA-119 7.1's type 0
        // means exactly that, so an unmarked or all-zero sector closes the set: the primary is already in
        // hand, and inventing an error here would reject images every other reader accepts. Only the first
        // primary descriptor and, when it announces UCS-2 levelling, the first Joliet supplementary
        // descriptor matter; a boot record, an ESD or a non-Joliet SVD is skipped rather than trusted.
        let primary = null;
        let joliet = null;

        for (let index = 0; index < MAX_VOLUME_DESCRIPTORS; index += 1) {
            const sector = await this._readSector(probe.descriptorSector + index);

            if (sector[0] === 0xff || sector[0] === 0x00 || !isCd001(sector, 1)) {
                break;
            }

            if (sector[0] === 0x01 && primary === null) {
                primary = sector;
            }
            else if (sector[0] === 0x02 && joliet === null && Iso9660._isJoliet(sector)) {
                joliet = sector;
            }
        }

        if (primary === null) {
            throw new Iso9660Error("no-primary-volume", "the volume descriptor set holds no type 1 primary descriptor");
        }

        const blockSize = readU16le(primary, 128);

        if (blockSize !== LOGICAL_SECTOR) {
            throw new Iso9660Error("block-size", `logical block size ${blockSize} is unsupported, only 2048-byte blocks are`);
        }

        // 7.9: the size of the logical volume in blocks, little- and big-endian. The little-endian copy
        // is authoritative; a writer that disagrees between the two has produced an image no tool reads.
        const spaceSizeLE = readU32le(primary, 80);
        const spaceSizeBE = readU32be(primary, 84);

        if (spaceSizeLE !== spaceSizeBE) {
            throw new Iso9660Error("endian-mismatch",
                `the volume size disagrees between the little- and big-endian copies (${spaceSizeLE} vs ${spaceSizeBE} blocks)`);
        }

        if (spaceSizeLE === 0) {
            throw new Iso9660Error("empty-volume", "the primary volume descriptor claims zero blocks");
        }

        // 8.4.1 pads the volume identifier with spaces, but writers that put a short name in a fixed field
        // also leave the rest zero (hdiutil writes 'MK' then NULs), so both endings have to go.
        this.volumeId = decodeCp437(primary.subarray(40, 72)).replace(/[ \0]+$/, "");
        this.volumeSpaceSize = spaceSizeLE;
        this._logicalEnd = spaceSizeLE * LOGICAL_SECTOR;

        if (this._src.size !== undefined) {
            if (this._geometry.stride === LOGICAL_SECTOR && this._src.size % LOGICAL_SECTOR !== 0) {
                throw new Iso9660Error("torn-image", `the source is ${this._src.size} bytes, not a whole number of 2048-byte sectors`);
            }

            const frames = Math.floor(this._src.size / this._geometry.stride);

            if (this._geometry.stride !== LOGICAL_SECTOR && frames < spaceSizeLE) {
                throw new Iso9660Error("torn-image",
                    `the volume claims ${spaceSizeLE} sectors but the source holds only ${frames} frames of ${this._geometry.stride} bytes`);
            }
        }

        this.rockRidgeExtensions = [];
        this.skipped = [];
        this._entries = [];
        this._byPath = new Map();
        this._attributeEntry = new Set();
        this._visited = new Set();

        // Joliet re-lists the whole tree in UCS-2 and is authoritative for names when present, which is
        // why it wins over Rock Ridge. Rock Ridge is then still honoured inside whichever tree is walked,
        // because a Joliet image may also carry SUSP records and NM renames survive in both.
        const rootRecord = joliet ?? primary;
        const rootExtent = {
            lba: readU32le(rootRecord, 156 + REC_EXTENT_LBA),
            length: readU32le(rootRecord, 156 + REC_EXTENT_SIZE)
        };

        this._useJoliet = joliet !== null;
        this._rockRidge = await this._detectRockRidge(rootExtent);

        // What the volume turns out to be, published so a caller can log or branch on it without
        // re-reading descriptors: which naming rules were in force, the block size, where the root
        // directory record pointed, and the sector geometry the bytes turned out to have.
        this.joliet = this._useJoliet;
        this.rockRidge = this._rockRidge;
        this.logicalBlockSize = LOGICAL_SECTOR;
        this.descriptorSector = probe.descriptorSector;
        this.rootDirectory = { lba: rootExtent.lba, length: rootExtent.length };
        this.nameSource = this._useJoliet && this._rockRidge ? "rock-ridge+joliet"
            : this._useJoliet ? "joliet"
                : this._rockRidge ? "rock-ridge" : "iso-9660";

        await this._walkDirectory(rootExtent, "", 0);

        this._entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }

    static _isJoliet(sector) {
        // The Joliet specification identifies a UCS-2 volume by the ISO 2022 escape sequence recorded in
        // the supplementary descriptor's Escape Sequences field, which sits at byte 88 of the descriptor
        // and runs to 95: `%/@` for level 1, `%/C` level 2, `%E` level 3. Byte 881 is the file structure
        // version, so testing there finds a 0x01 and then application use - hdiutil, mkisofs and bsdtar
        // all agree the tree at 88 is what makes a volume Joliet.
        return sector[88] === 0x25 && sector[89] === 0x2f && (sector[90] === 0x40 || sector[90] === 0x43 || sector[90] === 0x45);
    }

    /**
     * Rock Ridge is on when some record of the root directory carries SP or ER (1.12 4.1.2, 4.12).
     *
     * The full record walk is used rather than a shallow tag scan because 1.12 allows the ER record to
     * spill into a continuation area, and the records that carry it are the root's own `.` entries, which
     * are otherwise skipped as structural. Reading them fully is also how the extension identifiers are
     * published on an image that names them nowhere else.
     */
    async _detectRockRidge(rootExtent) {
        let found = false;

        await this._readDirectoryRecords(rootExtent, async(record) => {
            const susp = await this._readSusp(record, systemUseOffset(record), record.length);

            found = found || susp.susp === true || susp.sawExtensionReference === true;
        });

        return found;
    }

    async _readSector(sector) {
        return this._readSectors(sector, 1);
    }

    /** Read `count` logical sectors, converting physical frames to 2048-byte user data. */
    async _readSectors(first, count) {
        if (first < 0 || count <= 0 || (first + count) * LOGICAL_SECTOR > this._logicalEnd) {
            throw new Iso9660Error("extent-out-of-range",
                `sectors ${first}..${first + count - 1} reach past the ${this.volumeSpaceSize}-sector volume`);
        }

        const stride = this._geometry.stride;
        const physical = await this._src.read(first * stride, count * stride);

        if (physical.length !== count * stride) {
            throw new Iso9660Error("short-read", `expected ${count * stride} bytes at ${first * stride}, source gave ${physical.length}`);
        }

        return decodeWindow(physical, this._geometry, first);
    }

    /**
     * Visit every directory record of an extent.
     *
     * A record never straddles a sector, so a zero length byte means "the rest of this sector is
     * padding" and iteration restarts on the next sector boundary (ECMA-119 9.1) - the quirk that makes
     * a naive byte cursor invent phantom entries.
     */
    async _readDirectoryRecords(extent, visit) {
        const sectors = Math.max(1, Math.ceil(extent.length / LOGICAL_SECTOR));

        for (let from = 0; from < sectors; from += MAX_WINDOW_SECTORS) {
            const count = Math.min(MAX_WINDOW_SECTORS, sectors - from);
            const buffer = await this._readSectors(extent.lba + from, count);

            for (let at = 0; at < buffer.length; ) {
                const length = buffer[at];

                if (length === 0) {
                    at = (Math.floor(at / LOGICAL_SECTOR) + 1) * LOGICAL_SECTOR;
                    continue;
                }

                if (at + length > buffer.length) {
                    break;  // truncated by the end of the extent: nothing behind it can be trusted
                }

                if (length < REC_NAME + 1) {
                    throw new Iso9660Error("short-record",
                        `a directory record at sector ${extent.lba + from + Math.floor(at / LOGICAL_SECTOR)} is ${length} bytes, shorter than the fixed part of 9.1`);
                }

                await visit(buffer.subarray(at, at + length));
                at += length;
            }
        }
    }

    async _walkDirectory(extent, prefix, depth) {
        if (depth > MAX_DIRECTORY_DEPTH) {
            throw new Iso9660Error("too-deep", `directory nesting goes past ${MAX_DIRECTORY_DEPTH} levels under '${prefix}'`);
        }

        // A directory extent belongs to exactly one directory, so revisiting one means the image points
        // two names at the same tree (or loops); the second sighting is reported and dropped.
        const key = `${extent.lba}:${extent.length}`;

        this._visited ??= new Set();

        if (this._visited.has(key)) {
            this.skipped.push({ path: prefix || "/", reason: `directory extent ${key} was already walked` });
            return;
        }

        this._visited.add(key);

        // A multi-extent file is a run of records that share one name, every record but the last
        // carrying the multi-extent flag, each contributing the extent it names (ECMA-119 9.1, 9.4). The
        // last record is part of the file too, so the run closes when the flag finally reads clear. Any
        // other record in between is an image that cannot be reassembled, and guessing would splice two
        // files' bytes together - so it throws.
        let run = null;

        await this._readDirectoryRecords(extent, async(record) => {
            const parsed = await this._parseRecord(record, prefix);

            if (parsed === null || parsed.kind === "self" || parsed.kind === "parent") {
                return;
            }

            if (parsed.kind === "directory") {
                if (run !== null) {
                    throw new Iso9660Error("broken-multi-extent",
                        `the multi-extent file '${run.parsed.entry.path}' is interrupted by directory '${parsed.entry.name}'`);
                }

                if (parsed.extent !== null) {
                    await this._walkDirectory(parsed.extent, prefix + parsed.entry.name + "/", depth + 1);
                }

                return;
            }

            if (run !== null) {
                if (parsed.key !== run.key) {
                    throw new Iso9660Error("broken-multi-extent",
                        `the multi-extent file '${run.parsed.entry.path}' is followed by unrelated record '${parsed.entry.path}'`);
                }

                run.extents.push({ lba: parsed.lba, length: parsed.length });

                if ((parsed.flags & FLAG_MULTI_EXTENT) === 0) {
                    this._addFile(run.parsed, run.extents);
                    run = null;
                }

                return;
            }

            if ((parsed.flags & FLAG_MULTI_EXTENT) === 0) {
                this._addFile(parsed, [ { lba: parsed.lba, length: parsed.length } ]);
                return;
            }

            run = { key: parsed.key, parsed, extents: [ { lba: parsed.lba, length: parsed.length } ] };
        });

        if (run !== null) {
            throw new Iso9660Error("broken-multi-extent",
                `'${run.parsed.entry.path}' keeps its multi-extent flag in the last record of '${prefix}', so the file has no end`);
        }
    }

    /** Turn one directory record into a file description, a directory to descend into, or nothing. */
    async _parseRecord(record, prefix) {
        const nameLength = record[REC_NAME_LENGTH];
        const identifier = record.subarray(REC_NAME, REC_NAME + nameLength);

        // '.' and '..' are encoded as the single bytes 0x00 and 0x01 - and, on some writers, as a
        // zero-length identifier. They hold Rock Ridge state but are never entries themselves.
        if (nameLength === 0 || (nameLength === 1 && identifier[0] <= 1)) {
            return { kind: identifier[0] === 1 ? "parent" : "self" };
        }

        const susp = await this._readSusp(record, systemUseOffset(record), record.length);
        const flags = record[REC_FLAGS];
        const name = this._displayName(identifier, susp);

        if (flags & FLAG_DIRECTORY) {
            // Which extent holds this directory's records.
            //
            // - CL (4.8) names a sector; the record carrying it is a stub whose own location fields the
            //   writer zeroed, so the pair read here is meaningless and the extent comes from that sector.
            // - RE (4.10) marks this record as the hole a relocated directory left at its old place. It
            //   carries no address worth following, and the directory is still listed - by the parent that
            //   received it, with that parent's own CL. Walking the hole too would read one directory
            //   twice, so the placeholder is reported and left alone.
            // - Otherwise the record's own little-endian pair is the extent (ECMA-119 9.1). A zero length
            //   is an empty directory, which images do contain, so it is simply not descended into.
            if (susp.childLink !== undefined) {
                return {
                    kind: "directory",
                    entry: { name },
                    extent: await this._childLinkExtent(susp.childLink.lba, prefix + name),
                };
            }

            if (susp.relocated) {
                this.skipped.push({
                    path: prefix + name,
                    reason: "Rock Ridge RE: the placeholder a relocated directory left behind; the directory is listed under the parent that received it",
                });

                return { kind: "directory", entry: { name }, extent: null };
            }

            const length = readU32le(record, REC_EXTENT_SIZE);

            return {
                kind: "directory",
                entry: { name },
                extent: length === 0 ? null : { lba: readU32le(record, REC_EXTENT_LBA), length },
            };
        }

        if (susp.posixFileType !== undefined && susp.posixFileType !== 0x8000 && susp.posixFileType !== 0x4000) {
            // PF (4.16) marks a FIFO, device or socket: the extent holds nothing a player could use.
            this.skipped.push({ path: prefix + name, reason: `Rock Ridge PF reports file type 0x${susp.posixFileType.toString(16)}` });
            return null;
        }

        if (susp.symlink) {
            // SL (4.1.4): the extent of a symlink record holds the target text, so reading it would hand
            // back a pathname where the caller expects file bytes.
            this.skipped.push({ path: prefix + name, reason: "Rock Ridge SL: a symbolic link, not file contents" });
            return null;
        }

        const lba = readU32le(record, REC_EXTENT_LBA);
        const length = readU32le(record, REC_EXTENT_SIZE);
        const lbaBE = readU32be(record, REC_EXTENT_LBA + 4);
        const lengthBE = readU32be(record, REC_EXTENT_SIZE + 4);

        if (lba !== lbaBE || length !== lengthBE) {
            throw new Iso9660Error("endian-mismatch",
                `'${prefix}${name}' extent disagrees between the little- and big-endian copies (${lba}/${length} vs ${lbaBE}/${lengthBE})`);
        }

        // Interleaving is expressed by the file unit and gap sizes (ECMA-119 9.1.14/9.1.15): a non-zero
        // pair means the bytes are striped with other files and the extent is not one range.
        if (record[REC_FILE_UNIT] !== 0 || record[REC_GAP] !== 0) {
            throw new Iso9660Error("interleaved",
                `'${prefix}${name}' is interleaved with file unit ${record[REC_FILE_UNIT]} and gap ${record[REC_GAP]}, so its extent is not one range of bytes`);
        }

        if (susp.compressed) {
            throw new Iso9660Error("zisofs", `'${prefix}${name}' carries a ZF record: the extent holds deflate data, not the file`);
        }

        return {
            kind: "file",
            key: `${prefix}\u0000${name}\u0000${susp.multiExtentSequence ?? ""}`,
            flags,
            lba,
            length,
            entry: { name, path: prefix + name, version: susp.version }
        };
    }

    /**
     * The extent a CL record's directory really occupies.
     *
     * CL (4.8) names a sector and nothing else, while the stub record that carries it has had its own
     * location fields zeroed by the writer - pycdlib, genisoimage and mkisofs all do this. The size is
     * therefore taken from the one account that survives: the directory's own `.` record, first in the
     * sector CL names (ECMA-119 9.1), which the writer filled in with the real extent. A sector that
     * holds no such record is not a relocated directory, and the caller is told so through `skipped`
     * rather than being handed a subtree guessed at from padding.
     */
    async _childLinkExtent(lba, path) {
        const complain = reason => {
            this.skipped.push({ path, reason: `Rock Ridge CL points at sector ${lba}, which ${reason}` });

            return null;
        };

        let sector;

        try {
            sector = await this._readSector(lba);
        }
        catch (error) {
            return complain(`could not be read (${error.message})`);
        }

        const length = sector[0];

        if (length < REC_NAME + 1) {
            return complain(`opens with a ${length}-byte record, shorter than the fixed part of 9.1`);
        }

        const first = sector.subarray(0, length);

        if (!(first[REC_FLAGS] & FLAG_DIRECTORY)) {
            return complain(`opens on a record with flags 0x${first[REC_FLAGS].toString(16)}, which is not a directory`);
        }

        const size = readU32le(first, REC_EXTENT_SIZE);

        if (size === 0) {
            return complain("holds a directory record that claims zero bytes");
        }

        return { lba, length: size };
    }

    /**
     * Publish one file: resolve its extent list, and refuse anything that cannot be read back whole.
     *
     * ECMA-119 9.1.16 sets the extended-attribute bit on the records some writers use to describe a file
     * that is also listed normally, so a repeated path is decided by preferring the plain record - the
     * alternative would list one file twice, or drop a file that only the attribute record names.
     * homm2.gog is the second case: `HEROES2/HELP/HEROES2.GID` appears once, carrying that bit, and its
     * extent holds the real bytes, which is why the bit is never a reason to skip an entry here.
     */
    _addFile(parsed, extents) {
        const path = parsed.entry.path;
        const attributeEntry = (parsed.flags & FLAG_EXTENDED_ATTRIBUTE) !== 0;
        let total = 0;

        for (const [ index, extent ] of extents.entries()) {
            // An empty file is one record whose extent is zero bytes long, and it is legitimate - hdiutil
            // writes one for an ISO that contains itself. Inside a multi-extent file, though, an empty
            // extent means the run was assembled wrongly, because 9.4 says all but the last are full.
            if (extent.length === 0 && extents.length > 1) {
                throw new Iso9660Error("zero-extent", `'${path}': extent ${index + 1} of a multi-extent file is empty`);
            }
            if (extent.lba * LOGICAL_SECTOR + extent.length > this._logicalEnd) {
                throw new Iso9660Error("extent-out-of-range",
                    `'${path}': extent ${index + 1} at sector ${extent.lba} of ${extent.length} bytes runs past the volume`);
            }

            // 9.4: every extent but the last fills whole sectors. A shorter one means the writer left a
            // hole between this file and the next, so concatenating the extents would invent bytes.
            if (index < extents.length - 1 && extent.length % LOGICAL_SECTOR !== 0) {
                throw new Iso9660Error("unaligned-extent",
                    `'${path}': extent ${index + 1} holds ${extent.length} bytes, which is not a whole number of sectors`);
            }

            total += extent.length;
        }

        // The records list the extents, not their adjacency. When they happen to sit back to back they
        // are collapsed into one range so `read()` issues one sequential sweep instead of one per record.
        const ranges = [ { lba: extents[0].lba, length: extents[0].length } ];

        for (const extent of extents.slice(1)) {
            const previous = ranges[ranges.length - 1];
            const nextSector = previous.lba + Math.ceil(previous.length / LOGICAL_SECTOR);

            if (extent.lba !== nextSector) {
                throw new Iso9660Error("scattered-extent",
                    `'${path}': extent continues at sector ${extent.lba} but the previous one ends at ${nextSector}, and a directory record cannot say what fills the gap`);
            }

            previous.length += extent.length;
        }

        const entry = Object.freeze({
            path,
            name: parsed.entry.name,
            size: total,
            lba: ranges[0].lba,
            length: total,
            extents: Object.freeze(ranges.map(range => Object.freeze(range))),
            multiExtent: extents.length > 1,
            version: parsed.entry.version
        });

        this._byPath ??= new Map();
        this._attributeEntry ??= new Set();

        const existing = this._byPath.get(path);

        if (existing === undefined) {
            this._byPath.set(path, entry);

            if (attributeEntry) {
                this._attributeEntry.add(path);
            }

            this._entries.push(entry);
            return;
        }

        // Two records name the same path. An entry whose attribute bit is clear is the file itself, so it
        // replaces an attribute entry and keeps a plain duplicate out of the listing; two attribute
        // entries, or a second plain one, cannot both be true, so the first stands and the clash is said.
        if (!attributeEntry && this._attributeEntry.has(path)) {
            this._entries[this._entries.indexOf(existing)] = entry;
            this._byPath.set(path, entry);
            this._attributeEntry.delete(path);
            return;
        }

        this.skipped.push({ path, reason: attributeEntry ? "second record for the path, an extended-attribute entry" : "second plain record for the same path" });
    }

    /** Collect the SUSP records of one directory record, following continuation areas as needed. */
    async _readSusp(record, start, end) {
        const susp = { nameParts: [] };
        let area = { bytes: record, start, end };

        for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop += 1) {
            susp.continuation = null;

            for (const entry of systemUseRecords(area.bytes, area.start, area.end)) {
                this._applySusp(entry, susp);
            }

            if (susp.continuation === null) {
                break;
            }

            const area_ = susp.continuation;

            if (area_.length === 0 || area_.length > MAX_CONTINUATION_BYTES) {
                throw new Iso9660Error("bad-continuation", `a CE record asks for ${area_.length} bytes`);
            }

            const buffer = await this._readSectors(area_.lba, Math.ceil(area_.length / LOGICAL_SECTOR));

            if (area_.offset >= buffer.length) {
                throw new Iso9660Error("bad-continuation", `a CE record points at offset ${area_.offset} of a ${buffer.length}-byte area`);
            }

            area = { bytes: buffer, start: area_.offset, end: Math.min(buffer.length, area_.offset + area_.length) };
        }

        if (susp.continuation !== null) {
            throw new Iso9660Error("bad-continuation", `CE records chain past ${MAX_CONTINUATION_HOPS} hops`);
        }

        if (susp.nameParts.length > 0) {
            const total = susp.nameParts.reduce((sum, part) => sum + part.length, 0);
            const name = new Uint8Array(total);

            for (let i = 0, at = 0; i < susp.nameParts.length; i += 1) {
                name.set(susp.nameParts[i], at);
                at += susp.nameParts[i].length;
            }

            susp.nameBytes = name;
        }

        return susp;
    }

    _applySusp(entry, susp) {
        switch (entry.tag) {
            case "SP":  // 4.12 System Use Sharing Protocol verification pattern
                susp.susp = true;
                break;
            case "ER": {  // 4.1.1 says which extension supplies the remaining records
                // The payload is three field lengths and the extension's own version, then the identifier
                // text: len_id, descriptor length, source length, version, id, descriptor, source. Only the
                // identifier is kept, since 4.1.2 makes it the thing a reader has to recognise.
                const idLength = entry.data[0];
                const id = decodeCp437(entry.data.subarray(4, 4 + idLength));

                susp.sawExtensionReference = true;

                if (idLength > 0 && !this.rockRidgeExtensions.includes(id)) {
                    this.rockRidgeExtensions.push(id);
                }

                break;
            }
            case "CE": {  // 4.1.3 continuation area: sector, offset, length, each 8 bytes both-endian
                const lba = readU32le(entry.data, 0);
                const offset = readU32le(entry.data, 8);
                const length = readU32le(entry.data, 16);

                // The big-endian mirrors sit at +4, +12 and +20; when the record is long enough to carry
                // them they have to agree, because reading the wrong copy points at unrelated sectors.
                if (entry.data.length >= 24
                    && (readU32be(entry.data, 4) !== lba || readU32be(entry.data, 12) !== offset || readU32be(entry.data, 20) !== length)) {
                    throw new Iso9660Error("endian-mismatch", "a CE record disagrees between its little- and big-endian copies");
                }

                susp.continuation = { lba, offset, length };
                break;
            }
            case "NM": {  // 4.21 the real name
                // Rock Ridge 1.12 4.21 says `char version; char Name[]`, which is how genisoimage writes
                // it: the name starts on the first payload byte. pycdlib and the Linux kernel's rock.c
                // instead take one more byte - a flags field with CURRENT/PARENT/HOST bits - and read the
                // name after it, so the same four header bytes can be followed by either. The two layouts
                // are told apart by the bytes themselves: 0x00 and 0x01 cannot begin a POSIX or CP-437
                // filename, so a payload starting with one is carrying the control byte and the rest is
                // the name, while any other first byte can only be the name. Dropping the wrong byte would
                // silently prefix every recovered name with a NUL, which is why the check is on content.
                // A payload that is only a control byte is 4.21's CURRENT/PARENT/HOST marker standing in
                // for the name of `.` or `..`; there is no legal one-character name among those values, so
                // nothing is a name here and the ISO identifier stays in charge.
                const first = entry.data.length > 0 ? entry.data[0] : -1;

                if (entry.data.length > 1 && (first === 0 || first === 1)) {
                    susp.nameFlags = first;
                    susp.nameParts.push(entry.data.subarray(1));
                }
                else if (entry.data.length >= 1 && first > 1) {
                    susp.nameParts.push(entry.data);
                }

                break;
            }
            case "PF": {  // 4.16 POSIX file attributes; only the file type matters to a reader
                // The payload is the mode as a both-endian pair, then links, uid, gid and (1.12 only) a
                // serial number. 4.16.3 numbers the fields from the first payload byte, which pycdlib's
                // writer confirms: mode little-endian at 0, its mirror at 4.
                const mode = readU32le(entry.data, 0);

                if (entry.data.length >= 8 && readU32be(entry.data, 4) !== mode) {
                    throw new Iso9660Error("endian-mismatch", "a PF record disagrees between its little- and big-endian file modes");
                }

                susp.posixFileType = mode & 0xf000;
                break;
            }
            case "SL":  // 4.1.4 symbolic link: the extent holds the target text, not file contents
                susp.symlink = true;
                break;
            case "CL": {  // 4.8 directory moved off its own extent: the child location, both-endian
                // 4.8 carries a sector number and nothing else. The stub record hosting it has had its own
                // location fields zeroed, so the pair read from that stub says nothing; _childLinkExtent
                // gets the length from the directory's own record, found in the sector named here.
                const lba = readU32le(entry.data, 0);

                if (entry.data.length >= 8 && readU32be(entry.data, 4) !== lba) {
                    throw new Iso9660Error("endian-mismatch", "a CL record disagrees between its little- and big-endian child locations");
                }

                susp.childLink = { lba };
                break;
            }
            case "RE":  // 4.10 this record is the placeholder a relocated directory left behind
                susp.relocated = true;
                break;
            case "ZF":  // 4.13 zisofs: the on-disc bytes are compressed, not the file
                susp.compressed = true;
                break;
            case "TF":  // 4.15 timestamps; noted so a caller can see them without a second read
                susp.timestamps = true;
                break;
            default:
                break;  // unknown extensions are tolerated: the ISO identifier still names the entry
        }
    }

    /**
     * The name an entry is offered under, plus the version the bare identifier carried.
     *
     * Rock Ridge names are byte strings in the volume's own character set, taken verbatim: case, length
     * and dots all survive, which is what decides whether this image calls the file INTRO.SMK or
     * intro.smk. Only the ISO-9660 identifier carries the `;version` suffix and the level-1 padding dot
     * (ECMA-119 7.5.1), so only it is trimmed - a Rock Ridge name that really ends in a dot, or that
     * contains a semicolon, must not be shortened. The version is still read from the identifier, because
     * the rename replaces the name and not the fact that this is the third revision of the file.
     */
    _displayName(identifier, susp) {
        // The identifier is CP-437 on an ISO-9660 volume and big-endian UCS-2 on a Joliet one, and both
        // spell the version suffix the same way, so it is decoded once in the volume's own character set
        // and the version is taken from that - even when a Rock Ridge rename replaces the name, because
        // the rename replaces the name and not the fact that this is the third revision of the file.
        const rawText = this._useJoliet ? decodeUtf16Be(identifier) : decodeCp437(identifier);
        const version = /;(\d*)$/.exec(rawText);

        if (version !== null) {
            susp.version = version[1] === "" ? undefined : Number(version[1]);
        }

        if (susp.nameBytes !== undefined && susp.nameBytes.length > 0) {
            return decodeCp437(susp.nameBytes);
        }

        let text = version === null ? rawText : rawText.slice(0, rawText.length - version[0].length);

        // Level 1 writers pad a name with no extension, and every directory name, with a trailing dot.
        if (text.endsWith(".")) {
            text = text.slice(0, -1);
        }

        return text;
    }

    /**
     * Files, in ascending path order, optionally limited to one subtree.
     *
     * `prefix` is matched with any leading slash removed and ASCII letter case folded, so `'anim'`,
     * `'/HEROES2/ANIM/'` and `''` all behave. The folding is deliberate: an ISO-9660 image stores
     * `ANIM` upper-case and a caller that types `'anim'` would otherwise get an empty list with nothing to
     * indicate a mistake, while the entries themselves keep the image's own letter case. Each entry is
     * `{ path, name, size, lba, length, extents, multiExtent, version }`: `path` is relative to the
     * volume root with `'/'` separators, `size` and `length` are the total bytes over all extents, `lba`
     * the first sector, and `extents` the list `read()` follows. Entries are frozen, so handing them out
     * shares one record per file instead of copying.
     */
    list(prefix = "") {
        const needle = String(prefix).replace(/^\/+/, "");

        if (needle === "") {
            return [ ...this._entries ];
        }

        const folded = needle.toUpperCase();

        return this._entries.filter(entry => entry.path.toUpperCase().startsWith(folded));
    }

    /**
     * The whole file as a Blob.
     *
     * Accepts an entry from `list()` or one of their paths, matched the way `list()` matches a prefix.
     * Extents are copied out in bounded windows, so peak memory tracks the window size rather than the
     * file, and a multi-extent file comes back as the concatenation of its extents in the order the
     * directory lists them.
     */
    async read(entry) {
        const found = typeof entry === "string" ? this._find(entry) : entry;

        if (found === undefined || found === null) {
            throw new Iso9660Error("no-such-file", `'${entry}' is not a file in this volume`);
        }

        if (found.path === undefined || found.extents === undefined) {
            throw new Iso9660Error("bad-entry", "read() takes an entry from list() or one of their paths");
        }

        const chunks = [];

        for (const extent of found.extents) {
            const sectors = Math.ceil(extent.length / LOGICAL_SECTOR);

            for (let from = 0; from < sectors; from += MAX_WINDOW_SECTORS) {
                const count = Math.min(MAX_WINDOW_SECTORS, sectors - from);
                const data = await this._readSectors(extent.lba + from, count);
                const wanted = Math.min(extent.length - from * LOGICAL_SECTOR, count * LOGICAL_SECTOR);

                // The tail of the last sector is the next file's data, so it must not ride along.
                chunks.push(wanted === data.length ? data : data.subarray(0, wanted));
            }
        }

        return new Blob(chunks);
    }

    /**
     * Resolve one path: the exact path map first, then a case-folded scan, so a caller that typed
     * `'heroes2/anim/intro.smk'` for a volume that stores `HEROES2/ANIM/INTRO.SMK` still gets the file.
     * Only the folded branch is a search, and it runs once per lookup rather than per listed file.
     */
    _find(path) {
        const needle = String(path).replace(/^\/+/, "");
        const exact = this._byPath.get(needle);

        if (exact !== undefined) {
            return exact;
        }

        const folded = needle.toUpperCase();

        return this._entries.find(entry => entry.path.toUpperCase() === folded);
    }
}
