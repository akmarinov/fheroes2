/*
 * Tests for files/emscripten/iso9660.js.
 *
 * Two groups, deliberately separated:
 *
 *   1. Synthetic images, assembled byte by byte in this file. They always run, so the reader is covered on
 *      a machine with no game data present - which is the only machine most contributors have.
 *   2. The real GOG image, skipped unless FH2_GOG names it. It is the only image that exercises a raw
 *      2352-byte dump of a 1996 disc at the size where bounded windows actually matter.
 *
 * The fixtures encode the layouts the module claims to parse - both-endian fields, the zero-length-record
 * sector padding, multi-extent runs, Rock Ridge with and without a continuation area, relocated
 * directories (CL stubs and RE placeholders), Joliet, raw mode 1 and mode 2 frames - plus the negative
 * cases that must raise rather than guess.
 *
 * Run: node script/pwa/test/test-iso9660.mjs
 *      FH2_GOG=~/Downloads/homm2.gog node script/pwa/test/test-iso9660.mjs      # or the installer .exe
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Iso9660, Iso9660Error } from "../../../files/emscripten/iso9660.js";

const SECTOR = 2048;
const RAW = 2352;

// ---------------------------------------------------------------------------
// A small ISO builder.
//
// Records are laid out the way real writers lay them out - checked against a dump of the GOG image and
// against pycdlib's output: volume sequence number as a both-endian pair at 28..31, identifier length at
// 32, identifier at 33, System Use area at the next even byte after the identifier, and the record's own
// length byte counting the System Use area.
// ---------------------------------------------------------------------------

const FRAME_SYNC = Uint8Array.from([ 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0 ]);
const bytesOf = text => new TextEncoder().encode(text);

function le32(value) {
    return [ value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, Math.floor(value / 16777216) & 0xff ];
}

function be32(value) {
    return [ Math.floor(value / 16777216) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff ];
}

/** The both-endian pair ECMA-119 uses for every number in a descriptor or directory record. */
function pair(value, beValue = value) {
    return new Uint8Array([ ...le32(value), ...be32(beValue) ]);
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));

    for (let i = 0, at = 0; i < parts.length; i += 1) {
        out.set(parts[i], at);
        at += parts[i].length;
    }

    return out;
}

function pad(text, width) {
    const out = new Uint8Array(width);

    out.fill(0x20);
    out.set(bytesOf(text));

    return out;
}

class Image {
    /** @param stride 2048 for a plain ISO, 2352 to wrap every sector in a raw frame. */
    constructor({ stride = SECTOR, mode = 1 } = {}) {
        this.stride = stride;
        this.mode = mode;
        this.sectors = [];                                  // index === sector number
    }

    ensure(sector) {
        for (let i = this.sectors.length; i <= sector; i += 1) {
            this.sectors.push(null);
        }
    }

    put(sector, bytes) {
        this.ensure(sector);

        const data = new Uint8Array(SECTOR);

        data.set(bytes.subarray(0, Math.min(bytes.length, SECTOR)));
        this.sectors[sector] = data;

        return data;
    }

    /** Lay contents over whole sectors from `first`, returning the next free sector. */
    putFile(first, contents) {
        const bytes = contents instanceof Uint8Array ? contents : bytesOf(contents);

        if (bytes.length === 0) {
            return first;                                   // an empty file occupies nothing
        }

        for (let at = 0; at < bytes.length; at += SECTOR) {
            this.put(first + Math.floor(at / SECTOR), bytes.subarray(at, at + SECTOR));
        }

        return first + Math.ceil(bytes.length / SECTOR);
    }

    /** The volume size, stamped into both-endian copies at 80/84, ended by the terminator descriptor. */
    finish() {
        const frames = Math.max(this.sectors.length, 20);
        let last = 16;

        for (const descriptor of [ 16, 17 ]) {
            if (this.sectors[descriptor] === null) {
                continue;
            }
            last = descriptor;
            this.sectors[descriptor].set(le32(frames), 80);
            this.sectors[descriptor].set(be32(frames), 84);
        }

        // The terminator follows the descriptor set immediately - sector 18 on a real disc - rather than
        // sitting at the end of the volume, where it would overwrite a file.
        const terminator = this.put(last + 1, new Uint8Array(SECTOR));

        terminator[0] = 0xff;                               // 7.1.2: type 255 ends the descriptor set
        terminator.set(bytesOf("CD001"), 1);

        return frames;
    }

    toUint8Array() {
        const frames = Math.max(this.sectors.length, 18);

        this.ensure(frames - 1);

        if (this.stride === SECTOR) {
            const out = new Uint8Array(frames * SECTOR);

            for (let sector = 0; sector < frames; sector += 1) {
                if (this.sectors[sector] !== null) {
                    out.set(this.sectors[sector], sector * SECTOR);
                }
            }

            return out;
        }

        const out = new Uint8Array(frames * this.stride);
        const header = this.mode === 1 ? 16 : 24;

        for (let sector = 0; sector < frames; sector += 1) {
            const base = sector * this.stride;

            out.set(FRAME_SYNC, base);
            out[base + 12] = Math.floor(sector / 3600) & 0xff;   // MSF address
            out[base + 13] = Math.floor(sector / 60) % 60;
            out[base + 14] = sector % 60;
            out[base + 15] = this.mode;                          // control: bits 0-1 name the sector mode
            if (this.mode === 2) {
                out[base + 16] = 0;                              // form 1: both file/record numbers zero
                out[base + 17] = 0;
            }
            if (this.sectors[sector] !== null) {
                out.set(this.sectors[sector], base + header);
            }
        }

        return out;
    }
}

function volumeDescriptor({ type, rootLba, rootSize, escapeSequence = null }) {
    const sector = new Uint8Array(SECTOR);

    sector[0] = type;
    sector.set(bytesOf("CD001"), 1);
    sector[6] = 1;                                            // file structure version
    sector.set(pad("TESTVOLUME", 32), 40);                    // volume identifier, space-padded
    sector.set([ 1, 0, 0, 1 ], 120);                          // volume set size, both-endian
    sector[128] = SECTOR & 0xff;                              // logical block size, little-endian
    sector[129] = SECTOR >> 8;
    sector[130] = 0;
    sector[131] = 0;
    sector.set(le32(1), 132);                                 // path table size (the reader ignores tables)

    if (escapeSequence !== null) {
        sector.set(escapeSequence, 88);                       // Joliet announces UCS-2 levelling here
    }

    // The root directory record, at the descriptor's own offset 156.
    sector[156] = 34;
    sector.set(pair(rootLba), 158);
    sector.set(pair(rootSize), 166);
    sector.set([ 0x60, 1, 1, 1, 0, 0, 0 ], 174);              // 1996-01-01 01:00:00, GMT
    sector[181] = 0x02;                                       // a directory
    sector.set([ 1, 0, 0, 1 ], 184);                          // volume sequence number, both-endian
    sector[188] = 1;                                          // the root's one-byte identifier
    sector[189] = 0;

    return sector;
}

/**
 * One ECMA-119 9.1 directory record.
 *
 * `fileIdentifier` overrides the identifier bytes - a Joliet record holds big-endian UCS-2 there, and Rock
 * Ridge records keep the plain ISO identifier alongside the rename.
 */
