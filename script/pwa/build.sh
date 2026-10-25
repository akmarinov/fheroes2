#!/bin/sh
#
# Assembles a deployable directory for the WebAssembly build: the runtime produced by
# Makefile.emscripten, the launcher from files/emscripten and a precompressed copy of every static
# asset. Precompression matters: the wasm binary gives up roughly two thirds of its size, which is the
# difference between a usable and an unusable first load on a phone.
#
# Usage: script/pwa/build.sh [output directory]

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
out=${1:-"$root/build/pwa"}

source_dir="$root/files/emscripten"
runtime_dir="$root"

for required in fheroes2.js fheroes2.wasm fheroes2.data; do
    if [ ! -f "$runtime_dir/$required" ]; then
        echo "error: $required is missing, build the WebAssembly target first:" >&2
        echo "       emmake make -f Makefile.emscripten" >&2
        exit 1
    fi
done

if ! command -v brotli >/dev/null 2>&1; then
    echo "error: the brotli command line tool is required (brew install brotli)" >&2
    exit 1
fi

revision=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo development)

rm -rf "$out"
mkdir -p "$out"

cp "$runtime_dir"/fheroes2.js "$runtime_dir"/fheroes2.wasm "$runtime_dir"/fheroes2.data "$out"/
cp "$source_dir"/index.html "$source_dir"/manifest.webmanifest "$source_dir"/sw.js "$source_dir"/fheroes2.jpeg "$out"/
cp -R "$source_dir"/icons "$out"/icons

# The worker keeps every asset of one build under a cache named after this string, so it has to change
# whenever the payload changes and must not change when it does not: a rebuild of unchanged sources has
# to reuse what the phone already downloaded. A digest of the payload gives both properties, where a
# bare revision would keep a dirty work tree, and therefore a stale launcher, under an old name.
# macOS ships shasum rather than sha256sum, so either spelling of the same digest will do. The name
# avoids `hash`, which is a builtin of the more featureful shells.
if command -v sha256sum >/dev/null 2>&1; then
    digest_of() { sha256sum "$@"; }
else
    digest_of() { shasum -a 256 "$@"; }
fi

digest=$(digest_of "$out"/fheroes2.js "$out"/fheroes2.wasm "$out"/fheroes2.data "$out"/index.html | cut -c1-16 | digest_of | cut -c1-10)

version="$revision-$digest"

# The worker has to be versioned before it is compressed, otherwise a new release would keep serving
# the assets of the previous one out of the cache.
sed "s/__FH2_VERSION__/$version/" "$out"/sw.js >"$out"/sw.js.tmp && mv "$out"/sw.js.tmp "$out"/sw.js

# Images are already compressed, so only the code, the data bundle and the documents are worth
# transforming. A server that prefers one encoding over the other picks the matching sidecar.
for file in fheroes2.js fheroes2.wasm fheroes2.data index.html manifest.webmanifest sw.js; do
    brotli -q 11 -k -f "$out/$file" -o "$out/$file.br"
    gzip -c -9 -n -f "$out/$file" >"$out/$file.gz"
done

rm -f "$out"/fheroes2.wasm.map

echo "assembled revision $version in $out"
du -sh "$out"
