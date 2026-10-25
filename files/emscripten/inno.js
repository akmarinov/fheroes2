/* Browser-side reader for Inno Setup 5.6.2 (unicode) installers -- the format written by
   Inno Setup 5.6.x with Unicode enabled, which is what the GOG.com Windows build of Heroes of
   Might and Magic II ships in.

   Everything below is a transcription of the reference format reader dscharrer/innoextract
   (Zlib licence); the file:line citations point at the sources that were read while writing
   it. The layout parsed, in the order it is parsed:

   1. The 44 byte loader/offset table, which for >= 5.1.5 lives in a PE resource named 11111
      (loader/offsets.cpp:112-207). It gives the offset of the setup header and of the
      compressed payload region, and carries a CRC32 over its own first 40 bytes.
   2. Two header blocks (stream/block.cpp:153-212): the version string plus the fixed field
      sequence of setup/header.cpp, then every table of setup/info.cpp -- including the file
      table (setup/file.cpp) and the chunk table (setup/data.cpp). A block is a stream of
      CRC-checked 4 KiB sub-blocks, stored or LZMA1.
   3. The chunk table: one record per payload chunk -- offset inside the payload region, bytes
      of payload, installed size, and the flag that says whether the chunk is compressed at all.
   4. The GOG Galaxy repacking (cli/goggalaxy.cpp:251-502). This installer is a GOG.com package,
      so the Inno file table does not name the game files: it names each payload part after the
      MD5 of its contents under {tmp}\ and stores the real install path, the part list and the
      per-part deflate/inflate sizes inside setup-script calls smuggled through the
      before_install / after_install / check_if_install condition strings. The real layout is
      rebuilt here exactly as `innoextract` does -- see _assembleGalaxy().

   Payload chunks are addressed individually: `zlb\x1a` + codec properties + data
   (stream/chunk.cpp:159-224), so one file comes out of a handful of Blob.slice() reads and a
   synchronous pump through inno.wasm. Neither the installer nor a whole file is ever in memory:
   at most one 1 MiB read window plus one 256 KiB output window is live at a time.

   This module is DOM-free on purpose: script/pwa/test/test-inno.mjs drives the exact same code
   under plain node against the real installer.
*/

const DEFAULT_WASM_URL = new URL('inno.wasm', import.meta.url);

/* Chunk compression ids, stream/chunk.hpp:29-36 / chunk.cpp:225-236, handed to the codec
   unchanged so the value read out of the setup header needs no re-mapping. */
export const COMP_STORED = 0;
export const COMP_ZLIB = 1;
export const COMP_BZIP2 = 2;
export const COMP_LZMA1 = 3;
export const COMP_LZMA2 = 4;
export const COMP_NAMES = ['stored', 'zlib', 'bzip2', 'lzma1', 'lzma2'];

/* setup/data.hpp data_entry::options, read by the 11-flag reader in data.cpp:141-166. */
const DATA_CHUNK_ENCRYPTED = 1 << 6;
const DATA_CHUNK_COMPRESSED = 1 << 7;

/* setup/file.hpp file_entry flags that change what a Windows install would write. */
const FILE_EXTERNAL_SIZE_PRESET = 1 << 28;
/* FILE_FLAGS index 3 (setup/file.cpp:120-181): the installer deletes the file again when setup
   finishes, so it is a setup-time helper (background images, the GOG Galaxy support files, the
   EULA text) and not part of what a Windows install leaves behind. The reference agrees:
   cli/extract.cpp:342-344 calls a file with this flag temporary and `--exclude-temp` drops it. */
const FILE_DELETE_AFTER_INSTALL = 1 << 3;

/* Bytes of installer read per request, and the codec output window. Both stay live at the same
   time, so together they are the whole transient footprint of one extraction. */
const READ_WINDOW = 1 << 20;
const OUT_WINDOW = 1 << 18;

/* Option flags, setup/header.hpp, in the order header.cpp registers them for a 32-bit 5.6.2
   build -- 45 flags, which is what makes the bitfield 6 bytes wide. Only EncryptionUsed is
   acted on, but the count is load-bearing: the stored_u32 padding rule depends on it. */
const HEADER_FLAGS = [
  'DisableStartupPrompt', 'CreateAppDir', 'AllowNoIcons', 'AlwaysRestart',
  'AlwaysUsePersonalGroup', 'WindowVisible', 'WindowShowCaption', 'WindowResizable',
  'WindowStartMaximized', 'EnableDirDoesntExistWarning', 'Password', 'AllowRootDirectory',
  'DisableFinishedPage', 'UsePreviousAppDir', 'BackColorHorizontal', 'UsePreviousGroup',
  'UpdateUninstallLogAppName', 'UsePreviousSetupType', 'DisableReadyMemo',
  'AlwaysShowComponentsList', 'FlatComponentsList', 'ShowComponentSizes', 'UsePreviousTasks',
  'DisableReadyPage', 'AlwaysShowDirOnReadyPage', 'AlwaysShowGroupOnReadyPage', 'AllowUNCPath',
  'UserInfoPage', 'UsePreviousUserInfo', 'UninstallRestartComputer', 'RestartIfNeededByRun',
  'ShowTasksTreeLines', 'AllowCancelDuringInstall', 'WizardImageStretch',
  'AppendDefaultDirName', 'AppendDefaultGroupName', 'EncryptionUsed', 'SetupLogging',
  'SignedUninstaller', 'UsePreviousLanguage', 'DisableWelcomePage', 'CloseApplications',
  'RestartApplications', 'AllowNetworkDrive', 'ForceCloseApplications',
];

/* setup/file.cpp:120-181 (32 flags -> 4 bytes, no padding for stored_u32). */
const FILE_FLAGS = [
  'ConfirmOverwrite', 'NeverUninstall', 'RestartReplace', 'DeleteAfterInstall',
  'RegisterServer', 'RegisterTypeLib', 'SharedFile', 'CompareTimeStamp', 'FontIsNotTrueType',
  'SkipIfSourceDoesntExist', 'OverwriteReadOnly', 'OverwriteSameVersion', 'CustomDestName',
  'OnlyIfDestFileExists', 'NoRegError', 'UninsRestartDelete', 'OnlyIfDoesntExist',
  'IgnoreVersion', 'PromptIfOlder', 'DontCopy', 'UninsRemoveReadOnly', 'RecurseSubDirsExternal',
  'ReplaceSameVersionIfContentsDiffer', 'DontVerifyChecksum', 'UninsNoSharedFilePrompt',
  'CreateAllSubDirs', 'Bits32', 'Bits64', 'ExternalSizePreset', 'SetNtfsCompression',
  'UnsetNtfsCompression', 'GacInstall',
];

/* setup/data.cpp:141-166 (11 flags -> 2 bytes). */
const DATA_FLAGS = [
  'VersionInfoValid', 'VersionInfoNotValid', 'TimeStampInUTC', 'IsUninstallerExe',
  'CallInstructionOptimized', 'Touch', 'ChunkEncrypted', 'ChunkCompressed', 'SolidBreak',
  'Sign', 'SignOnce',
];

/* Flag maps of the tables the parser must step over to reach the file table. Sizes are what
   matter -- every table is walked to its exact end so the next one starts at a known offset
   (setup/message.cpp, permission.cpp, type.cpp, component.cpp, task.cpp, directory.cpp,
   icon.cpp, ini.cpp, registry.cpp, delete.cpp, run.cpp). */
const TYPE_FLAGS = ['CustomSetupType'];
const COMPONENT_FLAGS = ['Fixed', 'Restart', 'DisableNoUninstallWarning', 'Exclusive',
  'DontInheritCheck'];
const TASK_FLAGS = ['Exclusive', 'Unchecked', 'Restart', 'CheckedOnce', 'DontInheritCheck'];
const DIR_FLAGS = ['NeverUninstall', 'DeleteAfterInstall', 'AlwaysUninstall',
  'SetNtfsCompression', 'UnsetNtfsCompression'];