function dirRecord({ lba, size, identifier = "", fileIdentifier = null, directory = false, flags = 0,
                     multiExtent = false, susp = null, unit = 0, gap = 0 }) {
    const name = fileIdentifier instanceof Uint8Array ? fileIdentifier : bytesOf(identifier);
    // ECMA-119 9.1 pads the identifier so the identifier field ends even: 33 + length is odd when the
    // length is even, which is the case that needs the pad byte.
    const header = 33 + name.length + (name.length & 1 ? 0 : 1);
    const record = new Uint8Array(header + (susp === null ? 0 : susp.length));

    record[0] = record.length;                                // the length byte counts the System Use area
    record[1] = 0;
    record.set(pair(lba), 2);
    record.set(pair(size), 10);
    record.set([ 0x60, 1, 1, 1, 0, 0, 0 ], 18);
    record[25] = flags | (directory ? 0x02 : 0) | (multiExtent ? 0x20 : 0);
    record[26] = unit;
    record[27] = gap;
    record.set([ 1, 0, 0, 1 ], 28);
    record[32] = name.length;
    record.set(name, 33);

    if (susp !== null) {
        record.set(susp, header);
    }

    return record;
}

/** '.' and '..', which every real directory carries (ECMA-119 9.1: the single bytes 0x00 and 0x01). */
function selfRecord(lba, size, susp = null) {
    return dirRecord({ lba, size, fileIdentifier: new Uint8Array([ 0 ]), directory: true, susp });
}

function parentRecord(lba, size) {
    return dirRecord({ lba, size, fileIdentifier: new Uint8Array([ 1 ]), directory: true });
}

/** Pack records into sectors; a record never straddles a sector, so a short tail is left as padding. */
function directorySectors(lba, records, sectorCount = 1) {
    const sectors = new Map();

    for (let i = 0; i < sectorCount; i += 1) {
        sectors.set(lba + i, new Uint8Array(SECTOR));
    }

    let sector = 0;
    let at = 0;

    for (const record of records) {
        if (at + record.length > SECTOR) {
            sector += 1;
            at = 0;

            if (!sectors.has(lba + sector)) {
                sectors.set(lba + sector, new Uint8Array(SECTOR));
            }
        }
        sectors.get(lba + sector).set(record, at);
        at += record.length;
    }

    return sectors;
}

/**
 * Write a one-level tree: the root directory at `firstFree`, then one extent per subdirectory.
 *
 * `files` become records in the root; `directories` become subdirectories whose `records` are placed in
 * their own extent. Returns where the root landed, which is what the primary descriptor must name.
 */
function writeTree(image, { rootSusp = null, files = [], directories = [], firstFree }) {
    const rootLba = firstFree;
    let next = firstFree + 1;
    const layout = [];

    for (const directory of directories) {
        if (directory.stubTo !== undefined) {
            // A CL record naming a sector the caller placed by hand; nothing is allocated or written, so
            // the test decides whether that sector holds a directory, garbage, or is left as padding.
            layout.push({ directory, lba: directory.stubTo, sectors: 0 });
            continue;
        }

        const lba = next;
        const sectors = directory.sectors ?? 1;

        next += sectors;
        layout.push({ directory, lba, sectors });
    }

    // A relocated directory (`relocated: true`) is listed in its parent as a stub whose own location
    // fields the writer zeroed - pycdlib does exactly this - with a CL record carrying the sector that
    // really holds the records. That is Rock Ridge 1.12 4.8, and it is how a directory deeper than the
    // eight levels ECMA-119 6.4 allows still gets a name in the tree it was moved to.

    const rootRecords = [ selfRecord(rootLba, SECTOR, rootSusp) ];

    for (const file of files) {
        rootRecords.push(dirRecord({
            lba: file.lba,
            size: file.size,
            identifier: file.name,
            fileIdentifier: file.fileIdentifier ?? null,
            directory: file.directory === true,
            susp: file.susp ?? null,
            flags: file.flags ?? 0,
            unit: file.unit ?? 0,
            gap: file.gap ?? 0,
            multiExtent: file.multiExtent ?? false,
        }));
    }

    for (const { directory, lba, sectors } of layout) {
        const relocated = directory.relocated === true || directory.stubTo !== undefined;

        rootRecords.push(dirRecord({
            lba: relocated ? 0 : lba,
            size: relocated ? 0 : sectors * SECTOR,
            identifier: directory.name,
            fileIdentifier: directory.fileIdentifier ?? null,
            directory: true,
            susp: concat(directory.susp ?? new Uint8Array(0), relocated ? suspRecord("CL", pair(lba)) : new Uint8Array(0)),
        }));
    }

    for (const [ sector, bytes ] of directorySectors(rootLba, rootRecords)) {
        image.put(sector, bytes);
    }

    for (const { directory, lba, sectors } of layout) {
        if (sectors === 0) {
            continue;                              // the CL target is the caller's to write, or to leave empty
        }

        const records = [ selfRecord(lba, sectors * SECTOR), parentRecord(rootLba, SECTOR), ...(directory.records ?? []) ];

        for (const [ sector, bytes ] of directorySectors(lba, records, sectors)) {
            image.put(sector, bytes);
        }
    }

    return { rootLba, nextSector: next };
}

function primaryDescriptor(rootLba, rootSize = SECTOR) {
    return volumeDescriptor({ type: 1, rootLba, rootSize });
}

// Rock Ridge sharing-protocol records: tag(2), length(1), version(1), payload. The reader's `data` view
// of an entry starts at payload[0].
function suspRecord(tag, payload) {
    const body = new Uint8Array(4 + payload.length);

    body[0] = tag.charCodeAt(0);
    body[1] = tag.charCodeAt(1);
    body[2] = body.length;
    body[3] = 1;
    body.set(payload, 4);

    return body;
}

/**
 * Rock Ridge's alternate-name record, in either of the two layouts readers meet.
 *
 * 'flags' is pycdlib's and the Linux kernel's: one control byte, then the name. 'bare' is genisoimage's:
 * the name immediately after the sharing-protocol header. The module has to tell them apart by content.
 */
function nmRecord(name, style = "flags") {
    const text = bytesOf(name);

    return suspRecord("NM", style === "bare" ? text : concat(new Uint8Array([ 0 ]), text));
}

function suspHeader({ erId = "RRIP_1991A" } = {}) {
    const id = bytesOf(erId);
    const er = new Uint8Array(4 + id.length);

    er[0] = id.length;                                        // extension identifier length
    er[1] = 0;                                                // descriptive text length
    er[2] = 0;                                                // source file length
    er[3] = 1;                                                // extension version
    er.set(id, 4);

    return concat(suspRecord("SP", bytesOf("BEA\x00")), suspRecord("ER", er));
}

function ceRecord({ lba, offset, length, mismatch = false }) {
    return suspRecord("CE", concat(pair(lba), pair(offset), pair(length, mismatch ? length ^ 0xffff : length)));
}

/** A plain ISO-9660 image with one small file - the fixture reused by the tests that only need a volume. */
function oneFileImage(options = {}) {
    const image = new Image(options);

    image.put(16, primaryDescriptor(20));
    writeTree(image, { files: [ { name: "HELLO.TXT;1", lba: 22, size: 13 } ], firstFree: 20 });
    image.putFile(22, "hello, sector");
    image.finish();

    return image;
}

function source(bytes) {
    return { size: bytes.length, read: async(offset, length) => bytes.subarray(offset, offset + length) };
}

// ---------------------------------------------------------------------------
// Tiny runner: no dependency, and a skipped group cannot be mistaken for a passing one.
// ---------------------------------------------------------------------------

const results = [];
const notes = [];
let group = "(none)";

function describe(name, body) {
    group = name;
    body();
}

