#!/bin/sh
#
# Builds files/emscripten/inno.wasm: the decoders for the payload of an Inno Setup 5.6.2
# installer. Everything it links is vendored under script/pwa/inno/third_party, so this script
# needs nothing but an emsdk on PATH -- no ports, no downloads, no configure step. The result is
# deliberately independent of the game build: the extractor is loaded by the ingest UI, not by the
# engine, and it has to be rebuildable without building fheroes2.
#
# Why the LZMA SDK and not liblzma: both decode the same formats, but the SDK is two C files
# (LzmaDec.c, Lzma2Dec.c) plus their headers and 7zTypes.h/Compiler.h/Precomp.h, with no build
# system at all, whereas a decoders-only liblzma needs some forty files plus a generated
# config.h. Both LzmaDec and Lzma2Dec take an allocator struct, so the SDK needs no Alloc.c
# either: fh2_inno.c hands it plain malloc/free. Public domain beats 0BSD for vendoring only in
# that there is no licence text to carry. zlib is vendored as the inflate subset -- Inno's zlib
# chunks are ordinary deflate streams with a zlib wrapper (stream/chunk.cpp:196-206 hands them to
# a plain inflateInit), so nothing but inflate/adler32/crc32, their tables and zutil is linked.
# See LICENSES.md for the terms of everything that ends up in the binary.
#
# Flags: -Oz with -flto because the budget is 400 KB for the whole module; -fno-exceptions since
# nothing here throws; -sSTANDALONE_WASM so the module needs no emscripten runtime (fh2_inno.c
# uses nothing from libc but malloc/free/memcpy); INITIAL_MEMORY at 16 MiB with growth allowed,
# which is where the header block decode lands. No asyncify: the pump is synchronous by design
# and JavaScript owns every byte of I/O.
#
# Usage: script/pwa/inno/build.sh [output directory]     (default: this directory)

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v emcc >/dev/null 2>&1; then
    echo "error: emcc is not on PATH; source the emsdk environment first" >&2
    exit 1
fi

out_dir=${1:-"$here"}
mkdir -p "$out_dir"

zlib_dir="$here/third_party/zlib"
lzma_dir="$here/third_party/lzma"

for required in "$zlib_dir/inflate.c" "$zlib_dir/LICENSE" "$lzma_dir/LzmaDec.c" "$lzma_dir/Lzma2Dec.c"; do
    if [ ! -f "$required" ]; then
        echo "error: $required is missing; the vendored decoders are part of the repository" >&2
        exit 1
    fi
done

emcc -Oz -flto -fno-exceptions -fno-rtti \
    -DZ_NO_COMPRESS \
    -I"$zlib_dir" -I"$lzma_dir" \
    -sSTANDALONE_WASM \
    -Wl,--no-entry \
    -sINITIAL_MEMORY=16777216 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_FUNCTIONS=_fh2_abi_version,_fh2_probe,_fh2_block_decode,_fh2_slice_open,_fh2_slice_pump,_fh2_slice_consumed,_fh2_slice_finished,_fh2_slice_error,_fh2_slice_close,_fh2_alloc,_fh2_free,_malloc,_free \
    -o "$out_dir/inno.wasm" \
    "$here/fh2_inno.c" \
    "$zlib_dir/inflate.c" "$zlib_dir/inftrees.c" "$zlib_dir/inffast.c" \
    "$zlib_dir/adler32.c" "$zlib_dir/crc32.c" "$zlib_dir/zutil.c" \
    "$lzma_dir/LzmaDec.c" "$lzma_dir/Lzma2Dec.c"

echo "built $out_dir/inno.wasm ($(wc -c <"$out_dir/inno.wasm" | tr -d ' ') bytes)"
