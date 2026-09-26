const CACHE_PREFIX = "lystar-code-web-";

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key))))
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
	if (request.method !== "GET" || request.mode !== "navigate") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	event.respondWith(fetch(request));
});