function test(name, body, skipNote = null) {
    results.push({ group, name, body, skipNote });
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function deepEqual(actual, expected, message = "") {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);

    if (a !== b) {
        throw new Error(`${message ? message + "\n" : ""}actual   ${a}\nexpected ${b}`);
    }
}

async function assertThrows(body, code, label) {
    try {
        await body();
    }
    catch (error) {
        assert(error instanceof Iso9660Error, `${label}: expected an Iso9660Error, got ${error.name}: ${error.message}`);
        assert(error.code === code, `${label}: expected code '${code}', got '${error.code}' (${error.message})`);
        return error;
    }

    throw new Error(`${label}: expected a rejection with code '${code}', nothing was thrown`);
}

// ---------------------------------------------------------------------------
// 1. Synthetic images. No game data involved.
// ---------------------------------------------------------------------------

describe("volume descriptors", () => {
    test("reads a plain ISO and reports the geometry it detected", async() => {
        const iso = await Iso9660.open(source(oneFileImage().toUint8Array()));

        assert(iso.sectorStride === 2048, `stride should be 2048, got ${iso.sectorStride}`);
        assert(iso.sectorHeader === 0, `user data should start at 0, got ${iso.sectorHeader}`);
        assert(iso.volumeId === "TESTVOLUME", `the padding should be trimmed, got '${iso.volumeId}'`);
        assert(iso.logicalBlockSize === 2048, "block size should be 2048");
        assert(iso.rockRidge === false, "no Rock Ridge was written");
        assert(iso.joliet === false, "no Joliet was written");
        assert(iso.nameSource === "iso-9660", `name source should be iso-9660, got ${iso.nameSource}`);
        assert(iso.rootDirectory.lba === 20, `root should be at 20, got ${iso.rootDirectory.lba}`);
        deepEqual(iso.list().map(e => [ e.path, e.size, e.lba, e.length, e.version ]), [ [ "HELLO.TXT", 13, 22, 13, 1 ] ]);

        const text = new TextDecoder().decode(await (await iso.read("HELLO.TXT")).arrayBuffer());

        assert(text === "hello, sector", `contents should round-trip, got '${text}'`);
    });

    test("accepts a raw 2352-byte mode 1 image as the same volume", async() => {
        const iso = await Iso9660.open(source(oneFileImage({ stride: RAW }).toUint8Array()));

        assert(iso.sectorStride === 2352, `stride should be 2352, got ${iso.sectorStride}`);
        assert(iso.sectorHeader === 16, `mode 1 user data starts at 16, got ${iso.sectorHeader}`);
        deepEqual(iso.list().map(e => [ e.path, e.size ]), [ [ "HELLO.TXT", 13 ] ]);

        const text = new TextDecoder().decode(await (await iso.read("HELLO.TXT")).arrayBuffer());

        assert(text === "hello, sector", `raw decoding should match the plain image, got '${text}'`);
    });

    test("reads a raw mode 2 form 1 image, cutting the 24-byte XA header", async() => {
        const iso = await Iso9660.open(source(oneFileImage({ stride: RAW, mode: 2 }).toUint8Array()));

        assert(iso.sectorStride === 2352, `stride should be 2352, got ${iso.sectorStride}`);
        assert(iso.sectorHeader === 24, `mode 2 form 1 user data starts at 24, got ${iso.sectorHeader}`);

        const text = new TextDecoder().decode(await (await iso.read("HELLO.TXT")).arrayBuffer());

        assert(text === "hello, sector", `mode 2 decoding should match, got '${text}'`);
    });

    test("stops at the terminator and tolerates descriptors it ignores", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        // A supplementary descriptor with no escape sequence is some other extension, not Joliet, and a
        // second primary is noise: neither may be taken for the volume or reported as damage.
        image.put(17, volumeDescriptor({ type: 2, rootLba: 40, rootSize: SECTOR }));
        writeTree(image, { files: [ { name: "HELLO.TXT;1", lba: 22, size: 13 } ], firstFree: 20 });
        image.putFile(22, "hello, sector");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        assert(iso.joliet === false, "a supplementary descriptor without the escape sequence is not Joliet");
        deepEqual(iso.list().map(e => e.path), [ "HELLO.TXT" ]);
    });

    test("refuses an image with no volume descriptor", async() => {
        await assertThrows(() => Iso9660.open(source(new Uint8Array(64 * SECTOR))), "no-volume-descriptor", "all-zero image");
    });

    test("refuses a descriptor that claims a block size other than 2048", async() => {
        const image = oneFileImage();

        image.sectors[16][128] = 0x00;
        image.sectors[16][129] = 4;                      // 1024

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "block-size", "1024-byte blocks");
    });

    test("refuses a volume whose two size copies disagree", async() => {
        const image = oneFileImage();

        image.sectors[16].set(pair(image.sectors.length, 99), 80);

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "endian-mismatch", "volume size copies");
    });

    test("refuses an image shorter than the volume it describes", async() => {
        const image = oneFileImage({ stride: RAW });
        const bytes = image.toUint8Array();

        await assertThrows(() => Iso9660.open(source(bytes.subarray(0, bytes.length - 4 * RAW))), "torn-image", "truncated tail");
    });

    test("refuses raw frames whose sync pattern is missing", async() => {
        const image = oneFileImage({ stride: RAW });
        const bytes = image.toUint8Array();
        const frames = Math.floor(bytes.length / RAW);

        bytes[(frames - 1) * RAW] = 0x11;                // the last frame is one of the sampled ones

        await assertThrows(() => Iso9660.open(source(bytes)), "no-volume-descriptor", "sync sampled across the image");
    });
});

