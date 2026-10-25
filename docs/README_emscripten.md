# Emscripten (Wasm) Port of [fheroes2](README.md) Project

## Current Status of this Port

Please note that this port is currently still **experimental**. You may experience various problems, crashes, or it not even working at all in particular browsers.

## Building

### Prerequisites

* emsdk 4.0 or later
* GNU gettext

### Building using Docker

To save time, you can use a ready-made Docker image:

```sh
docker run --rm -v "$(pwd):/src" emscripten/emsdk:latest sh -c "apt-get -y update; apt-get -y install gettext; emmake make -f Makefile.emscripten"
```

### Building without Docker

If you do not want to use Docker, then you will need to install all the prerequisites manually using your platform's package manager, and then run the following command:

```sh
emmake make -f Makefile.emscripten
```

### Building with Additional Parameters

If you want to specify some additional ad hoc build parameters, you can use the appropriate environment variables for this. For example, the following command:

```sh
FHEROES2_WITH_THREADS=ON LDFLAGS="-sMODULARIZE -sEXPORTED_RUNTIME_METHODS=run -sEXPORT_NAME=fheroes2" emmake make -f Makefile.emscripten
```

will build a WebAssembly binary with multithreading support, as well as with additional parameters for creating a module.

### Rebuilding The Installer Extractor

Reading an installer in the browser needs a second, much smaller wasm module besides the engine: it holds
the decoders for the compression methods Inno Setup uses, while all the parsing and all the file I/O
happen in JavaScript (`files/emscripten/inno.js`). It is built by its own script and is rebuilt by
`script/pwa/build.sh` on every run, into `build/pwa`:

```sh
script/pwa/inno/build.sh          # writes script/pwa/inno/inno.wasm
script/pwa/inno/build.sh elsewhere  # or wherever the module is wanted
```

`emcc` has to be on `PATH` (source the emsdk environment first), and that is all: the module links only
sources vendored under `script/pwa/inno/third_party`, so the build downloads nothing and does not depend
on the game build, on emscripten ports, or on a configure step. The third-party terms are recorded in
`script/pwa/inno/LICENSES.md`.

The module is DOM-free and exports nothing but a C ABI, so it can be exercised without a browser:

```sh
node script/pwa/test/test-inno.mjs                     # codec and format checks, needs no installer
FH2_INNO_EXE=/path/to/setup_...exe node script/pwa/test/test-inno.mjs
```

With `FH2_INNO_EXE` set, the harness parses that installer and compares what it finds against
`innoextract` (set `FH2_INNO_ORACLE` to its path, and `FH2_INNO_ORACLE_LIST` to a saved
`innoextract --list-sizes -m` listing): every file name and size for `data`, `maps` and `music`, the
SHA-256 of a sample of extracted files, the films inside the CD image, plus the cases that must be
refused rather than misread -- a truncated file, a corrupt header, an unknown compression method. Without
the installer those checks are skipped, and without an `innoextract` to compare against the sizes are
still cross-checked against what the installer itself declares.

## Running the Wasm Port on a Web Server

### Configuring the Web Server

Emscripten uses web workers along with `SharedArrayBuffer` to support multithreading. `SharedArrayBuffer` usage is usually protected by Cross Origin Opener Policy (COOP)
and Cross Origin Embedder Policy (COEP) HTTP headers, and the web server should send these headers as part of its response to a request for resources related to the Wasm
build:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Please see the following link for details:

<https://web.dev/coop-coep>

### Copying Necessary Files

After the build is completed, copy the following files to the appropriate directory on your website:

```text
fheroes2.data
fheroes2.js
fheroes2.wasm
fheroes2.wasm.map (if fheroes2 has been built in debug mode)
```

If you want to use the stock launcher (pretty basic at the moment), then you will also need to copy all the files from `files/emscripten` to the same directory.

## Serving The Build

The stock launcher keeps the game files of the player in the browser, so it can only run from an HTTP(S)
origin: opening `index.html` from a file share does not work. For local testing,

```sh
script/pwa/build.sh        # assembles build/pwa, brotli and gzip copies included
script/pwa/serve.py build/pwa --port 8080
```

