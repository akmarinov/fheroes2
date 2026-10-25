/*
 * Offline support for the WebAssembly build.
 *
 * The engine is a 9 MB wasm binary plus a 12 MB data bundle, so re-downloading them on every launch is
 * not acceptable on a phone; everything that ships with the build is cached up front and served from the
 * cache afterwards. The game files imported by the player never go through here: they live in IndexedDB.
 *
 * VERSION is replaced by script/pwa/build.sh with the revision of the build, which is what makes an
 * updated release invalidate these entries.
 */

const VERSION = "__FH2_VERSION__";
const CACHE = `fheroes2-${VERSION}`;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./fheroes2.js",
  "./fheroes2.wasm",
  "./fheroes2.data",
  "./fheroes2.jpeg",
  "./inno.js",
  "./inno.wasm",
  "./iso9660.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // One file missing from a build must not abort the whole installation, so failures are collected and
    // only reported: the page keeps working with whatever did get cached.
    const failures = [];

    await Promise.all(SHELL.map(async path => {
      try {
        await cache.add(new Request(path, { cache: "reload" }));
      }
      catch (error) {
        failures.push(`${path}: ${error}`);
      }
    }));

    if (failures.length > 0) {
      console.warn("Some resources could not be cached:", failures);
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("fheroes2-") && key !== CACHE) {
        await caches.delete(key);
      }
    }

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);

    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(request);

      // Anything else the page legitimately pulls from the same origin is worth remembering as well.
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);

        cache.put(request, response.clone());
      }

      return response;
    }
    catch (error) {
      // A navigation while offline has to land on the shell rather than on a browser error page.
      if (request.mode === "navigate") {
        const shell = await caches.match("./index.html");

        if (shell) {
          return shell;
        }
      }

      throw error;
    }
  })());
});