describe("directory records", () => {
    test("walks subdirectories and lists paths with the image's own letter case", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [
                { name: "TOP.TXT;1", lba: 28, size: 3 },
                // A directory record whose extent is empty is an empty directory, not damage: the reader
                // must not read a sector of padding and report whatever it happens to hold.
                { name: "BARE;1", lba: 0, size: 0, directory: true },
            ],
            directories: [ {
                name: "SUB;1",
                records: [
                    dirRecord({ lba: 30, size: 5, identifier: "INSIDE.TXT;2" }),
                    dirRecord({ lba: 26, size: 0, identifier: "EMPTY.BIN;1" }),
                ],
            } ],
            firstFree: 20,
        });
        image.putFile(26, "");
        image.putFile(28, "abc");
        image.putFile(30, "inner");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => [ e.path, e.size, e.version ]), [
            [ "SUB/EMPTY.BIN", 0, 1 ],
            [ "SUB/INSIDE.TXT", 5, 2 ],
            [ "TOP.TXT", 3, 1 ],
        ]);
        deepEqual(iso.list("sub/").map(e => e.path), [ "SUB/EMPTY.BIN", "SUB/INSIDE.TXT" ], "a lowercase prefix still finds the uppercase tree");
        deepEqual(iso.list("/SUB/INSIDE.TXT").map(e => e.path), [ "SUB/INSIDE.TXT" ]);
        deepEqual(iso.list("/sub/inside.txt").map(e => e.path), [ "SUB/INSIDE.TXT" ], "read()'s path lookup folds case too");
        assert(iso.list("nope").length === 0, "an unmatched prefix lists nothing");
        // The empty directory holds nothing, so it contributes no file entries - and no complaint either,
        // because a zero-length extent is a legitimate shape rather than damage.
        assert(iso.list("BARE").length === 0 && iso.skipped.length === 0,
            `an empty directory is neither listed nor complained about, got ${JSON.stringify(iso.skipped)}`);

        const inside = new TextDecoder().decode(await (await iso.read("SUB/INSIDE.TXT")).arrayBuffer());

        assert(inside === "inner", `nested contents should read back, got '${inside}'`);
        assert((await iso.read("SUB/EMPTY.BIN")).size === 0, "an empty file reads as empty");
    });

    test("trims the level-1 padding dot but keeps a name's own semicolon", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [ { name: "ODD;NAME;1", lba: 28, size: 3 }, { name: "NOEXT.;1", lba: 29, size: 3 } ],
            firstFree: 20,
        });
        image.putFile(28, "abc");
        image.putFile(29, "def");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ "NOEXT", "ODD;NAME" ], "only the version suffix and a padding dot go");
    });

    test("restarts on the sector boundary when a record is zero-padded", async() => {
        // The classic trap: a record is skipped by writing a zero length byte, and the rest of THAT SECTOR
        // is padding. A cursor that adds the zero instead of rounding up reads the following zeros as
        // entries, inventing files that are not there.
        const image = new Image();

        image.put(16, primaryDescriptor(20, SECTOR * 2));   // the root's extent is two sectors wide

        const first = dirRecord({ lba: 28, size: 3, identifier: "FIRST.TXT;1" });
        const second = dirRecord({ lba: 29, size: 4, identifier: "SECOND.TXT;1" });
        const rootFirst = new Uint8Array(SECTOR);
        const rootSecond = new Uint8Array(SECTOR);

        rootFirst.set(selfRecord(20, SECTOR * 2), 0);
        rootFirst.set(first, 34);
        rootFirst[34 + first.length] = 0;                // skip the remainder of the first sector
        rootSecond.set(second, 0);                       // the real record starts on the next boundary
        image.put(20, rootFirst);
        image.put(21, rootSecond);
        image.putFile(28, "abc");
        image.putFile(29, "wxyz");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => [ e.path, e.size ]), [ [ "FIRST.TXT", 3 ], [ "SECOND.TXT", 4 ] ]);
    });

    test("follows a multi-extent file and reports its ranges", async() => {
        const image = new Image();
        const chunkA = new Uint8Array(SECTOR * 2).fill(0x41);
        const chunkB = new Uint8Array(1000).fill(0x42);

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [ { name: "BIG.BIN;1", lba: 24, size: chunkA.length, multiExtent: true } ],
            firstFree: 20,
        });

        // The run's closing record: the same identifier, the flag clear, contributing the last part.
        const rootSector = image.sectors[20];
        let at = 34;

        while (rootSector[at] !== 0 && at < SECTOR) {
            at += rootSector[at];
        }
        rootSector.set(dirRecord({ lba: 26, size: chunkB.length, identifier: "BIG.BIN;1" }), at);

        image.putFile(24, chunkA);
        image.putFile(26, chunkB);
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));
        const entry = iso.list()[0];

        assert(entry.size === chunkA.length + chunkB.length, `size should span both records, got ${entry.size}`);
        assert(entry.multiExtent === true, "the entry should be marked multi-extent");
        assert(entry.length === entry.size, "`length` should be the whole file");
        // The two records describe neighbouring sectors, so they collapse to one range the reader sweeps.
        deepEqual(entry.extents.map(e => [ e.lba, e.length ]), [ [ 24, chunkA.length + chunkB.length ] ]);

        const data = new Uint8Array(await (await iso.read(entry)).arrayBuffer());

        assert(data.length === chunkA.length + chunkB.length, `read back ${data.length}, expected ${chunkA.length + chunkB.length}`);
        assert(data[0] === 0x41 && data[chunkA.length - 1] === 0x41, "the first record's bytes should be intact");
        assert(data[chunkA.length] === 0x42 && data[data.length - 1] === 0x42, "the second should follow immediately");
    });

    test("refuses a multi-extent run whose flag never clears", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, { files: [ { name: "HANG.BIN;1", lba: 24, size: SECTOR, multiExtent: true } ], firstFree: 20 });
        image.putFile(24, new Uint8Array(SECTOR));
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "broken-multi-extent", "run with no end");
    });

    test("refuses a multi-extent run broken by another name", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [ { name: "HANG.BIN;1", lba: 24, size: SECTOR, multiExtent: true }, { name: "OTHER.TXT;1", lba: 26, size: 3 } ],
            firstFree: 20,
        });
        image.putFile(24, new Uint8Array(SECTOR));
        image.putFile(26, "abc");
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "broken-multi-extent", "run interrupted");
    });

    test("refuses a multi-extent run whose records are not neighbours", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, { files: [ { name: "SCATTER.BIN;1", lba: 24, size: SECTOR, multiExtent: true } ], firstFree: 20 });

        const rootSector = image.sectors[20];
        let at = 34;

        while (rootSector[at] !== 0 && at < SECTOR) {
            at += rootSector[at];
        }
        // The continuation names a sector with a hole before it: no directory record can say what fills it.
        rootSector.set(dirRecord({ lba: 30, size: 500, identifier: "SCATTER.BIN;1" }), at);
        image.putFile(24, new Uint8Array(SECTOR));
        image.putFile(30, new Uint8Array(500));
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "scattered-extent", "gap between extents");
    });

    test("refuses an interleaved file rather than returning striped bytes", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [ { name: "STRIPED.BIN;1", lba: 24, size: 20, unit: 2, gap: 3 } ],
            firstFree: 20,
        });
        image.putFile(24, "interleaved contents");
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "interleaved", "file unit and gap set");
    });

    test("refuses an extent that runs past the volume", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, { files: [ { name: "OVER.TXT;1", lba: 22, size: 4000 } ], firstFree: 20 });
        image.putFile(22, new Uint8Array(4000));

        const frames = image.finish();

        image.sectors[16].set(pair(frames - 5), 80);        // claim a shorter volume than the records say

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "extent-out-of-range", "extent past the volume");
    });

    test("refuses a record whose two endianness copies disagree", async() => {
        const image = oneFileImage();
        const record = image.sectors[20];
        const at = 34;                                      // the first entry, after the 34-byte '.'

        record[at + 6] ^= 0xff;                             // corrupt only the big-endian location

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "endian-mismatch", "extent copies");
    });
});

