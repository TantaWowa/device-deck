const SHELL = "device-deck-portal-shell-v1";
const SHELL_PATHS = ["/app/", "/app/index.html", "/app/manifest.webmanifest", "/app/icon.svg", "/app/icon-192.png", "/app/icon-512.png"];
const isShell = (url) => url.origin === self.location.origin && !url.search &&
  (SHELL_PATHS.includes(url.pathname) || /^\/app\/assets\/[^/]+\.(?:js|css|woff2?|svg|png)$/.test(url.pathname));
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_PATHS)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("device-deck-portal-shell-") && key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((value) => {
    try { return isShell(new URL(value, self.location.origin)); } catch { return false; }
  });
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(urls)).catch(() => {}));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Never store account APIs, Firebase requests, configuration, or machine traffic.
  if (request.method !== "GET" || request.headers.has("Authorization") || !isShell(url)) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      void caches.open(SHELL).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("/app/");
      if (shell) return shell;
    }
    return Response.error();
  }));
});