const ICON_FLAGS = ['NeverUninstall', 'CreateOnlyIfFileExists', 'UseAppPaths', 'FolderShortcut',
  'ExcludeFromShowInNewInstall', 'PreventPinning'];
const INI_FLAGS = ['CreateKeyIfDoesntExist', 'UninsDeleteEntry', 'UninsDeleteEntireSection',
  'UninsDeleteSectionIfEmpty', 'HasValue'];
const REG_FLAGS = ['CreateValueIfDoesntExist', 'UninsDeleteValue', 'UninsClearValue',
  'UninsDeleteEntireKey', 'UninsDeleteEntireKeyIfEmpty', 'PreserveStringType', 'DeleteKey',
  'DeleteValue', 'NoError', 'DontCreateKey', 'Bits32', 'Bits64'];   // 12 -> 2 bytes
const RUN_FLAGS = ['ShellExec', 'SkipIfDoesntExist', 'PostInstall', 'Unchecked', 'SkipIfSilent',
  'SkipIfNotSilent', 'HideWizard', 'Bits32', 'Bits64', 'RunAsOriginalUser'];

/* Return codes of fh2_inno.c, which is the only channel the codec has. */
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

const VERSION_STRING = 'Inno Setup Setup Data (5.6.2) (u)';

export class InnoFormatError extends Error {}

function fail(message) {
  throw new InnoFormatError(message);
}

/* Little-endian cursor over one decoded block. Every read is bounds-checked, so a truncated or
   mis-parsed installer raises instead of running off the end of the wasm heap. */
class Bin {
  constructor(bytes, offset = 0) {
    this.b = bytes;
    this.i = offset;
  }

  need(n) {
    if (this.i + n > this.b.length) {
      fail(`truncated table: ${n} bytes needed at ${this.i}, only ${this.b.length - this.i} left`);
    }
  }

  u8() { this.need(1); return this.b[this.i++]; }

  u32() {
    this.need(4);
    const v = this.b[this.i] + (this.b[this.i + 1] << 8)
            + (this.b[this.i + 2] << 16) + this.b[this.i + 3] * 0x1000000;
    this.i += 4;
    return v >>> 0;
  }

  i16() {
    this.need(2);
    const v = (this.b[this.i] | (this.b[this.i + 1] << 8)) & 0xffff;
    this.i += 2;
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  /* Sizes in a 5.6.2 installer fit in 53 bits, so a double is exact and the public API can stay
     free of BigInt (`.size` is a plain number, which is also what putAsset wants). */
  u64() { return this.u32() + this.u32() * 0x100000000; }

  skip(n) { this.need(n); this.i += n; }

  /* util/binary_string.hpp: u32 length, 0xFFFFFFFF means "none". A 5.6.2 unicode installer
     stores each one as UTF-16LE, and header.cpp:190 never reads lead_bytes because the
     >= 2.0.6 && unicode branch skips it, so no codepage conversion is ever needed here. The
     bytes come back as a view; only the string fields are decoded, which keeps the 642-entry
     chunk table and the 207-entry language table from allocating strings nobody reads. */
  bin() {
    const n = this.u32();
    if (n === 0xffffffff) { return null; }
    if (n > this.b.length - this.i) { fail(`truncated ${n}-byte string at ${this.i}`); }
    const view = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return view;
  }

  str() {
    const v = this.bin();
    return v === null ? '' : Bin.utf16le.decode(v);
  }

  /* util/stored_flags.hpp + util/storedenum.hpp: one bit per registered flag, reading a new byte
     only when the previous one is exhausted, and stored_u32 (Inno >= 5.2.0) rounds the total up
     to a multiple of 4 bytes -- that is the `if (bytes == 3) bytes = 4` the reader has to mirror
     by consuming a pad byte. Getting a width wrong desynchronises every table after it, which is
     why the header walk ends with an assertion that it stopped at the end of the block. */
  flags(names) {
    let out = 0, pos = 0, bytes = 0, buf = 0;
    for (let k = 0; k < names.length; k++) {
      if (pos === 0) { buf = this.u8(); bytes++; }
      if (buf & (1 << pos)) { out |= 1 << k; }
      pos = (pos + 1) % 8;
    }
    if (bytes === 3) { this.u8(); }
    return out;
  }

  /* setup/version.hpp winver: for each of {win version, win server version} two
     (build u16, minor u8, major u8) triples and two u8 -- 20 bytes total, always skipped because
     only the wizard branches on it. */
  skipWinver() {
    for (let half = 0; half < 2; half++) {
      for (let tri = 0; tri < 2; tri++) { this.skip(2 + 1 + 1); }
      this.skip(1); this.skip(1);
    }
  }
}

Bin.utf16le = new TextDecoder('utf-16le');
Bin.latin1 = new TextDecoder('latin1');

/* CRC-32 as Inno uses it: reflected, 0xFFFFFFFF init and final xor (crypto/crc32.hpp
   CRC32_NEGL), i.e. exactly zlib's crc32(0, ...). Used for the offset table; block and sub-block
   CRCs are verified inside the codec while decoding. */
function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc32.table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let wasmPromise = null;

async function fetchWasmBytes(url) {
  const target = url instanceof URL ? url : new URL(url, windowLocation());
  if (target.protocol === 'file:' && typeof process !== 'undefined' && process.versions?.node) {
    /* Node's fetch does not speak file://, and the test harness points at a build directory. The
       dynamic import never runs in a browser, so the bare specifier is never resolved there. */
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(target));
  }
  const response = await fetch(target);
  if (!response.ok) { throw new Error(`cannot fetch ${target}: HTTP ${response.status}`); }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadWasm(url) {
  const bytes = await fetchWasmBytes(url);
  /* The only import this module ends up with is emscripten's memory-growth notification, which
     exists so a host can refresh cached typed arrays when wasm memory grows. Nothing here caches
     a view -- heap() builds a fresh one on each use -- so the hook is a no-op, and handing it
     over unconditionally is harmless even for a build that imports nothing. */
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const e = instance.exports;
  if (typeof e.fh2_abi_version !== 'function' || (e.fh2_abi_version() | 0) !== 1) {
    throw new Error('inno.wasm has an incompatible ABI; rebuild it from script/pwa/inno/');
  }
  return {
    heap: () => new Uint8Array(e.memory.buffer),
    alloc: (n) => e.fh2_alloc(n | 0) >>> 0,
    free: (p) => e.fh2_free(p >>> 0),
    probe: (p, n) => e.fh2_probe(p >>> 0, n | 0) | 0,
    blockDecode: (p, n, o, cap) => e.fh2_block_decode(p >>> 0, n | 0, o >>> 0, cap | 0) | 0,
    sliceOpen: (comp, p, n) => e.fh2_slice_open(comp | 0, p >>> 0, n | 0) | 0,
    slicePump: (h, p, n, o, cap) => e.fh2_slice_pump(h | 0, p >>> 0, n | 0, o >>> 0, cap | 0) | 0,
    sliceConsumed: (h) => e.fh2_slice_consumed(h | 0) | 0,
    sliceFinished: (h) => e.fh2_slice_finished(h | 0) | 0,
    sliceError: (h) => e.fh2_slice_error(h | 0) | 0,
    sliceClose: (h) => e.fh2_slice_close(h | 0),
  };
}

function wasmInstance(url) {
  if (!wasmPromise) { wasmPromise = loadWasm(url || DEFAULT_WASM_URL); }
  return wasmPromise;
}

/* Relative wasm locations are resolved against this module's own URL, which is what a browser's
   import.meta.url is for; a Node harness passing a plain path gets the same treatment. */
function windowLocation() {
  return import.meta.url;
}

/* A source only needs .size and .slice(start, end) -> Promise<Blob>, so a browser File, a node
   Blob over a real file and a test stub are all acceptable. */
async function readRange(file, offset, length) {
  const end = Math.min(file.size, offset + length);
  if (offset >= end || length <= 0) { return new Uint8Array(0); }
  const blob = await file.slice(offset, end);
  return new Uint8Array(await blob.arrayBuffer());
}

/* Windowed input/output buffers in the wasm heap plus the synchronous pump driver. One Codec
   serves the whole installer: extraction is sequential, so a single set of windows is enough and
   the transient footprint stays at READ_WINDOW + OUT_WINDOW. */
class Codec {
  constructor(wasm) {
    this.w = wasm;
    this.outPtr = wasm.alloc(OUT_WINDOW);
    this.propsPtr = wasm.alloc(8);
    this.inPtr = 0;
    this.inCap = 0;
    if (!this.outPtr || !this.propsPtr) {
      throw new Error('cannot allocate the extractor windows');
    }
  }