The development server exists because a plain static server gets two things wrong: the wasm binary has to
be served as `application/wasm` or the browser buffers and recompiles the whole file instead of streaming
it, and a precompressed copy has to be announced through `Content-Encoding` or it is transferred as opaque
bytes. The same applies to any other web server:

* `.wasm` has to be labelled `application/wasm`.
* `.webmanifest` has to be labelled `application/manifest+json`.
* Serving the `.br` and `.gz` copies with the matching `Content-Encoding` and a `Vary: Accept-Encoding`
  header takes the first load from roughly 22 MB down to about 9 MB, which is what makes the build
  practical on a phone.
* `sw.js` has to be served with `Cache-Control: no-cache`. A service worker that is not revalidated is
  only updated once the browser gives up polling for it, which on iOS can take a day.

`script/pwa/build.sh` names the cache of the service worker after a digest of the payload, so an updated
site is picked up by itself while a rebuild of unchanged sources does not make anybody download anything
again.

Multithreading, and with it the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers
described above, is only needed for a build with `FHEROES2_WITH_THREADS=ON`. The default build is single
threaded and runs without those headers, which matters because COEP also blocks any cross origin resource
that does not opt in.

## Playing As An Installed Application

The launcher asks for the game files once and keeps them on the device; nothing is uploaded anywhere.
There are four ways of handing them over:

* The GOG Windows installer for the game (`setup_heroes_of_might_and_magic_2_gold_*.exe`). The launcher
  reads the Inno Setup payload in the browser and stores the `data`, `maps` and `music` folders it finds
  inside, so nothing has to be unpacked on another machine first. The installer is never buffered whole:
  each file is fetched by byte range, decoded in 256 KiB pieces and stored as soon as it is complete. The
  animation videos sit in a raw CD image inside the same
  installer and account for half its size, so they are only extracted when the box that offers them is
  ticked; unticked, the import ends as soon as the game itself is stored. Only the bytes of the file being
  extracted are ever in memory, so the size of the installer is not limited by the memory of the tab.

* A ZIP archive of the game folder, or of the `data` folder. The archive is unpacked in the browser, entry
  by entry, so the size of the archive is not limited by the memory of the tab. This works everywhere.
* The `data` folder itself, where the browser supports picking a folder. iOS only offers this from 18.4
  on; the option is hidden on older systems.
* Individual files, which is also the fallback on any browser. The folder a picked file came from is lost,
  so files are placed by their extension: `.agg`, `.h2c` and `.h2d` are treated as data, `.mp2` as a map,
  `.smk` as a video and `.ogg`, `.mp3`, `.flac` as music.

`data/HEROES2.AGG` is required; everything else is optional.

Saved games, settings and downloaded content live in a second store that survives an update of the build
and is only cleared by the Forget button, which removes the imported game files and nothing else.

### Installing On An iPhone Or iPad

The build is a progressive web app: serve it over HTTPS, open it in Safari, use the Share button and
*Add to Home Screen*. Afterwards it starts without the browser interface, keeps the engine and the game
files offline and is not fetched from the network on every launch.

Things worth knowing about iOS:

* The first start needs a download of a few megabytes; every later start is served from local storage.
* The memory of a web page is capped. The build limits its linear memory to 1 GiB for that reason, which
  is plenty: a game sitting at the main menu uses around 130 MB.
* Sound starts with the tap that launches the engine. Browsers refuse to let a page make noise before a
  gesture, and a WebAssembly application opens its audio device long after that tap, so the launcher
  creates the audio context while the tap is still happening and hands it to the port.
* Touch is used instead of a mouse where the game offers touch controls, and the on screen keyboard of the
  game is used for typing, since a canvas cannot summon the keyboard of the system.
* A phone may reclaim the memory of a backgrounded web app. Imported files and saved games are on disk and
  survive that; an interrupted battle does not.

### Notes For Other Browsers

Desktop browsers, Android Chrome and Firefox work the same way; Chrome and Edge additionally offer their
own install prompt. Only Safari needs the Apple specific meta tags and the *Add to Home Screen* gesture.

The game needs a browser with WebAssembly, `Asyncify`, IndexedDB and, to accept a ZIP archive,
`DecompressionStream`. Safari 16.4, Chrome 103 and Firefox 113 or later have all of them.