describe("Rock Ridge", () => {
    test("recovers mixed-case names, and knows it is reading Rock Ridge", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            // The root's own '.' record is where real images announce the extension.
            rootSusp: suspHeader(),
            files: [ { name: "MIXEDCASEALPHA;1", lba: 24, size: 13, susp: nmRecord("MixedCaseAlpha.dat") } ],
            directories: [ {
                name: "SUB;1",
                susp: nmRecord("SubDirMixed"),
                records: [ dirRecord({ lba: 30, size: 5, identifier: "GAMMA;1", susp: nmRecord("gamma.inside.dat") }) ],
            } ],
            firstFree: 20,
        });
        image.putFile(24, "alpha payload");
        image.putFile(30, "inner");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        assert(iso.rockRidge === true, "SP plus ER in the root should turn Rock Ridge on");
        assert(iso.nameSource === "rock-ridge", `name source should be rock-ridge, got ${iso.nameSource}`);
        deepEqual(iso.rockRidgeExtensions, [ "RRIP_1991A" ]);
        deepEqual(iso.list().map(e => e.path), [ "MixedCaseAlpha.dat", "SubDirMixed/gamma.inside.dat" ]);
        deepEqual(iso.list().map(e => e.version), [ 1, 1 ], "the rename should not lose the version");
    });

    test("reads names written without the control byte, as genisoimage does", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            rootSusp: suspHeader(),
            files: [ { name: "BARENAME;1", lba: 24, size: 3, susp: nmRecord("RealName.bin", "bare") } ],
            firstFree: 20,
        });
        image.putFile(24, "abc");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ "RealName.bin" ], "a recovered name must not gain a leading NUL");
    });

    test("assembles a name split across a continuation area", async() => {
        const image = new Image();
        const longName = "ThisNameIsLongEnoughToNeedAContinuationEntry.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
        const continuationLba = 40;

        image.put(16, primaryDescriptor(20));
        image.put(continuationLba, new Uint8Array(SECTOR));

        // The first fragment has to fit the directory record; CE then points at the sector holding the rest.
        const head = longName.slice(0, 60);
        const tail = longName.slice(60);
        const tailRecord = nmRecord(tail);

        image.sectors[continuationLba].set(tailRecord, 0);

        writeTree(image, {
            rootSusp: suspHeader(),
            files: [ {
                name: "LONGNAME;1",
                lba: 24,
                size: 3,
                susp: concat(nmRecord(head), ceRecord({ lba: continuationLba, offset: 0, length: tailRecord.length })),
            } ],
            firstFree: 20,
        });
        image.putFile(24, "abc");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ longName ], "the fragments should be concatenated in order");
    });

    test("refuses a CE record that asks for no bytes", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            rootSusp: suspHeader(),
            files: [ { name: "CE.TXT;1", lba: 24, size: 3, susp: ceRecord({ lba: 24, offset: 0, length: 0 }) } ],
            firstFree: 20,
        });
        image.putFile(24, "abc");
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "bad-continuation", "zero-length continuation");
    });

    test("refuses a CE record whose copies disagree", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            rootSusp: suspHeader(),
            files: [ { name: "CE.TXT;1", lba: 24, size: 3, susp: ceRecord({ lba: 40, offset: 0, length: 20, mismatch: true }) } ],
            firstFree: 20,
        });
        image.putFile(24, "abc");
        image.finish();

        await assertThrows(() => Iso9660.open(source(image.toUint8Array())), "endian-mismatch", "CE copies");
    });

    test("follows a child link to the extent that really holds the directory", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        image.putFile(30, "inner");

        writeTree(image, {
            rootSusp: suspHeader(),
            // A relocated directory: the record in the parent is a stub whose own location fields the
            // writer zeroed, and CL carries the sector that really holds the records. `relocated` makes
            // the builder emit exactly that, so the byte offsets stay the fixture's business.
            directories: [ {
                name: "MOVED;1",
                relocated: true,
                susp: nmRecord("MovedDir"),
                records: [ dirRecord({ lba: 30, size: 5, identifier: "REALEE.TXT;1" }) ],
            } ],
            firstFree: 20,
        });
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ "MovedDir/REALEE.TXT" ], "CL should decide which extent is walked");
        // The stub says zero bytes, so the size the walk used has to come from the record at CL's sector.
        const moved = iso.list("MovedDir/")[ 0 ];

        assert(moved.size === 5, `REALEE.TXT should be 5 bytes, got ${moved.size}`);
        assert((await iso.read("MovedDir/REALEE.TXT")).size === 5, "a file behind a child link reads whole");
    });

    test("reports a child link that leads nowhere instead of inventing a listing", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));

        writeTree(image, {
            rootSusp: suspHeader(),
            directories: [ { name: "GONE;1", stubTo: 13, susp: nmRecord("gone") } ],
            firstFree: 20,
        });
        // Sector 13 is inside the descriptor area and is never written, so it is all zeros: the record
        // there has length zero, which is padding, not a directory. The reader has to say so rather than
        // walk garbage and name a subtree that holds nothing.
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [], "nothing lives behind the dead link");
        deepEqual(iso.skipped.map(s => s.path), [ "gone" ], "the dead link is reported once");
        assert(/CL points at sector 13/.test(iso.skipped[ 0 ].reason),
            `reason should name the sector, got '${iso.skipped[ 0 ].reason}'`);
    });

    test("lists a relocated directory once, under the parent that received it", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        image.putFile(31, "payload");

        writeTree(image, {
            rootSusp: suspHeader(),
            // Rock Ridge 4.9/4.10: the old parent keeps a placeholder record tagged RE, and the new
            // parent lists the same directory with a CL pointing at its extent. One directory, two names
            // in two places; only the CL side is worth walking.
            files: [ {
                name: "OLD;1",
                lba: 0,
                size: 0,
                directory: true,
                susp: concat(nmRecord("OldHome"), suspRecord("RE", new Uint8Array(0))),
            } ],
            directories: [ {
                name: "NEW;1",
                relocated: true,
                susp: nmRecord("NewHome"),
                records: [ dirRecord({ lba: 31, size: 7, identifier: "DATA.BIN;1" }) ],
            } ],
            firstFree: 20,
        });
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ "NewHome/DATA.BIN" ], "the CL side is the one that gets walked");
        deepEqual(iso.skipped.map(s => s.path), [ "OldHome" ], "the hole is reported, not listed");
        assert(/RE/.test(iso.skipped[ 0 ].reason), `reason should name the record, got '${iso.skipped[ 0 ].reason}'`);
        assert((await iso.read("NewHome/DATA.BIN")).size === 7, "the file behind the child link reads whole");
    });

    test("skips symlinks and non-regular PF entries instead of reading their target text", async() => {
        const image = new Image();

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            rootSusp: suspHeader(),
            files: [
                { name: "LINK;1", lba: 24, size: 8, susp: concat(nmRecord("link"), suspRecord("SL", bytesOf("/TARGET"))) },
                { name: "FIFO;1", lba: 25, size: 0, susp: concat(nmRecord("pipe"), suspRecord("PF", concat(pair(0o010644), pair(1), pair(0), pair(0)))) },
                { name: "REAL.TXT;1", lba: 26, size: 3, susp: concat(nmRecord("real.txt"), suspRecord("PF", concat(pair(0o100644), pair(1), pair(0), pair(0)))) },
            ],
            firstFree: 20,
        });
        image.putFile(24, "/TARGET!");
        image.putFile(26, "abc");
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        deepEqual(iso.list().map(e => e.path), [ "real.txt" ], "only the regular file should survive");
        assert(iso.skipped.length === 2, `two entries should be explained, got ${JSON.stringify(iso.skipped)}`);
        assert(iso.skipped.some(s => /symbolic link/.test(s.reason)), "the symlink should say why it was skipped");
        assert(iso.skipped.some(s => /PF/.test(s.reason)), "the FIFO should say why it was skipped");
    });
});

