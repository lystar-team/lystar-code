const CACHE_PREFIX = "lystar-code-web-";
const CACHE_NAME = `${CACHE_PREFIX}shell-v2`;
const APP_SHELL = "/index.html";
const BYPASS_PATHS = ["/api", "/ws", "/healthz"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		fetch(new Request(APP_SHELL, { cache: "reload" }))
			.then(async (response) => {
				if (!response.ok) throw new Error(`App shell request failed: ${response.status}`);
				const cache = await caches.open(CACHE_NAME);
				await cache.put(APP_SHELL, response);
			})
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("push", (event) => {
	if (!event.data) return;
	const message = event.data.json();
	event.waitUntil(self.registration.showNotification(`${message.projectName} - ${message.sessionName}`, {
		body: message.text,
		tag: message.turnId,
		data: { sessionId: message.sessionId },
	}));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = event.notification.data?.sessionId;
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const client = windows.find((candidate) => new URL(candidate.url).origin === self.location.origin);
		if (client) {
			await client.focus();
			client.postMessage({ type: "open_session", sessionId });
		} else {
			await self.clients.openWindow(sessionId ? `/?sessionId=${encodeURIComponent(sessionId)}` : "/");
		}
	})());
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || BYPASS_PATHS.some((path) => url.pathname.startsWith(path))) return;
	if (request.mode !== "navigate" && request.destination !== "document") return;

	event.respondWith(
		fetch(request)
			.then(async (response) => {
				if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
					const cache = await caches.open(CACHE_NAME);
					await cache.put(APP_SHELL, response.clone());
				}
				return response;
			})
			.catch(async () => (await caches.match(APP_SHELL)) ?? Response.error()),
	);
});
