import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { installBrowserDiagnostics, recordBrowserDiagnostic } from "./lib/browser-diagnostics";
import { initializeAppInstallCapture } from "./state/use-app-install";
import "./styles/tokens.css";
import "./styles/prose.css";
import "./styles.css";

const SERVICE_WORKER_CACHE_PREFIX = "lystar-code-web-";
const root = document.documentElement;
root.dataset.platform = /Mac/i.test(navigator.userAgent)
	? "macos"
	: /Windows/i.test(navigator.userAgent)
		? "windows"
		: "linux";

installBrowserDiagnostics();
initializeAppInstallCapture();

async function configureServiceWorker(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.register(import.meta.env.PROD ? "/sw.js" : "/sw-dev.js", {
		scope: "/",
		updateViaCache: "none",
	});
	await registration.update();
	await navigator.serviceWorker.ready;
	if (!import.meta.env.PROD && "caches" in window) {
		const keys = await caches.keys();
		await Promise.all(keys.filter((key) => key.startsWith(SERVICE_WORKER_CACHE_PREFIX)).map((key) => caches.delete(key)));
	}
}

window.addEventListener("load", () => {
	void configureServiceWorker().catch((error) => recordBrowserDiagnostic("service-worker", error));
});

createRoot(document.getElementById("app")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