describe("Joliet", () => {
    test("prefers the UCS-2 tree when both trees exist", async() => {
        const image = new Image();
        const isoRoot = 20;
        const jolietRoot = 24;

        image.put(16, primaryDescriptor(isoRoot));
        image.put(17, volumeDescriptor({ type: 2, rootLba: jolietRoot, rootSize: SECTOR, escapeSequence: bytesOf("%/E") }));
        writeTree(image, { files: [ { name: "ALPHA.TXT;1", lba: 30, size: 13 } ], firstFree: isoRoot });
        image.putFile(30, "alpha payload");

        // The Joliet tree spells the same file with characters ISO-9660 cannot express.
        const ucs2 = text => {
            const out = new Uint8Array(text.length * 2);

            for (let i = 0; i < text.length; i += 1) {
                out[i * 2] = text.charCodeAt(i) >> 8;       // big-endian, the Joliet convention
                out[i * 2 + 1] = text.charCodeAt(i) & 0xff;
            }

            return out;
        };

        for (const [ sector, bytes ] of directorySectors(jolietRoot, [
            selfRecord(jolietRoot, SECTOR),
            dirRecord({ lba: 30, size: 13, fileIdentifier: ucs2("\u03b1\u03bb\u03c6\u03b1.TXT;1") }),
        ])) {
            image.put(sector, bytes);
        }
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));

        assert(iso.joliet === true, "the escape sequence should identify Joliet");
        assert(iso.nameSource === "joliet", `name source should be joliet, got ${iso.nameSource}`);
        deepEqual(iso.list().map(e => [ e.path, e.version ]), [ [ "\u03b1\u03bb\u03c6\u03b1.TXT", 1 ] ]);
    });
});

describe("reading files", () => {
    test("cuts the tail of the last sector so the next file does not ride along", async() => {
        const image = new Image();
        const payload = new Uint8Array(SECTOR + 5).fill(0x55);

        image.put(16, primaryDescriptor(20));
        writeTree(image, {
            files: [ { name: "ONE.BIN;1", lba: 22, size: SECTOR + 5 }, { name: "TWO.BIN;1", lba: 24, size: 3 } ],
            firstFree: 20,
        });
        image.putFile(22, payload);
        image.put(24, new Uint8Array(SECTOR).fill(0xaa));   // the neighbour's first sector
        image.finish();

        const iso = await Iso9660.open(source(image.toUint8Array()));
        const blob = await iso.read("ONE.BIN");

        assert(blob.size === SECTOR + 5, `one file should be ${SECTOR + 5} bytes, got ${blob.size}`);

        const bytes = new Uint8Array(await blob.arrayBuffer());

        assert(bytes[bytes.length - 1] === 0x55, "the last byte read should still belong to the file");
    });

    test("refuses to read a path the volume does not list", async() => {
        const iso = await Iso9660.open(source(oneFileImage().toUint8Array()));

        await assertThrows(() => iso.read("MISSING.TXT"), "no-such-file", "unknown path");
        await assertThrows(() => iso.read({ path: "HELLO.TXT" }), "bad-entry", "a hand-made object");
    });

    test("hands out entries the caller cannot mutate", async() => {
        const iso = await Iso9660.open(source(oneFileImage().toUint8Array()));
        const entry = iso.list()[0];

        assert(Object.isFrozen(entry), "entries should be frozen");
        assert(Object.isFrozen(entry.extents), "the extent list should be frozen");
        assert(Object.isFrozen(entry.extents[0]), "each extent should be frozen");
        assert(entry.length === entry.size, "`length` should be the total over all extents");
        assert(iso.list() !== iso.list(), "each listing is a fresh array, so a caller cannot poison the volume");
    });

    test("accepts a Uint8Array, a Blob and a custom reader alike", async() => {
        const bytes = oneFileImage().toUint8Array();
        const opened = [
            [ "typed array", await Iso9660.open(bytes) ],
            [ "blob", await Iso9660.open(new Blob([ bytes ])) ],
            [ "custom reader", await Iso9660.open({ size: bytes.length, read: async(offset, length) => bytes.subarray(offset, offset + length) }) ],
        ];

        for (const [ label, iso ] of opened) {
            const data = await (await iso.read("HELLO.TXT")).arrayBuffer();

            assert(new TextDecoder().decode(data) === "hello, sector", `${label} should read the same bytes`);
        }

        // A reader that hands back fewer bytes than were asked for is a broken source, not an ISO with an
        // unusual layout, so the complaint names the source: 'short-read' points at the caller's reader.
        await assertThrows(() => Iso9660.open({ read: async() => new Uint8Array(0) }), "short-read", "a reader that returns nothing");
        // Bytes that hold no 'CD001' anywhere in the window are what 'no-volume-descriptor' is for.
        await assertThrows(() => Iso9660.open(new Uint8Array(64 * 1024).fill(0x5a)), "no-volume-descriptor", "a filler-only image");
        await assertThrows(() => Iso9660.open(42), "bad-source", "a number");
    });
});

describe("unreadable sector shapes", () => {
    test("refuses mode 2 sectors that are not form 1", async() => {
        const image = oneFileImage({ stride: RAW, mode: 2 });
        const bytes = image.toUint8Array();

        bytes[22 * RAW + 16] = 1;                          // a non-zero file number means XA form 2

        const iso = await Iso9660.open(source(bytes));

        await assertThrows(() => iso.read("HELLO.TXT"), "mode2-form2", "form 2 payload is 2324 bytes, not 2048");
    });

    test("refuses a sector with no user data at all", async() => {
        const image = oneFileImage({ stride: RAW });
        const bytes = image.toUint8Array();

        bytes[22 * RAW + 15] = 0x11;                       // mode 1, but flagged blank

        const iso = await Iso9660.open(source(bytes));

        await assertThrows(() => iso.read("HELLO.TXT"), "bad-block-type", "blank sector");
    });
});

// ---------------------------------------------------------------------------
// 2. The real GOG image, skipped cleanly when the data is not here.
//
// Expected values are the listing and hashes taken from the GOG installer with innoextract plus bsdtar,
// exactly as script/homm2/extract_homm2_resources.sh does it:
//
//   innoextract -e -s -m -d /tmp/fh2anim -I 'homm2.gog' <installer>
//   # 2352 -> 2048: buf[15] == 2 ? buf[24:2072] : buf[16:2064]
//   bsdtar -x -f image.iso --include 'HEROES2/ANIM/*' --strip-components=2
//
// 178 .SMK files, 163 MiB.
// ---------------------------------------------------------------------------