  free() {
    if (!this.w) { return; }
    this.w.free(this.outPtr);
    this.w.free(this.propsPtr);
    this.w.free(this.inPtr);
    this.outPtr = this.propsPtr = this.inPtr = 0;
    this.inCap = 0;
    this.w = null;
  }

  error(code) {
    return new Error(`extractor error ${code}: ${CODEC_ERRORS[code] || 'unknown code'}`);
  }

  heap() { return this.w.heap(); }

  ensureInput(n) {
    if (n <= this.inCap) { return; }
    const size = Math.max(n, 64 * 1024);
    const ptr = this.w.alloc(size);
    if (!ptr) { throw new Error('cannot allocate the extractor input window'); }
    this.w.free(this.inPtr);
    this.inPtr = ptr;
    this.inCap = size;
  }

  /* Decode one whole Inno block: `framed` is the 9 byte block header followed by its stored_size
     bytes of sub-block stream. The codec verifies the header CRC, every sub-block CRC and the
     framing; -10 (FH2_ERR_FULL) means "the plaintext is bigger than the window you gave me", so
     the caller doubles the window and tries again. */
  block(framed) {
    this.ensureInput(framed.length);
    this.heap().set(framed, this.inPtr);
    if (this.w.probe(this.inPtr, framed.length) < 0) {
      fail('bad block header CRC: this is not an Inno installer, or the file is corrupt');
    }
    let cap = 4 * OUT_WINDOW;
    for (;;) {
      const out = this.w.alloc(cap);
      if (!out) { throw new Error('cannot allocate block plaintext'); }
      const got = this.w.blockDecode(this.inPtr, framed.length, out, cap);
      if (got === -10) { this.w.free(out); cap *= 2; continue; }
      if (got < 0) { this.w.free(out); throw this.error(got); }
      const copy = this.heap().slice(out, out + got);
      this.w.free(out);
      return copy;
    }
  }

