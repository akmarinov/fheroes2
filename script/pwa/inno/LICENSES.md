# Licences for `inno.wasm`

`inno.wasm` is linked from code written for this repository plus three third-party decoder
libraries, all vendored under `third_party/` so the build needs nothing but an emsdk on `PATH`.
Nothing here is downloaded at build time and nothing is linked from a system package.

## `fh2_inno.c` (this directory)

Released under the same Zlib licence as the rest of the fheroes2 PWA tooling: use, commercial
use and redistribution are permitted, altered versions must be marked as altered, and this
notice may not be removed or altered. No warranty, no liability.

## `third_party/lzma/` -- LZMA SDK

- **What**: `LzmaDec.c`, `Lzma2Dec.c`, `LzmaDec.h`, `Lzma2Dec.h`, `7zTypes.h`, `Compiler.h`,
  `Precomp.h`, taken from the 7-Zip LZMA SDK (`LzmaDec.c` dated 2023-04-07, `Lzma2Dec.c`
  2024-03-01, `7zTypes.h` 2024-01-24 -- the dates are in the first comment of each file).
- **Author**: Igor Pavlov.
- **Licence**: public domain, as stated in the header comment of every file:
  `Igor Pavlov : Public domain`. There is no licence text to ship, which is one of the two
  reasons the SDK was chosen over liblzma; the other is that the decoder pair is two `.c` files
  with no build system and no `Alloc.c` (they take an allocator struct, which `fh2_inno.c`
  supplies from `malloc`/`free`).
- **What it decodes**: LZMA1 (Inno's block container, `stream/lzma.cpp:60-79`) and LZMA2 (this
  installer's payload chunks, `stream/lzma.cpp:81-104`).

## `third_party/zlib/` -- zlib 1.3.2, inflate subset

- **What**: `inflate.c`, `inftrees.c`, `inffast.c`, `adler32.c`, `crc32.c`, `zutil.c` and the
  headers `zlib.h`, `zconf.h`, `zutil.h`, `inflate.h`, `inftrees.h`, `inffast.h`, `crc32.h`.
  Files that would add code this module cannot reach -- the deflate encoder, `gz*.c`,
  `deflate.c`, `trees.c`, `uncompr.c`, `minizip` -- are deliberately absent.
- **Authors**: Jean-loup Gailly and Mark Adler.
- **Licence**: the Zlib licence, reproduced verbatim in `third_party/zlib/LICENSE`, and repeated
  in the header comment of each source file. It permits use, alteration and redistribution in
  source or binary form, requires that alterations are marked as such, and forbids misrepresenting
  the origin. No warranty, no liability.
- **What it decodes**: Inno's `zlib` chunks, which are ordinary deflate streams with a zlib
  wrapper (`stream/chunk.cpp:196-206` hands them to a plain `inflateInit`), plus the CRC32 used
  for block and sub-block headers, which is the reflected, 0xxFFFFFFFF-initialised CRC-32 that
  `crypto/crc32.hpp` calls `CRC32_NEGL`.
- **Why vendor it at all**: emscripten can supply zlib through `-sUSE_ZLIB=1`, but that port is
  fetched from the network on first use, which would make the build non-reproducible from the
  repository alone.

## Not vendored, and why

- **liblzma** (`xz/src/liblzma`): functionally equivalent for both LZMA variants and under a
  0BSD licence, but a decoders-only build needs roughly forty source files across `common/`,
  `lzma/`, `simple/` and `check/` plus a `config.h` that only autoconf or CMake generates. That
  is a second build system inside this repository for no gain, so it was rejected. The recipe
  for such a build exists in `xz` upstream (`CMakeLists.txt` plus
  `-DCMAKE_TOOLCHAIN_FILE=<emsdk>/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`)
  if this decision is ever revisited.
- **bzip2**: `stream/chunk.cpp:225-236` gives compression id 2 to bzip2, and Inno Setup has never
  emitted it for a release build. No chunk in the Heroes of Might and Magic II installer uses it
  -- the payload is LZMA2 with a set of deflate-wrapped GOG Galaxy parts -- so the codec reports
  `FH2_ERR_UNSUPPORTED` (-9) for id 2 instead of carrying a second decompressor. `inno.js`
  refuses a chunk with that id before reading it.

## Reference implementation consulted

The byte layouts parsed by `inno.js` and the containers decoded by `fh2_inno.c` were read from
**dscharrer/innoextract** (<https://maypos.de/innoextract/>, Zlib licence), which documents the
Inno Setup format file by file. No source file from it is linked, included or copied into this
repository; the citations in the comments of `inno.js` and `fh2_inno.c` point at the copy that was
read, in the form `stream/block.cpp:153`, and are there so the parsing can be re-checked against
it. Its Zlib licence imposes nothing on this repository precisely because nothing of it is
distributed here.
