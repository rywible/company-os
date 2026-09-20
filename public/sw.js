// Cache only a public offline screen and public static assets. Never cache API
// responses, documents, conversations, login requests, or submitted mutations.
const CACHE = "company-os-public-v3";
const PUBLIC_FILES = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PUBLIC_FILES)),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("company-os-public-") && key !== CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/healthz"
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match("/offline.html")) || Response.error(),
      ),
    );
    return;
  }
  if (PUBLIC_FILES.includes(url.pathname))
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
});
