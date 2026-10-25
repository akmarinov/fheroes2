#!/usr/bin/env python3
"""Serve an assembled WebAssembly build with the headers the runtime expects.

A plain `python -m http.server` is not enough for two reasons: the wasm binary has to be labelled
`application/wasm` or the browser cannot stream-compile it and falls back to buffering the whole file,
and the precompressed sidecars produced by build.sh have to be advertised through Content-Encoding or
they are served as opaque bytes.

Usage: script/pwa/serve.py [directory] [--host HOST] [--port PORT]
"""

import argparse
import functools
import mimetypes
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")

# Only content whose fingerprint cannot change under the same name may be cached forever: the assets
# carrying the revision in the worker are requested by URL, everything else has to be revalidated.
IMMUTABLE_SUFFIXES = (".wasm", ".data", ".png", ".jpg", ".jpeg")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_head(self):
        # Negotiation has to happen before the headers are emitted: the base class derives
        # Content-Length from the file it is about to open, so switching to a sidecar afterwards would
        # announce the length of the uncompressed asset while sending the compressed one.
        self.content_encoding = None
        self.logical_path = self.path
        encoding = self.headers.get("Accept-Encoding", "")

        if "?" not in self.path:
            for suffix, name in ((".br", "br"), (".gz", "gzip")):
                if name in encoding and os.path.isfile(self.translate_path(self.path + suffix)):
                    self.path += suffix
                    self.content_encoding = name
                    break

        return super().send_head()

    def end_headers(self):
        if getattr(self, "content_encoding", None):
            self.send_header("Content-Encoding", self.content_encoding)

        # Every answer below depends on the request headers, compressed or not.
        self.send_header("Vary", "Accept-Encoding")

        # An error response never reaches send_head(), so the fields set there may be missing. The
        # worker has to be revalidated on every navigation, or an update is only picked up once the
        # browser gives up polling for it, which on iOS can take a day; anything named after a
        # revision of the build may be kept for a year.
        origin = getattr(self, "logical_path", self.path)

        if origin.startswith("/sw.js"):
            self.send_header("Cache-Control", "no-cache")
        elif origin.endswith(IMMUTABLE_SUFFIXES):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif os.path.isfile(self.translate_path(self.path)):
            self.send_header("Cache-Control", "no-cache")

        super().end_headers()

    def guess_type(self, path):
        # The sidecar has no useful extension of its own, so the type comes from the original name.
        for suffix in (".br", ".gz"):
            if path.endswith(suffix):
                path = path[: -len(suffix)]
                break

        return super().guess_type(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", nargs="?", default="build/pwa", help="directory assembled by build.sh")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    arguments = parser.parse_args()

    root = os.path.abspath(arguments.directory)

    if not os.path.isfile(os.path.join(root, "index.html")):
        print(f"error: {root} holds no index.html, run script/pwa/build.sh first", file=sys.stderr)
        return 1

    # The build directory is replaced wholesale by every rebuild, so the handler is anchored to an
    # absolute path rather than to the process working directory: a server left inside a directory that
    # build.sh deleted would fail every request with "no such file or directory".
    handler = functools.partial(Handler, directory=root)

    server = ThreadingHTTPServer((arguments.host, arguments.port), handler)

    print(f"serving {root} on http://{arguments.host}:{arguments.port}/")
    if arguments.host not in ("localhost", "127.0.0.1", "::1"):
        print("note: a service worker only registers on https or localhost origins")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
