#!/usr/bin/env python3
"""Serve an assembled WebAssembly build with the headers the runtime expects.

A plain `python -m http.server` is not enough for three reasons: the wasm binary has to be labelled
`application/wasm` or the browser cannot stream-compile it and falls back to buffering the whole file,
the precompressed sidecars produced by build.sh have to be advertised through Content-Encoding or they
are served as opaque bytes, and every answer needs `Cache-Control: no-cache`, for the reason given under
the imports.

`--tls` serves over HTTPS as well, which on iOS is not a preference: a page reached over plain HTTP at
a LAN address is not a secure origin, so `navigator.serviceWorker` is not merely refused but absent,
nothing is cached for offline, and the imported game files live in storage iOS treats as disposable. It
is the difference between testing the installed app and testing a web page. The key and certificate are
self-signed, kept in the user cache directory rather than the served one, and no browser will accept them
until the private root behind them is installed on the device; the address to use is printed on start-up.

Usage: script/pwa/serve.py [directory] [--host HOST] [--port PORT] [--tls [PORT]]
"""

import argparse
import functools
import hashlib
import ipaddress
import mimetypes
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")

# Nothing in the assembled directory may be cached without revalidating: build.sh writes the same names
# every time, so `fheroes2.wasm` of the next build is a different file under the same URL, and a response
# marked immutable would pin a phone to the engine of an old build - which pairs badly with a launcher
# that stages the videos differently (see docs/README_emscripten.md). The worker keeps whole builds under
# a name derived from their digest and always refetches them, so long max-age here buys nothing.

# The worker only registers on https and localhost origins, so a phone on the LAN needs TLS to get the
# offline cache at all. Nothing on the network will trust a key minted here, so the point is a private root
# which the phone is told about once: the leaf is signed by it and iOS is walked through installing it.
# Ten years on the root and 820 days on the leaf, because iOS refuses a certificate whose validity runs
# longer than 825 days, and re-trusting a root on a phone is the annoying part.
ROOT_COMMON_NAME = "fheroes2 development root"
ROOT_CERT_NAME = "fheroes2-root-ca.cer"
LEAF_VALID_DAYS = 820


def certificate_directory() -> str:
    """Where the private keys live."""
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(cache, "fheroes2-pwa")


def _openssl(arguments) -> None:
    if shutil.which("openssl") is None:
        raise RuntimeError("openssl is not installed, and it is needed to mint the development certificate")

    # openssl puts the interesting half of a failure on stderr and exits non-zero. Forwarding it beats
    # generating nothing and then failing to bind the socket.
    result = subprocess.run(["openssl", *arguments], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"openssl {arguments[0]} failed: {result.stderr.strip() or 'no output'}")


def _private(path: str) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def dev_certificate(host: str) -> tuple:
    """Return (chain, key, root) for `host`, minting whatever is missing.

    The root is shared by every address so a phone which has trusted it once keeps working when the Mac's
    lease changes; leaves are named after the address they answer for, because iOS compares the name in the
    certificate with the name typed into the address bar.
    """
    directory = certificate_directory()
    os.makedirs(directory, exist_ok=True)

    root_key = os.path.join(directory, "root-ca.key")
    root_pem = os.path.join(directory, "root-ca.pem")
    root_der = os.path.join(directory, ROOT_CERT_NAME)

    if not os.path.isfile(root_pem):
        _openssl(
            [
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                "-keyout", root_key, "-out", root_pem,
                "-subj", f"/CN={ROOT_COMMON_NAME}",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            ]
        )
        # DER under a .cer name, the shape iOS offers to install from a download.
        _openssl(["x509", "-in", root_pem, "-outform", "der", "-out", root_der])
        _private(root_key)

    try:
        ipaddress.ip_address(host)
        names = f"IP:{host}"
    except ValueError:
        names = f"DNS:{host}"
    names += ",DNS:localhost"

    leaf_key = os.path.join(directory, f"leaf-{hashlib.sha256(names.encode()).hexdigest()[:12]}.key")
    leaf = leaf_key[: -len(".key")] + ".pem"
    chain = leaf_key[: -len(".key")] + "-chain.pem"

    if not os.path.isfile(leaf):
        with tempfile.TemporaryDirectory() as scratch:
            request = os.path.join(scratch, "leaf.csr")
            extensions = os.path.join(scratch, "leaf.cnf")
            with open(extensions, "w") as handle:
                handle.write(
                    "basicConstraints=critical,CA:FALSE\n"
                    "keyUsage=critical,digitalSignature,keyEncipherment\n"
                    "extendedKeyUsage=serverAuth\n"
                    f"subjectAltName={names}\n"
                )
            _openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={host}",
                      "-keyout", leaf_key, "-out", request])
            # LibreSSL on macOS drops extensions passed through -addext when signing a request, so the
            # block has to arrive as a file or the subject alternative name never reaches the certificate.
            _openssl(["x509", "-req", "-in", request, "-CA", root_pem, "-CAkey", root_key, "-CAcreateserial",
                      "-out", leaf, "-days", str(LEAF_VALID_DAYS), "-sha256", "-extfile", extensions])
        _private(leaf_key)

    if not os.path.isfile(chain):
        with open(chain, "w") as handle:
            for path in (leaf, root_pem):
                with open(path) as source:
                    handle.write(source.read())

    return chain, leaf_key, root_der