  /* Pump one chunk through the codec.
       compression, props -- as split from the chunk by splitChunkProps()
       total              -- payload bytes to feed, i.e. the chunk's recorded size
       supply             -- async (consumed, length) -> Uint8Array of payload bytes
       emit               -- called with a view valid only during the call
     Stops when the decoder reports its own end marker or when `total` bytes have been eaten.
     Inno leaves padding after a chunk (this installer writes two bytes after every LZMA2 one),
     so the recorded size -- not "everything up to the next chunk" -- is what bounds the feed. */
  async pump(compression, props, total, supply, emit) {
    this.ensureInput(Math.min(total, READ_WINDOW));
    /* The codec keeps the properties pointer rather than copying them, so they live in a scratch
       buffer of their own instead of the input window, which is rewritten on every refetch. */
    this.heap().set(props, this.propsPtr);
    const handle = this.w.sliceOpen(compression, this.propsPtr, props.length);
    if (handle < 0) { throw this.error(handle); }
    let produced = 0;
    let consumed = 0;   // payload bytes eaten so far, counted from the start of this chunk
    try {
      for (;;) {
        if (consumed >= total || this.w.sliceFinished(handle)) { break; }
        const bytes = await supply(consumed, Math.min(READ_WINDOW, total - consumed));
        if (!bytes || bytes.length === 0) {
          throw new Error(`the installer ended ${total - consumed} bytes too early`);
        }
        this.ensureInput(bytes.length);
        this.heap().set(bytes, this.inPtr);
        const base = consumed;   // what `consumed` was when this window was handed over
        let fed = 0;             // bytes of this window already given to the decoder
        for (;;) {
          const wrote = this.w.slicePump(handle, this.inPtr + fed, bytes.length - fed,
            this.outPtr, OUT_WINDOW);
          if (wrote < 0) { throw this.error(wrote); }
          if (wrote > 0) {
            produced += wrote;
            emit(this.heap().subarray(this.outPtr, this.outPtr + wrote));
          }
          const now = this.w.sliceConsumed(handle);
          if (now < 0) { throw this.error(now); }
          const err = this.w.sliceError(handle);
          if (err < 0) { throw this.error(err); }
          const advanced = now - consumed;
          consumed = now;
          fed = now - base;
          if (this.w.sliceFinished(handle) || fed >= bytes.length) { break; }
          if (advanced === 0 && wrote < OUT_WINDOW) {
            /* Nothing consumed, nothing more written and the output window was not the limit: a
               "keep trying" loop would spin forever. Only an output-limited stop is worth
               repeating with the same input. */
            throw new Error('the decoder stopped without consuming input or filling output');
          }
        }
      }
      const err = this.w.sliceError(handle);
      if (err < 0) { throw this.error(err); }
    } finally {
      this.w.sliceClose(handle);
    }
    return produced;
  }
}

/* cli/goggalaxy.cpp:52-77 parse_function_call: `name('a', 1, 2)` -> ['a', '1', '2'], quoted
   arguments unwrapped, bare ones kept verbatim, commas inside quotes ignored. */
function parseFunctionCall(text, name) {
  const prefix = `${name}(`;
  if (!text.startsWith(prefix) || !text.endsWith(')')) { return null; }
  const inner = text.slice(prefix.length, -1);
  const args = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (const ch of inner) {
    if (ch === "'") { quoted = !quoted; }
    if (!quoted && ch === '(') { depth++; }
    if (!quoted && ch === ')') { depth--; }
    if (ch === ',' && !quoted && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  args.push(current.trim());
  return args.map((a) => (a.length >= 2 && a.startsWith("'") && a.endsWith("'")
    ? a.slice(1, -1) : a));
}

/* cli/goggalaxy.cpp:188-226 parse_constraints: 'en-US#de-DE#!fr-FR' -> [{name, negated}]. */
function parseConstraints(input) {
  const out = [];
  let start = 0;
  while (start < input.length) {
    while (start < input.length && /[ \t\r\n]/.test(input[start])) { start++; }
    if (start >= input.length) { break; }
    let negated = false;
    if (input[start] === '!') { negated = true; start++; }
    let end = input.indexOf('#', start);
    if (end < 0) { end = input.length; }
    if (end !== start) { out.push({ name: input.slice(start, end).trim(), negated }); }
    start = end + 1;
  }
  return out;
}

export class InnoInstaller {
  /* `source` needs .size and .slice(start, end). options:
        language -- language tag to resolve entries against; 'en-US' is what a Windows install of
                    this package takes, and it is the installer's own first language
        wasmUrl  -- alternative inno.wasm location
     Throws InnoFormatError for anything that is not a parseable 5.6.2 unicode installer,
     including a truncated or CRC-corrupt one. It cannot hang: every read is bounded by the file
     size, every loop by a recorded length, and _parseChunkTable refuses any chunk whose recorded
     size would run past the byte where the next chunk's magic is known to start. */
  static async open(source, options = {}) {
    const self = new InnoInstaller();
    self.file = source;
    self.codec = new Codec(await wasmInstance(options.wasmUrl));
    let ok = false;
    try {
      await self._findOffsetTable();
      await self._readHeaderBlocks();
      self._parseHeader();
      self._parseChunkTable();
      self._assembleGalaxy();
      self._buildEntries(options.language || 'en-US');
      ok = true;
    } finally {
      if (!ok) { self.dispose(); }
    }
    return self;
  }

  get entryCount() { return this.entries.length; }

  dispose() {
    if (this.codec) { this.codec.free(); this.codec = null; }
    this.headerBytes = null;
    this.tables = null;
    this.files = null;
    this.dataEntries = null;
  }

  /* ---- loader/offset table ------------------------------------------------------- */

  /* loader/offsets.cpp puts a 44 byte table inside the executable, referenced either from a
     constant slot at 0x30 (before 5.1.5) or from a PE resource of type RT_RCDATA named 11111
     (from 5.1.5; offsets.cpp:97-110 and the directory walk in loader/exereader.cpp:275-460).
     Rather than porting that walk, the table is found by searching for its magic and accepting
     the first hit whose own trailing CRC32 checks out -- the same CRC the reference accumulates
     before trusting a single field (offsets.cpp:141-200: every checksum.load() both reads four
     bytes and feeds them to the running register, and the u32 after them is compared with the
     result). The reference only warns on a mismatch; this reader refuses, because every offset
     behind it would then be unsafe.
     A scan is equivalent here and cheaper to get right: the magic is 12 bytes of a table whose
     40 bytes are covered by a CRC32, so a false positive needs a colliding 32-bit checksum, and
     the next step still decodes the setup header under three more CRC checks. It also survives
     this particular file, whose 32-bit PE header sits at 0x100 while its own e_lfanew field
     claims 0x1000000 -- the reference only reads the low 16 bits of that field
     (exereader.cpp:56), so a naive 32-bit read walks off into the DOS stub.
     Only the two post-5.1.5 magics are accepted, since only their revision-1 layout is
     implemented here (offsets.cpp:58-59,145-154).
     Fields, in the order the reference reads them (offsets.cpp:146-191):
        0   magic, 12 bytes
       12   revision, 1 from 5.1.5 on
       16   discarded by the reference (offsets.cpp:156)
       20   offset of the embedded setup loader
       24   its uncompressed size (a compressed size would be read here only before 4.1.6)
       28   its CRC32
       32   setup header offset
       36   payload (chunk) region offset
       40   running CRC32 of the 40 bytes before it */
  async _findOffsetTable() {
    /* Both accepted magics share the 'rDlPtS' prefix with older layouts, so searching for that
       prefix and then matching the full 12 bytes keeps the check honest without decoding the
       reference's version table. */
    const candidates = [
      { prefix: 'rDlPtS', magic: Bin.latin1.decode(new Uint8Array([0x72, 0x44, 0x6c, 0x50, 0x74,
        0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a])) },
      { prefix: 'nS5W7d', magic: Bin.latin1.decode(new Uint8Array([0x6e, 0x53, 0x35, 0x57, 0x37,
        0x64, 0x54, 0x83, 0xaa, 0x1b, 0x0f, 0x6a])) },
    ];
    const scan = Math.min(this.file.size, 16 << 20);
    /* A magic whose trailing CRC does not add up is a corrupt installer, not a non-installer;
       remembering that distinction is the difference between "this is not an Inno Setup file" and
       the truth, which is that a byte of the table has been damaged. */
    let crcMismatchAt = -1;
    for (let base = 0; base + 44 <= scan; base += READ_WINDOW) {
      const window = await readRange(this.file, base, READ_WINDOW);
      if (window.length < 44) { break; }
      const text = Bin.latin1.decode(window);
      for (const { prefix, magic } of candidates) {
        let at = text.indexOf(prefix);
        while (at >= 0) {
          if (at + 44 <= window.length && text.startsWith(magic, at)) {
            const table = window.subarray(at, at + 44);
            const stored = (table[40] | (table[41] << 8) | (table[42] << 16)
              | (table[43] << 24)) >>> 0;
            if (crc32(table.subarray(0, 40)) !== stored) {
              if (crcMismatchAt < 0) { crcMismatchAt = base + at; }
            } else {
              /* Remembered so a test can flip a byte inside the table and prove the CRC check
                 actually guards it, and so the UI can name the offset in a diagnostic. */
              this.offsetTableOffset = base + at;
              const c = new Bin(table, 12);
              this.offsetRevision = c.u32();
              c.skip(16);   // discarded field, loader offset, loader size, loader CRC
              this.headerOffset = c.u32();
              this.payloadOffset = c.u32();
              if (this.offsetRevision !== 1) {
                fail(`unexpected setup loader revision ${this.offsetRevision}`);
              }
              if (this.headerOffset >= this.file.size
                  || this.payloadOffset + 4 > this.file.size) {
                fail('the loader offset table points outside this file');
              }
              return;
            }
          }
          at = text.indexOf(prefix, at + 1);
        }
      }
    }
    if (crcMismatchAt >= 0) {
      fail(`the Inno Setup loader table at ${crcMismatchAt} is corrupt: its CRC does not match`
        + ' the 40 bytes it covers');
    }
    fail(`no Inno Setup loader table in the first ${Math.round(scan / (1 << 20))} MiB`
      + ' -- this reader handles Inno Setup 5.6.2 (unicode) installers');
  }

  /* ---- header blocks ------------------------------------------------------------- */

  /* stream/block.cpp:153-212. A block is
        u32 crc32 of the next 5 bytes
        u32 stored_size   (length of the sub-block stream, sub-block CRCs included)
        u8  compressed    (0 = stored, 1 = zlib before 4.1.6 and LZMA1 from 4.1.6 onwards)
     then sub-blocks: u32 crc32 + up to 4096 plaintext bytes. All three checks happen inside the
     codec as it decodes, so nothing here has to repeat them. */
  async _readBlock(at, withVersion) {
    const prefix = withVersion ? 64 : 0;
    const head = await readRange(this.file, at, prefix + 9);
    if (head.length < prefix + 9) { fail('the file ends inside a block header'); }
    let version = '';
    if (withVersion) {
      const raw = head.subarray(0, 64);
      const nul = raw.indexOf(0);
      version = Bin.latin1.decode(raw.subarray(0, nul < 0 ? 64 : nul));
    }
    const meta = new Bin(head.subarray(prefix));
    meta.u32();                       // header CRC, verified by the codec
    const storedSize = meta.u32();
    meta.u8();                        // compression flag, verified by the codec
    if (storedSize === 0) { fail('an Inno block cannot store zero bytes'); }
    /* One bounds check up front: a truncated download is named as such here instead of turning
       into a mysterious CRC failure in the middle of the sub-block stream. */
    if (at + prefix + 9 + storedSize > this.file.size) {
      fail(`the installer is truncated: a ${storedSize}-byte block at ${at + prefix + 9} would`
        + ` need ${at + prefix + 9 + storedSize} bytes and the file holds ${this.file.size}`);
    }
    const framed = new Uint8Array(9 + storedSize);
    framed.set(head.subarray(prefix, prefix + 9), 0);
    framed.set(await readRange(this.file, at + prefix + 9, storedSize), 9);
    return { version, next: at + prefix + 9 + storedSize, framed };
  }

  async _readHeaderBlocks() {
    const first = await this._readBlock(this.headerOffset, true);
    /* info.cpp:175-196 reads the version string first and dispatches on it. This reader
       implements one field layout, so anything else is refused rather than parsed with the wrong
       field order -- which would otherwise come out as garbage file names. */
    if (first.version !== VERSION_STRING) {
      fail(`unsupported installer "${first.version}"`
        + ` (this reader handles "${VERSION_STRING}")`);
    }
    this.version = first.version;
    const second = await this._readBlock(first.next, false);
    this.headerBytes = this.codec.block(first.framed);
    this.tables = this.codec.block(second.framed);
  }

  /* setup/header.cpp:140-357 (5.6.2 unicode branch), then the table walk of setup/info.cpp
     229-320. Fields are consumed in the reference's exact order; the ones only the wizard uses
     are skipped but still stepped over, because the layout is positional. */
  _parseHeader() {
    const c = new Bin(this.headerBytes);
    const h = {};
    /* header.cpp:147-237 order. The fields a >= 3.0.0 installer clears and the ISX-only ones are
       dropped, and the version gates that are false for 5.6.2 are folded away. compiled_code is
       read exactly once, by the >= 5.2.5 branch (header.cpp:199): the other read site is guarded
       by is_isx(), and this is not an Inno Setup X installer. */
    for (const key of ['app_name', 'app_versioned_name', 'app_id', 'app_copyright',
      'app_publisher', 'app_publisher_url', 'app_support_phone', 'app_support_url',
      'app_updates_url', 'app_version', 'default_dir_name', 'default_group_name',
      'base_filename', 'uninstall_files_dir', 'uninstall_name', 'uninstall_icon', 'app_mutex',
      'default_user_name', 'default_user_organisation', 'default_serial', 'app_readme_file',
      'app_contact', 'app_comments', 'app_modify_path', 'create_uninstall_registry_key',
      'uninstallable', 'close_applications_filter', 'setup_mutex', 'changes_environment',
      'changes_associations']) {
      h[key] = c.str();
    }
    c.bin(); c.bin(); c.bin();          // license_text, info_before, info_after
    c.bin();                            // compiled_code
    h.languageCount = c.u32();
    h.messageCount = c.u32();
    h.permissionCount = c.u32();
    h.typeCount = c.u32();
    h.componentCount = c.u32();
    h.taskCount = c.u32();
    h.directoryCount = c.u32();
    h.fileCount = c.u32();
    h.dataEntryCount = c.u32();
    h.iconCount = c.u32();
    h.iniEntryCount = c.u32();
    h.registryEntryCount = c.u32();
    h.deleteEntryCount = c.u32();
    h.uninstallDeleteEntryCount = c.u32();
    h.runEntryCount = c.u32();
    h.uninstallRunEntryCount = c.u32();
    c.skipWinver();
    c.skip(8);                          // back_color, back_color2 (image_back_color is < 5.5.7 and
                                        // small_image_back_color is outside [2.0.0, 5.0.4))
    c.skip(1);                          // image_alpha_format, >= 5.5.7
    c.skip(20);                         // password SHA-1, >= 5.3.9
    c.skip(8);                          // password salt, >= 4.2.2
    c.skip(8);                          // extra_disk_space_required
    h.slicesPerDisk = c.u32();
    c.skip(1);                          // uninstall_log_mode (stored_enum); install_mode is only
                                        // read before 5.0.0 and uninstall_style only before 5.0.0
    c.skip(1);                          // dir_exists_warning (stored_enum)
    c.skip(1);                          // privileges_required (stored_enum)
    c.skip(1); c.skip(1);               // show_language_dialog, language_detection
    h.compression = c.u8();             // stored_compression_method, >= 5.3.9
    c.skip(1); c.skip(1);               // architectures_allowed, ..._in_64bit_mode (4 flags each)
    c.skip(1); c.skip(1);               // disable_dir_page, disable_program_group_page
    c.skip(8);                          // uninstall_display_size u64, >= 5.5.0
    h.flags = c.flags(HEADER_FLAGS);
    this.setup = h;
    if (h.flags & (1 << HEADER_FLAGS.indexOf('EncryptionUsed'))) {
      /* The brief verified with `innoextract -i` that this package is not passworded; if a future
         one is, say so instead of decoding garbage. */
      fail('this installer is password-protected, which this reader will not open');
    }
    if (h.compression > COMP_LZMA2) {
      fail(`the setup header declares compression id ${h.compression}`
        + ` (${COMP_NAMES[h.compression] || 'not a method'}), which is not a chunk method`);
    }
    this.appName = h.app_name;
    this._checkTableCounts(c);

    this.languages = [];
    for (let i = 0; i < h.languageCount; i++) {
      /* setup/language.cpp: name, language name, five strings, then three more for >= 5.5.7
         (per-language license/info_before/info_after), the LCID, four font sizes and the
         right-to-left byte. The codepage u32 is only read for < 5.3.0 non-unicode builds. */
      const name = c.str();
      const languageName = c.str();
      for (let k = 0; k < 5; k++) { c.bin(); }
      for (let k = 0; k < 3; k++) { c.bin(); }
      const languageId = c.u32();
      c.skip(16);
      c.skip(1);
      this.languages.push({ name, languageName, languageId });
    }

    /* Every table between the languages and the file table has to be stepped over exactly; the
       assertion at the end of this method is what proves the widths were right. */
    this._skipTable(c, 'messages', h.messageCount, () => { c.bin(); c.bin(); c.skip(4); });
    this._skipTable(c, 'permissions', h.permissionCount, () => { c.bin(); });
    this._skipTable(c, 'types', h.typeCount, () => {
      for (let k = 0; k < 4; k++) { c.bin(); }
      c.skipWinver(); c.flags(TYPE_FLAGS); c.skip(1); c.skip(8);   // enum, size u64
    });
    this._skipTable(c, 'components', h.componentCount, () => {
      for (let k = 0; k < 5; k++) { c.bin(); }    // name, description, types, languages, check
      c.skip(8); c.skip(4); c.skip(1); c.skipWinver(); c.flags(COMPONENT_FLAGS); c.skip(8);
    });
    this._skipTable(c, 'tasks', h.taskCount, () => {
      for (let k = 0; k < 6; k++) { c.bin(); }
      c.skip(4); c.skip(1); c.skipWinver(); c.flags(TASK_FLAGS);
    });
    /* setup/directory.cpp:49-87 (name + the item condition block + attributes, winver, the
       pre-4.1 permission i16 and the 5.2.0 option flags). */
    this._skipTable(c, 'directories', h.directoryCount, () => {
      c.bin(); this._conditions(c); c.skip(4); c.skipWinver(); c.skip(2); c.flags(DIR_FLAGS);
    });

    /* setup/file.cpp:73-186. */
    this.files = [];
    for (let i = 0; i < h.fileCount; i++) {
      const e = {};
      e.source = c.str();
      e.destination = c.str();
      e.installFontName = c.str();
      c.bin();                                    // strong_assembly_name
      const cond = this._conditions(c);
      e.components = cond[0];
      e.tasks = cond[1];
      e.languages = cond[2];
      e.check = cond[3];
      /* item.cpp:53-54 loads after_install first and before_install second. This installer puts
         the Galaxy part sizes in the former and the real install path in the latter. */
      e.afterInstall = cond[4];
      e.beforeInstall = cond[5];
      c.skipWinver();
      e.location = c.u32();                       // index into the chunk table
      e.attributes = c.u32();
      e.externalSize = c.u64();
      e.permission = c.i16();
      e.options = c.flags(FILE_FLAGS);
      e.type = c.u8();                            // stored_setup_type: 0 = ttData, 1 = ttIcons
      this.files.push(e);
    }

    /* setup/icon.cpp:45-103. Five shortcut strings plus comment, the condition block, and from
       5.3.5 the app-user-model-id string (the toast CLSID is only there from 6.1.0). Then
       winver, icon_index (32-bit width), show_command i32, close_on_exit enum, hotkey u16. */
    this._skipTable(c, 'icons', h.iconCount, () => {
      for (let k = 0; k < 13; k++) { c.bin(); }
      c.skipWinver(); c.skip(4); c.skip(4); c.skip(1); c.skip(2); c.flags(ICON_FLAGS);
    });
    /* setup/ini.cpp:44-64: four strings plus the condition block, winver, five option flags. */
    this._skipTable(c, 'ini', h.iniEntryCount, () => {
      for (let k = 0; k < 4; k++) { c.bin(); }
      this._conditions(c); c.skipWinver(); c.flags(INI_FLAGS);
    });
    /* setup/registry.cpp:104-166: key, name (32-bit builds only) and the raw value, conditions,
       winver, hive u32, permission i16, type enum, twelve option flags. */
    this._skipTable(c, 'registry', h.registryEntryCount, () => {
      c.bin(); c.bin(); c.bin(); this._conditions(c); c.skipWinver(); c.skip(4); c.skip(2);
      c.skip(1); c.flags(REG_FLAGS);
    });
    /* setup/delete.cpp:40-53 -- shared by the [Delete] and [UninstallDelete] tables. */
    this._skipTable(c, 'delete', h.deleteEntryCount, () => {
      c.bin(); this._conditions(c); c.skipWinver(); c.skip(1);
    });
    this._skipTable(c, 'uninstallDelete', h.uninstallDeleteEntryCount, () => {
      c.bin(); this._conditions(c); c.skipWinver(); c.skip(1);
    });
    /* setup/run.cpp:56-115 -- shared by [Run] and [UninstallRun]: seven strings (name,
       parameters, working dir, run-once id, status message, verb, description), the condition
       block, winver, show_command i32, the wait enum and ten option flags. */
    this._skipTable(c, 'run', h.runEntryCount, () => {
      for (let k = 0; k < 7; k++) { c.bin(); }
      this._conditions(c); c.skipWinver(); c.skip(4); c.skip(1); c.flags(RUN_FLAGS);
    });
    this._skipTable(c, 'uninstallRun', h.uninstallRunEntryCount, () => {
      for (let k = 0; k < 7; k++) { c.bin(); }
      this._conditions(c); c.skipWinver(); c.skip(4); c.skip(1); c.flags(RUN_FLAGS);
    });

    /* Wizard bitmaps: from 5.6.0 a u32 count followed by that many binary strings
       (info.cpp:77-112), once for the standard images and once for the extended ones. Then, only
       when the payload is zlib-compressed, the bundled decompressor DLL (info.cpp:114-124) --
       this installer is LZMA2, so there is none. */
    this._wizardImages(c);
    this._wizardImages(c);
    if (h.compression === COMP_ZLIB) { c.bin(); }
    if (c.i !== this.headerBytes.length) {
      fail(`the header walk left ${this.headerBytes.length - c.i} bytes of`
        + ` ${this.headerBytes.length} unconsumed -- this installer does not match the 5.6.2`
        + ' layout this reader implements');
    }
  }

  /* setup/item.hpp:29-59 load_condition_data: every table whose entry derives from item --
     directories, files, icons, ini, registry, delete and run -- carries the same six strings
     (components, tasks, languages, check, after_install, before_install) after its own leading
     fields. All six conditions exist in 5.6.2, so the count is not a parameter. */
  _conditions(c) {
    const out = [];
    for (let k = 0; k < 6; k++) { out.push(c.str()); }
    return out;
  }

  _wizardImages(c) {
    /* Each image is a length-prefixed blob, so 4 bytes is the smallest an entry can occupy. */
    const count = this._checked(c, 'wizard images', c.u32(), 4);
    for (let i = 0; i < count; i++) { c.bin(); }
  }

  _skipTable(c, name, count, step) {
    for (let i = 0; i < count; i++) {
      try {
        step();
      } catch (error) {
        fail(`stepping over "${name}" entry ${i}: ${error.message}`);
      }
    }
  }

  /* A count read from a desynchronised cursor is a huge number, and looping over it would spin
     for hours before it noticed. Every table count is therefore checked against the bytes that are
     actually left, using the smallest a record of that table can possibly be: an impossible count
     fails immediately and names the table, instead of the parser appearing to hang. */
  _checked(c, name, count, minRecord) {
    const room = c.b.length - c.i;
    if (count > Math.floor(room / minRecord)) {
      fail(`"${name}" declares ${count} entries, which needs ${count * minRecord} bytes and only`
        + ` ${room} remain in the block -- the tables before it were parsed with the wrong width`);
    }
    return count;
  }

  /* Table counts are u32 read straight out of the block, so all of them are sanity-checked here
     once, against the smallest record each table can have. Doing it before any loop starts also
     means a wrong field width earlier in the header is reported as "this installer does not match
     the layout", not as a stalled tab. */
  _checkTableCounts(c) {
    const h = this.setup;
    this._checked(c, 'languages', h.languageCount, 2);            // two empty strings at minimum
    this._checked(c, 'messages', h.messageCount, 12);
    this._checked(c, 'permissions', h.permissionCount, 4);
    this._checked(c, 'types', h.typeCount, 26);
    this._checked(c, 'components', h.componentCount, 33);
    this._checked(c, 'tasks', h.taskCount, 17);
    this._checked(c, 'directories', h.directoryCount, 22);
    this._checked(c, 'files', h.fileCount, 32);
    this._checked(c, 'icons', h.iconCount, 31);
    this._checked(c, 'ini entries', h.iniEntryCount, 21);
    this._checked(c, 'registry entries', h.registryEntryCount, 19);
    this._checked(c, 'delete entries', h.deleteEntryCount, 13);
    this._checked(c, 'uninstall delete entries', h.uninstallDeleteEntryCount, 13);
    this._checked(c, 'run entries', h.runEntryCount, 32);
    this._checked(c, 'uninstall run entries', h.uninstallRunEntryCount, 32);
  }

  /* ---- chunk table --------------------------------------------------------------- */

  /* setup/data.cpp:45-215. One 5.6.2 32-bit record:
        u32 first slice, u32 last slice, u32 offset, u64 file offset, u64 file size,
        u64 chunk size, 20 B SHA-1 (>= 5.3.9), i64 FILETIME, u32 + u32 version, 11 flags = 2 B
     = 74 bytes (and the 47508-byte table block divided by its 642 records says the same).
     file.size is the installed size and chunk.size the bytes of payload, which differ exactly
     when the chunk is compressed -- except for GOG Galaxy parts, where the chunk holds a
     deflate stream and neither field is its decoded size (see _assembleGalaxy). */
  _parseChunkTable() {
    const count = this.setup.dataEntryCount;
    const size = this.tables.length;
    if (count === 0) { fail('this installer carries no payload chunks'); }
    const record = 74;
    /* The chunk table is the last thing in the block, so anchoring at the end is exact (that is
       the same bound info.cpp:202-208 computes). If the record size were wrong, the field parse
       below trips over its own bounds check or the assertion, never silently succeeds. */
    const start = size - count * record;
    if (start < 0) {
      fail(`${count} chunk records need ${count * record} bytes, the table block holds ${size}`);
    }
    const c = new Bin(this.tables, start);
    this.dataEntries = [];
    for (let i = 0; i < count; i++) {
      const e = {};
      e.firstSlice = c.u32();
      e.lastSlice = c.u32();
      e.offset = c.u32();
      e.fileOffset = c.u64();
      e.fileSize = c.u64();
      e.chunkSize = c.u64();
      c.skip(20 + 8 + 8);            // SHA-1 of the installed file, FILETIME, two version u32
      e.options = c.flags(DATA_FLAGS);
      e.compression = (e.options & DATA_CHUNK_COMPRESSED) ? this.setup.compression : COMP_STORED;
      e.deflated = false;            // set by _assembleGalaxy for Galaxy parts
      e.plainSize = e.fileSize;
      this.dataEntries.push(e);
    }
    if (c.i !== size) { fail(`the chunk table ended at ${c.i} instead of ${size}`); }
    if (this.setup.slicesPerDisk > 1) {
      fail(`this installer spans ${this.setup.slicesPerDisk} payload slices, which this reader`
        + ' cannot seek across');
    }
    for (const e of this.dataEntries) {
      if (e.firstSlice !== 0 || e.lastSlice !== 0) {
        fail('this installer uses more than one payload slice, which this reader cannot seek');
      }
      if (e.options & DATA_CHUNK_ENCRYPTED) {
        fail('this installer has encrypted chunks, which this reader cannot decrypt');
      }
      if (e.chunkSize > 0x7ffffff) {
        fail(`a chunk claims ${e.chunkSize} bytes, which no single pump could handle`);
      }
    }
    /* Inno lays chunks out back to back in ascending offset order, which is how the reference
       reads them forward without ever consulting a length (chunk.cpp:159-224 reads the magic and
       lets the codec stop at the stream's own end). Recording where the next magic starts lets
       the same feed be bounded from both ends, so neither a corrupt chunk size nor a truncated
       file can make it run away. */
    const order = this.dataEntries.slice().sort((a, b) => a.offset - b.offset);
    const tail = this.file.size - this.payloadOffset;
    for (let i = 0; i < order.length; i++) {
      order[i].regionEnd = i + 1 < order.length ? order[i + 1].offset : tail;
    }
  }

  /* ---- GOG Galaxy layer ---------------------------------------------------------- */

  /* cli/goggalaxy.cpp:251-502. A GOG.com installer stores each game file as one or more parts
     named after the MD5 of their contents, and keeps the real layout in setup-script calls inside
     the file entry conditions:
         before_install_dependency('<md5>', 'DATA\HEROES2.AGG', 1)  -- first part of a file
         after_install_dependency('<md5>', <deflated>, <inflated>)  -- every part
     Each part's chunk is then flagged *not* compressed while actually holding a deflate stream,
     which is why the reference sets the chunk filter to zlib and takes the installed size from
     the <inflated> argument (goggalaxy.cpp:346-352). The same calls also carry the language
     constraints: the Inno `languages` field is empty in this installer, so
     check_if_install('en-US#de-DE#fr-FR#', ...) is the only language tag it has. */
  _assembleGalaxy() {
    const h = this.setup;
    this.isGogPackage = /gog\.com/i.test(`${h.app_publisher}${h.app_publisher_url}`
      + `${h.app_support_url}${h.app_updates_url}`);
    let fileStart = null;
    let remaining = 0;
    let files = 0;
    this.galaxyFiles = [];
    this.foldedParts = new Set();
    for (const file of this.files) {
      if (file.type !== 0 || !file.destination) { continue; }
      if (!file.languages) { file.languages = this._languageTag(file.check); }
      const start = parseFunctionCall(file.beforeInstall, 'before_install')
        || parseFunctionCall(file.beforeInstall, 'before_install_dependency');
      if (start) {
        if (remaining !== 0 && fileStart) { fileStart.incomplete = true; }
        if (start.length >= 2 && start[1]) { file.galaxyName = start[1]; }
        let parts = 1;
        if (start.length >= 3 && start[2] !== '') {
          const parsed = Number(start[2]);
          if (Number.isFinite(parsed) && parsed >= 1) { parts = Math.floor(parsed); }
        }
        remaining = parts;
        fileStart = file;
        file.parts = [];
        this.galaxyFiles.push(file);
        files++;
      }
      const part = parseFunctionCall(file.afterInstall, 'after_install')
        || parseFunctionCall(file.afterInstall, 'after_install_dependency');
      if (!part) { continue; }
      if (remaining === 0 || !fileStart) {
        fail('a GOG Galaxy file part has no matching file start; this installer is not the'
          + ' layout this reader implements');
      }
      if (file.location >= this.dataEntries.length) {
        fail('a GOG Galaxy file part points past the chunk table');
      }
      remaining--;
      const inflated = Number(part[2]);
      if (!Number.isFinite(inflated) || inflated < 0) {
        fail(`cannot read the installed size of a file part ("${part[2] || 'missing'}")`);
      }
      const data = this.dataEntries[file.location];
      data.deflated = true;
      data.plainSize = inflated;
      if (!fileStart.parts) { fileStart.parts = []; }
      fileStart.parts.push(file.location);
      if (file !== fileStart) {
        this.foldedParts.add(file);           // part 2..n of a split file, folded into part 1
      }
    }
    if (remaining !== 0 && fileStart) { fileStart.incomplete = true; }
    if (files === 0 && this.isGogPackage) {
      fail('this GOG installer carries no file metadata in its setup script, so its real install'
        + ' layout cannot be recovered');
    }
  }

  /* Language tag from check_if_install('<langs>#', '<arch>', ''), or null when every known
     language is listed -- the same conclusion innoextract reaches by discarding constraints that
     name all languages (goggalaxy.cpp:420-448). A null tag means "installed for every language",
     so it must not be filtered out. */
  _languageTag(check) {
    const args = parseFunctionCall(check, 'check_if_install');
    if (!args || !args[0]) { return null; }
    const constraints = parseConstraints(args[0]);
    if (constraints.length === 0) { return null; }
    const wanted = constraints.filter((x) => !x.negated).map((x) => x.name);
    const known = this.languages.map((l) => l.name);
    if (known.length > 1 && wanted.length >= known.length
        && known.every((k) => wanted.indexOf(k) >= 0)) {
      return null;
    }
    return wanted.join(' ');
  }

  /* ---- public entry list --------------------------------------------------------- */

  /* Entries in installer order, i.e. the order a Windows install would lay them down. GOG Galaxy
     files appear once, under their real path, sized as installed; paths keep Inno's own
     separators and case because index.html normalises them with its own normalizePath().
     Left out, because they are not game data a Windows install would put on disk: shortcuts
     (type ttIcons), the extra MD5-named parts of a multi-part file (folded into the entry that
     starts the file), copies belonging to another language, and files whose bytes are not in this
     .exe at all -- ExternalSizePreset entries are read from the original CD/DVD by the installer,
     not from setup-0.inno. */
  _buildEntries(language) {
    const want = String(language).toLowerCase();
    const entries = [];
    for (const file of this.files) {
      if (file.type !== 0 || this.foldedParts.has(file)) { continue; }
      const path = file.galaxyName || file.destination;
      if (!path) { continue; }
      if (file.languages && file.languages.toLowerCase().split(' ').indexOf(want) < 0) {
        continue;
      }
      if (file.options & FILE_EXTERNAL_SIZE_PRESET) { continue; }
      /* Temporary: a Windows install would delete it again, and the reference's --exclude-temp
         drops it too, so it is not game data. See FILE_DELETE_AFTER_INSTALL above. */
      if (file.options & FILE_DELETE_AFTER_INSTALL) { continue; }
      let locations;
      if (file.parts && file.parts.length) {
        locations = file.parts;
      } else if (file.location < this.dataEntries.length) {
        locations = [file.location];
      } else {
        continue;                       // no payload chunk: nothing here to read
      }
      let size = 0;
      let comp = -1;
      let mixed = false;
      for (const loc of locations) {
        const data = this.dataEntries[loc];
        size += data.plainSize;
        const codec = data.deflated ? COMP_ZLIB : data.compression;
        if (comp < 0) { comp = codec; } else if (comp !== codec) { mixed = true; }
      }
      entries.push({
        path,
        size,
        comp: mixed ? -1 : comp,
        locations,
        incomplete: !!file.incomplete,
      });
    }
    this.entries = entries;
  }

  /* ---- streaming extraction ------------------------------------------------------- */

  /* Extract entry `index`, streaming.
       onBytes(view) -- called for each decoded piece; the view is only valid during the call
       options.keepBytes -- default true: also collect the pieces and return a Blob, which is what
           putAsset() wants (a Blob made of chunks is written to IndexedDB without the bytes ever
           being contiguous in JS memory). Pass false to stream without retaining anything, which
           is how the memory-profiled test stays inside its budget.
     Returns { bytes, blob }. Throws if the decoded byte count does not match the size the
     installer declared, so a silently short file is impossible. */
  async extract(index, onBytes, options = {}) {
    if (!this.codec) { throw new Error('this installer handle has been disposed'); }
    const entry = this.entries[index];
    if (!entry) { throw new RangeError(`there is no installer entry ${index}`); }
    const keep = options.keepBytes !== false;
    const parts = keep ? [] : null;
    let bytes = 0;
    const emit = (view) => {
      bytes += view.length;
      if (parts) { parts.push(new Uint8Array(view)); }
      if (onBytes) { onBytes(view); }
    };
    for (const loc of entry.locations) {
      await this._extractChunk(this.dataEntries[loc], emit);
    }
    if (bytes !== entry.size) {
      throw new Error(`${entry.path}: decoded ${bytes} bytes, the installer declares`
        + ` ${entry.size}`);
    }
    return { bytes, blob: parts ? new Blob(parts) : null };
  }

  /* The first entry whose Inno-style path matches `pattern`: a string compares case-insensitively
     against the path with backslashes folded to slashes (so 'DATA/Heroes2.agg' finds
     'DATA\\HEROES2.AGG'), a RegExp is tested against the same folded form. -1 when absent. */
  findEntry(pattern) {
    const fold = (text) => text.replace(/\\/g, '/');
    const needle = pattern instanceof RegExp ? pattern
      : new RegExp(`^${fold(String(pattern)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    for (let i = 0; i < this.entries.length; i++) {
      if (needle.test(fold(this.entries[i].path))) { return i; }
    }
    return -1;
  }

  /* Which ingest bucket an entry belongs to, using the same top-level folder names the game looks
     for (index.html's RELEVANT_PREFIXES). 'cd' is the raw-mode disc image whose ANIM/*.SMK films
     only become files once something reads the ISO inside it; `null` means the installer-side UI
     must not offer the entry at all (uninstaller, EULA, Galaxy support files, ...). */
  tierOf(entry) {
    const folded = entry.path.replace(/\\/g, '/').toLowerCase();
    if (folded === 'homm2.gog') { return 'cd'; }
    const slash = folded.indexOf('/');
    const top = slash < 0 ? folded : folded.slice(0, slash);
    if (top === 'data') { return 'data'; }
    if (top === 'maps') { return 'maps'; }
    if (top === 'music') { return 'music'; }
    if (top === 'anim' || top === 'anim2' || top === 'heroes2') { return 'anim'; }
    return null;
  }

  /* An entry worth handing to the game: a known folder, and complete (a GOG Galaxy file whose last
     part is not in this installer would otherwise be stored short). */
  isRelevant(entry) {
    return !entry.incomplete && this.tierOf(entry) !== null;
  }

  /* A random-access view over one entry: { size, read(offset, length) -> Uint8Array }, which is
     the source shape iso9660.js accepts. Needed because the video tier's payload is a 267 MiB
     disc image that Inno compressed into 26 chunks: reading one film means seeking to an offset
     inside chunk 17, and re-inflating from the start for every 512 KiB window would turn a
     sequential walk into quadratic work. So exactly one decoded chunk is cached -- the one the
     last read fell in -- which keeps sequential access linear and peak memory at one chunk
     (about 10 MiB here, Inno's own chunk size) plus the requested window.
     Not a general-purpose facility: extraction is single-threaded and the cache is not reentrant,
     so do not read two offsets through it at the same time. */
  createRangeSource(index) {
    if (!this.codec) { throw new Error('this installer handle has been disposed'); }
    const entry = this.entries[index];
    if (!entry) { throw new RangeError(`there is no installer entry ${index}`); }
    const self = this;
    /* Prefix sums of the chunk plaintext sizes: which chunk holds an offset, and where inside it. */
    const starts = [];
    let acc = 0;
    for (const loc of entry.locations) {
      starts.push(acc);
      acc += self.dataEntries[loc].plainSize;
    }
    let cache = null; /* { part, bytes } */
    return {
      size: entry.size,
      async read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > entry.size) {
          throw new RangeError(`read ${length} bytes at ${offset}: ${entry.path} holds ${entry.size}`);
        }
        const out = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const at = offset + filled;
          let part = starts.length - 1;
          while (part > 0 && starts[part] > at) { part--; }
          if (!cache || cache.part !== part) {
            const bytes = new Uint8Array(self.dataEntries[entry.locations[part]].plainSize);
            let written = 0;
            await self._extractChunk(self.dataEntries[entry.locations[part]], (view) => {
              bytes.set(view, written);
              written += view.length;
            });
            if (written !== bytes.length) {
              throw new Error(`a chunk of ${entry.path} decoded ${written} bytes, the installer`
                + ` declares ${bytes.length}`);
            }
            cache = { part, bytes }; /* the previous chunk is dropped here, not kept */
          }
          const from = at - starts[part];
          const take = Math.min(length - filled, cache.bytes.length - from);
          out.set(cache.bytes.subarray(from, from + take), filled);
          filled += take;
        }
        return out;
      },
    };
  }

  /* One `zlb\x1a` chunk: magic, codec properties, payload. Inno's chunk framing carries no
     payload length -- chunk.cpp reads the magic and trusts the caller's extent -- so the length
     comes from the chunk table, and a chunk is refused if its recorded size would run past the
     byte where the next chunk's magic is known to start. */
  async _extractChunk(data, emit) {
    const base = this.payloadOffset + data.offset;
    const room = data.regionEnd - data.offset;
    const magic = await readRange(this.file, base, 4);
    if (magic.length < 4 || magic[0] !== 0x7a || magic[1] !== 0x6c || magic[2] !== 0x62
        || magic[3] !== 0x1a) {
      fail(`no chunk magic ("zlb" + 0x1a) at ${base}: the chunk table does not match this file`);
    }
    if (data.chunkSize > room) {
      fail(`a chunk claims ${data.chunkSize} bytes at ${data.offset}, but only ${room} bytes are`
        + ' left before the next chunk starts');
    }
    /* Properties and payload start *after* the four magic bytes; `head` and therefore
       bodyOffset are both relative to body. */
    const body = base + 4;
    const head = await readRange(this.file, body, Math.min(READ_WINDOW, data.chunkSize + 4));
    const { props, offset: bodyOffset } = splitChunkProps(data.compression, head);
    const produced = await this.codec.pump(data.deflated ? COMP_ZLIB : data.compression, props,
      data.chunkSize,
      async (consumed, length) => {
        const want = Math.min(length, data.chunkSize - consumed);
        if (want <= 0) { return new Uint8Array(0); }
        const bytes = await readRange(this.file, body + bodyOffset + consumed, want);
        if (bytes.length < want) {
          throw new Error(`the installer is truncated inside a chunk at ${body + bodyOffset}`
            + ` + ${consumed}`);
        }
        return bytes;
      },
      emit);
    if (produced !== data.plainSize) {
      throw new Error(`a chunk at ${data.offset} decoded ${produced} bytes, the installer`
        + ` declares ${data.plainSize} for it`);
    }
  }
}

/* Split a chunk's leading bytes into codec properties and the offset where the payload starts.
   Inno writes the properties inline right after the magic (stream/lzma.cpp:60-101): none for
   stored and zlib -- there the zlib header *is* the first payload byte -- 5 bytes for LZMA1, one
   dictionary-code byte for LZMA2. An id this build cannot decode raises instead of being treated
   as stored, which is what turns a bogus header byte into an error rather than garbage output. */
function splitChunkProps(compression, bytes) {
  switch (compression) {
    case COMP_STORED:
    case COMP_ZLIB:
      return { props: new Uint8Array(0), offset: 0 };
    case COMP_LZMA1:
      if (bytes.length < 5) { fail('a chunk is too short to carry its LZMA1 properties'); }
      return { props: bytes.subarray(0, 5), offset: 5 };
    case COMP_LZMA2:
      if (bytes.length < 1) { fail('a chunk is too short to carry its LZMA2 dictionary code'); }
      return { props: bytes.subarray(0, 1), offset: 1 };
    default:
      fail(`chunk compression id ${compression} (${COMP_NAMES[compression] || 'not a method'})`
        + ' is not implemented by the extractor');
      return null;
  }
}

/* Ask the loaded codec whether it can open a compression id, without decoding anything. The UI
   can warn before a long extraction, and the test suite uses it to prove that an unknown id --
   which is what a corrupt or hostile setup header would produce -- is rejected outright by the
   codec instead of hanging or crashing the wasm instance. */
export async function codecSupport(compression, options = {}) {
  const wasm = await wasmInstance(options.wasmUrl);
  /* Plausible properties per kind, only so that open() gets something shape-correct to accept or
     reject: the check is about the id, not about the parameters. */
  const known = {
    0: new Uint8Array(0),
    1: new Uint8Array(0),
    3: new Uint8Array([0x5d, 0x00, 0x00, 0x80, 0x00]),
    4: new Uint8Array([0x13]),
  };
  const props = known[compression] || new Uint8Array(0);
  const ptr = wasm.alloc(Math.max(props.length, 1));
  if (!ptr) { throw new Error('cannot allocate extractor scratch memory'); }
  wasm.heap().set(props, ptr);
  const handle = wasm.sliceOpen(compression | 0, ptr, props.length);
  let code = 0;
  if (handle >= 0) { wasm.sliceClose(handle); } else { code = handle; }
  wasm.free(ptr);
  return { ok: handle >= 0, code, message: code < 0 ? (CODEC_ERRORS[code] || 'rejected') : 'ok' };
}

export { crc32, parseFunctionCall, parseConstraints, readRange };