const ANIM_SIZES = [
    [ "CHOOSE.SMK", 1742576 ],
    [ "CHOOSEW.SMK", 22972 ],
    [ "CREDITS.SMK", 332036 ],
    [ "CYBCREDS.SMK", 775348 ],
    [ "CYLOGO.SMK", 790008 ],
    [ "DEFEAT.SMK", 1035564 ],
    [ "DES10.SMK", 1541524 ],
    [ "DES11.SMK", 1126408 ],
    [ "DES12.SMK", 1135200 ],
    [ "DES13.SMK", 1167364 ],
    [ "DES14.SMK", 1082064 ],
    [ "DES15.SMK", 1082072 ],
    [ "DES9.SMK", 914564 ],
    [ "EARTH.SMK", 1529628 ],
    [ "EVIL01.SMK", 345268 ],
    [ "EVIL01V.SMK", 648820 ],
    [ "EVIL02.SMK", 564136 ],
    [ "EVIL02W.SMK", 601272 ],
    [ "EVIL03QW.SMK", 472892 ],
    [ "EVIL03.SMK", 2021360 ],
    [ "EVIL05AV.SMK", 1902796 ],
    [ "EVIL05BV.SMK", 3002644 ],
    [ "EVIL05.SMK", 155000 ],
    [ "EVIL06AW.SMK", 539096 ],
    [ "EVIL06BW.SMK", 407016 ],
    [ "EVIL06.SMK", 888488 ],
    [ "EVIL07.SMK", 1109692 ],
    [ "EVIL07W.SMK", 514444 ],
    [ "EVIL08.SMK", 4271016 ],
    [ "EVIL09.SMK", 965888 ],
    [ "EVIL09W.SMK", 550304 ],
    [ "EVIL10.SMK", 546804 ],
    [ "EVIL11W.SMK", 376252 ],
    [ "GOOD01.SMK", 228156 ],
    [ "GOOD01V.SMK", 1649372 ],
    [ "GOOD02.SMK", 409872 ],
    [ "GOOD02W.SMK", 783336 ],
    [ "GOOD03QW.SMK", 775660 ],
    [ "GOOD03.SMK", 940348 ],
    [ "GOOD04.SMK", 1005756 ],
    [ "GOOD04W.SMK", 325760 ],
    [ "GOOD05.SMK", 155000 ],
    [ "GOOD05V.SMK", 2639972 ],
    [ "GOOD06AV.SMK", 1025824 ],
    [ "GOOD06BV.SMK", 906032 ],
    [ "GOOD06.SMK", 180688 ],
    [ "GOOD07QW.SMK", 462508 ],
    [ "GOOD07.SMK", 649872 ],
    [ "GOOD08.SMK", 1926792 ],
    [ "GOOD08W.SMK", 229544 ],
    [ "GOOD09.SMK", 510436 ],
    [ "GOOD09W.SMK", 565776 ],
    [ "GOOD10.SMK", 2828080 ],
    [ "GOOD10W.SMK", 589292 ],
    [ "H2INTRO.SMK", 2829540 ],
    [ "H2XINTRO.SMK", 2833376 ],
    [ "INTRO.SMK", 21067816 ],
    [ "IVYBACK.SMK", 142056 ],
    [ "IVYDES.SMK", 194808 ],
    [ "IVYPOL.SMK", 185696 ],
    [ "IVYVOY.SMK", 188080 ],
    [ "IVYWIZ.SMK", 151548 ],
    [ "LIBRARY.SMK", 695872 ],
    [ "LIBRARYW.SMK", 325672 ],
    [ "LOSE.SMK", 445112 ],
    [ "MIXDES10.SMK", 218736 ],
    [ "MIXDES11.SMK", 454056 ],
    [ "MIXDES12.SMK", 365300 ],
    [ "MIXDES13.SMK", 339224 ],
    [ "MIXDES14.SMK", 415672 ],
    [ "MIXDES15.SMK", 163496 ],
    [ "MIXDES9.SMK", 213264 ],
    [ "MIXPOL1.SMK", 335212 ],
    [ "MIXPOL2.SMK", 400920 ],
    [ "MIXPOL3.SMK", 426860 ],
    [ "MIXPOL4.SMK", 409772 ],
    [ "MIXPOL5.SMK", 288172 ],
    [ "MIXPOL6.SMK", 318140 ],
    [ "MIXPOL7.SMK", 330284 ],
    [ "MIXPOL8.SMK", 473804 ],
    [ "MIXVOY21.SMK", 200376 ],
    [ "MIXVOY22.SMK", 214120 ],
    [ "MIXVOY23.SMK", 374712 ],
    [ "MIXVOY24.SMK", 161348 ],
    [ "MIXVOY25.SMK", 146660 ],
    [ "MIXWIZ16.SMK", 386812 ],
    [ "MIXWIZ17.SMK", 331512 ],
    [ "MIXWIZ18.SMK", 369764 ],
    [ "MIXWIZ19.SMK", 181852 ],
    [ "MIXWIZ20.SMK", 242212 ],
    [ "MM6.SMK", 5314516 ],
    [ "NWCLOGO.SMK", 2195044 ],
    [ "POL1.SMK", 1134204 ],
    [ "POL2.SMK", 1094884 ],
    [ "POL3.SMK", 1138196 ],
    [ "POL4.SMK", 923372 ],
    [ "POL5.SMK", 1152840 ],
    [ "POL6.SMK", 1015304 ],
    [ "POL7.SMK", 950180 ],
    [ "POL8.SMK", 1128348 ],
    [ "PRISON.SMK", 7388460 ],
    [ "RBETRAYV.SMK", 1257804 ],
    [ "SBETRAYV.SMK", 355932 ],
    [ "SCHOOSE.SMK", 380272 ],
    [ "SCYBCRED.SMK", 573480 ],
    [ "SCYLOGO.SMK", 633120 ],
    [ "SDEFEAT.SMK", 565000 ],
    [ "SDES10.SMK", 999948 ],
    [ "SDES11.SMK", 635320 ],
    [ "SDES12.SMK", 655020 ],
    [ "SDES13.SMK", 667664 ],
    [ "SDES14.SMK", 609388 ],
    [ "SDES15.SMK", 642868 ],
    [ "SDES9.SMK", 499044 ],
    [ "SEVIL01.SMK", 173972 ],
    [ "SEVIL01V.SMK", 467652 ],
    [ "SEVIL02.SMK", 246356 ],
    [ "SEVIL03.SMK", 414728 ],
    [ "SEVIL05.SMK", 81768 ],
    [ "SEVIL06.SMK", 254640 ],
    [ "SEVIL07.SMK", 592208 ],
    [ "SEVIL08.SMK", 914904 ],
    [ "SEVIL09.SMK", 281524 ],
    [ "SEVIL10.SMK", 286736 ],
    [ "SEVIL5AV.SMK", 530216 ],
    [ "SEVIL5BV.SMK", 847724 ],
    [ "SGOOD01.SMK", 123148 ],
    [ "SGOOD01V.SMK", 751280 ],
    [ "SGOOD02.SMK", 222364 ],
    [ "SGOOD03.SMK", 319244 ],
    [ "SGOOD04.SMK", 283240 ],
    [ "SGOOD05.SMK", 81768 ],
    [ "SGOOD05V.SMK", 886604 ],
    [ "SGOOD06.SMK", 98244 ],
    [ "SGOOD07.SMK", 244348 ],
    [ "SGOOD08.SMK", 498956 ],
    [ "SGOOD09.SMK", 271668 ],
    [ "SGOOD10.SMK", 724316 ],
    [ "SGOOD6AV.SMK", 519188 ],
    [ "SGOOD6BV.SMK", 454404 ],
    [ "SH2INTRO.SMK", 497564 ],
    [ "SH2XINTR.SMK", 1809960 ],
    [ "SINTRO.SMK", 2904756 ],
    [ "SLIBRARY.SMK", 235280 ],
    [ "SLOSE.SMK", 246316 ],
    [ "SMM6.SMK", 2432448 ],
    [ "SNWCLOGO.SMK", 421996 ],
    [ "SPOL1.SMK", 667468 ],
    [ "SPOL2.SMK", 621932 ],
    [ "SPOL3.SMK", 652904 ],
    [ "SPOL4.SMK", 522352 ],
    [ "SPOL5.SMK", 663088 ],
    [ "SPOL6.SMK", 584932 ],
    [ "SPOL7.SMK", 562548 ],
    [ "SPOL8.SMK", 652212 ],
    [ "SPRISON.SMK", 1478352 ],
    [ "SVOY21.SMK", 714388 ],
    [ "SVOY22.SMK", 602684 ],
    [ "SVOY23.SMK", 1156792 ],
    [ "SVOY24.SMK", 1280020 ],
    [ "SVOY25.SMK", 554716 ],
    [ "SWINS.SMK", 700684 ],
    [ "SWIZ16.SMK", 598048 ],
    [ "SWIZ17.SMK", 614048 ],
    [ "SWIZ18.SMK", 512172 ],
    [ "SWIZ19.SMK", 640960 ],
    [ "SWIZ20.SMK", 494864 ],
    [ "VOY21.SMK", 1225136 ],
    [ "VOY22.SMK", 1091228 ],
    [ "VOY23.SMK", 1954264 ],
    [ "VOY24.SMK", 2095708 ],
    [ "VOY25.SMK", 849712 ],
    [ "WIN.SMK", 2534028 ],
    [ "WIZ16.SMK", 1047304 ],
    [ "WIZ17.SMK", 1054284 ],
    [ "WIZ18.SMK", 899888 ],
    [ "WIZ19.SMK", 1135764 ],
    [ "WIZ20.SMK", 852776 ],
];