def secure_server(root: str, host: str, port: int) -> tuple:
    """Bind `host:port` and answer it over TLS."""
    chain, key, root_der = dev_certificate(host)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.load_cert_chain(chain, key)
    except ssl.SSLError as error:
        raise RuntimeError(f"the development certificate for {host} cannot be used: {error}") from error

    server = plain_server(root, host, port)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    return server, root_der


def plain_server(root: str, host: str, port: int) -> ThreadingHTTPServer:
    # The build directory is replaced wholesale by every rebuild, so the handler is anchored to an
    # absolute path rather than to the process working directory: a server left inside a directory that
    # build.sh deleted would fail every request with "no such file or directory".
    handler = functools.partial(Handler, directory=root)
    return ThreadingHTTPServer((host, port), handler)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Paths answered from outside the build directory, filled in by main when TLS is on. A class
    # attribute because the base class owns the constructor, and one server serves one build anyway.
    extras: dict = {}

    def send_head(self):
        # A phone installs a trust profile by downloading the root rather than by being shown it in a tab,
        # so the certificate the key directory holds has to be reachable over the connection it secures.
        extra = self.extras.get(urlsplit(self.path).path)
        if extra:
            if not os.path.isfile(extra):
                self.send_error(HTTPStatus.NOT_FOUND, "no such certificate")
                return None
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-type", "application/x-x509-ca-cert")
            self.send_header("Content-Length", str(os.path.getsize(extra)))
            # A root which has been re-minted has to replace the one a phone cached, not sit behind it.
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(extra)}"')
            self.end_headers()
            return open(extra, "rb")

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

        # Everything which exists is revalidated. The names of the build do not carry a fingerprint, so
        # no response here may be kept without asking: a phone which cached the engine of one build under
        # `immutable` would boot it beside the launcher of the next, and the two are only safe as a pair.
        # The worker answers the repeat visits out of its own cache, so revalidation costs little.
        if os.path.isfile(self.translate_path(getattr(self, "logical_path", self.path))):
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
    parser.add_argument(
        "--tls",
        type=int,
        nargs="?",
        const=8443,
        default=None,
        metavar="PORT",
        help="also answer over HTTPS on PORT, minting a key and certificate for --host",
    )
    arguments = parser.parse_args()

    root = os.path.abspath(arguments.directory)

    if not os.path.isfile(os.path.join(root, "index.html")):
        print(f"error: {root} holds no index.html, run script/pwa/build.sh first", file=sys.stderr)
        return 1

    servers = [plain_server(root, arguments.host, arguments.port)]
    print(f"serving {root} on http://{arguments.host}:{arguments.port}/")

    if arguments.tls is not None:
        if arguments.host in ("0.0.0.0", "::", "*"):
            # A certificate is checked against the address typed into the bar, and no address matches a
            # wildcard, so binding every interface is fine while minting for it is useless.
            print("error: --tls needs the --host the phone will type, not a wildcard like 0.0.0.0", file=sys.stderr)
            servers[0].server_close()
            return 1
        try:
            secured, root_der = secure_server(root, arguments.host, arguments.tls)
        except (RuntimeError, OSError) as error:
            # Either the key could not be minted or the port is taken; both want one line, not a traceback.
            print(f"error: {error}", file=sys.stderr)
            servers[0].server_close()
            return 1

        servers.append(secured)

        # The root is public information - only its key stays on disk - so it can travel over either socket.
        Handler.extras = {f"/{ROOT_CERT_NAME}": root_der}

        print(f"serving it over HTTPS on https://{arguments.host}:{arguments.tls}/")
        print(f"    to install the app on a phone, open https://{arguments.host}:{arguments.tls}/{ROOT_CERT_NAME},")
        print("    install the downloaded profile, then turn it on in Settings > General > About >")
        print("    Certificate Trust Settings, and use the https address from then on")
    elif arguments.host not in ("localhost", "127.0.0.1", "::1"):
        print("note: over plain http a phone registers no service worker, so nothing is cached; add --tls")

    try:
        # Both sockets answer the same build; the extra one only needs to be off the main thread so that
        # Ctrl-C still reaches the first, which is the one people are told to open.
        for server in servers[1:]:
            threading.Thread(target=server.serve_forever, daemon=True).start()

        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
