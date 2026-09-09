const CACHE_NAME = "lystar-code-web-v1";
const APP_SHELL = ["/", "/index.html"];
const BYPASS_PATHS = ["/api", "/ws", "/healthz"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(APP_SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin || BYPASS_PATHS.some((path) => url.pathname.startsWith(path))) return;

	if (request.destination === "document") {
		event.respondWith(
			fetch(request).catch(() => caches.match("/index.html").then((response) => response ?? caches.match("/"))),
		);
		return;
	}

	if (!["script", "style", "image", "font"].includes(request.destination)) return;

	event.respondWith(
		fetch(request)
			.then((response) => {
				if (!response.ok) return response;
				const copy = response.clone();
				void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
				return response;
			})
			.catch(() => caches.match(request)),
	);
});