const ANIM_HASHES = {
    "INTRO.SMK": "b49f276cd205ea28c41be817caa4a8496a89b313e153798a0c587f60b4069bb7",
    "PRISON.SMK": "820e20569235f5c8d4ba8ec4ed96492fad4bae7edaa4587707c3fceca654f93a",
    "MM6.SMK": "c394173d58eab4706e8f59e06de7dceee4215255d2b09258abdcc96208521c2f",
};

const PEAK_RSS_BUDGET_MB = 300;

/** Turn FH2_GOG into a readable source, extracting from the installer when that is what was given. */
function openRealImage() {
    const given = process.env.FH2_GOG;

    if (!given) {
        return { skip: "FH2_GOG is not set (point it at homm2.gog, or at the installer .exe)" };
    }

    const expanded = given.startsWith("~") ? path.join(os.homedir(), given.slice(1)) : given;

    if (!fs.existsSync(expanded)) {
        return { skip: `FH2_GOG points at '${expanded}', which does not exist` };
    }

    let rawPath = expanded;
    let temp = null;

    if (!/\.gog$/i.test(expanded)) {
        const innoextract = process.env.INNOEXTRACT || "/opt/homebrew/bin/innoextract";

        if (!fs.existsSync(innoextract)) {
            return { skip: `FH2_GOG names an installer, and innoextract was not found at '${innoextract}' (set INNOEXTRACT)` };
        }

        temp = fs.mkdtempSync(path.join(os.tmpdir(), "fh2iso-"));
        const run = spawnSync(innoextract, [ "-e", "-s", "-m", "-d", temp, "-I", "homm2.gog", expanded ], { encoding: "utf8" });

        if (run.status !== 0) {
            fs.rmSync(temp, { recursive: true, force: true });
            return { skip: `innoextract failed: ${(run.stderr || run.stdout).split("\n").filter(Boolean).slice(-2).join(" ")}` };
        }
        rawPath = path.join(temp, "homm2.gog");
    }

    const fd = fs.openSync(rawPath, "r");
    const size = fs.fstatSync(fd).size;

    process.on("exit", () => {
        fs.closeSync(fd);
        if (temp !== null) {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    });

    return {
        label: rawPath,
        source: {
            size,
            // One buffer per window, released by the caller: nothing here accumulates the image.
            read: async(offset, length) => {
                const buffer = Buffer.allocUnsafe(length);
                const got = fs.readSync(fd, buffer, 0, length, offset);

                return new Uint8Array(buffer.buffer, buffer.byteOffset, got);
            },
        },
    };
}

const real = openRealImage();

describe("real GOG image (FH2_GOG)", () => {
    if (real.skip) {
        test("real image checks", () => {}, real.skip);
        return;
    }

    let iso = null;

    test("opens the raw image with no conversion step", async() => {
        iso = await Iso9660.open(real.source);

        notes.push(`real image: ${real.label}`);
        assert(iso.volumeId === "HEROES2X", `the disc's volume id is HEROES2X, got '${iso.volumeId}'`);
        assert(iso.sectorStride === 2352, `homm2.gog is raw: stride should be 2352, got ${iso.sectorStride}`);
        assert(iso.sectorHeader === 16, `mode 1 user data should start at 16, got ${iso.sectorHeader}`);
        assert(iso.volumeSpaceSize === 119348, `the disc holds 119348 sectors, got ${iso.volumeSpaceSize}`);
    });

    test("lists exactly the ANIM files bsdtar extracts, same names and sizes", async() => {
        const listing = iso.list("HEROES2/ANIM").map(e => [ e.name, e.size ]);

        assert(listing.length === ANIM_SIZES.length, `expected ${ANIM_SIZES.length} ANIM entries, got ${listing.length}`);
        deepEqual(listing, [ ...ANIM_SIZES ].sort((a, b) => (a[0] < b[0] ? -1 : 1)), "ANIM listing, as [name, size]");
        assert(iso.skipped.length === 0, `nothing should need skipping, got ${JSON.stringify(iso.skipped.slice(0, 3))}`);
        notes.push(`${listing.length} ANIM entries match`);
    });

    test("returns INTRO.SMK and the two largest files byte-identically", async() => {
        for (const [ name, sha ] of Object.entries(ANIM_HASHES)) {
            const entry = iso.list(`HEROES2/ANIM/${name}`)[0];

            assert(entry !== undefined, `${name} should be listed`);

            const blob = await iso.read(entry);

            assert(blob.size === entry.size, `${name}: blob ${blob.size} vs listed ${entry.size}`);

            const hash = crypto.createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex");

            assert(hash === sha, `${name}: sha256 ${hash} != ${sha}`);
            notes.push(`${name} sha256 ok`);
        }
    });

    test("reads every ANIM file end to end inside the memory budget", async() => {
        // Walking the whole subtree is what the PWA does when it populates anim/, and it is where an
        // implementation that held each Blob would show up in RSS.
        let read = 0;

        for (const entry of iso.list("HEROES2/ANIM")) {
            const blob = await iso.read(entry);

            read += blob.size;

            const head = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
            const tail = new Uint8Array(await blob.slice(blob.size - 1).arrayBuffer());

            assert(head.length === 1 && tail.length === 1, `${entry.name}: both ends should be readable`);
        }

        const peakMb = process.resourceUsage().maxRSS / 1024;     // macOS reports kilobytes here

        notes.push(`${(read / 1048576).toFixed(1)} MiB read, peak RSS ${peakMb.toFixed(1)} MB (budget ${PEAK_RSS_BUDGET_MB})`);
        assert(peakMb < PEAK_RSS_BUDGET_MB,
            `peak RSS should stay under ${PEAK_RSS_BUDGET_MB} MB while reading 163 MiB of video, got ${peakMb.toFixed(1)} MB`);
    });

    test("reports this image's extents as one contiguous range each", async() => {
        // Asserted rather than assumed: the reader collapses neighbouring records and refuses anything else,
        // so a scattered image would have to be handled deliberately. This image is single-range throughout.
        const multi = iso.list().filter(e => e.extents.length !== 1);

        assert(multi.length === 0, `expected one range per file, got ${multi.length} exceptions`);
        notes.push("all extents contiguous");
    });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const started = Date.now();
let passed = 0;
let skipped = 0;
const failures = [];

for (const testCase of results) {
    if (testCase.skipNote !== null) {
        skipped += 1;
        console.log(`  skip ${testCase.group} :: ${testCase.name}\n         ${testCase.skipNote}`);
        continue;
    }

    try {
        await testCase.body();
        passed += 1;
        console.log(`  ok   ${testCase.group} :: ${testCase.name}`);
    }
    catch (error) {
        failures.push({ testCase, error });
        console.log(`  FAIL ${testCase.group} :: ${testCase.name}\n         ${error.message.split("\n").join("\n         ")}`);
    }
}

for (const note of notes) {
    console.log(`       ${note}`);
}

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (failures.length > 0) {
    process.exitCode = 1;
}
