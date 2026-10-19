// 此脚本先于应用资源执行；修改时同步 index.html 中的版本参数，避免长期缓存旧脚本。
(() => {
	const reloadKey = "lystar.web.startup-reload";
	let failed = false;

	function showFailure() {
		const panel = document.getElementById("startup-error");
		if (!panel) return;
		const app = document.getElementById("app");
		if (app) app.hidden = true;
		panel.hidden = false;
		panel.querySelector("a").addEventListener("click", () => {
			try {
				window.sessionStorage.removeItem(reloadKey);
			} catch {}
		});
	}

	async function recover() {
		if (failed || document.getElementById("app")?.childElementCount) return;
		failed = true;
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", showFailure, { once: true });
		} else {
			showFailure();
		}

		try {
			// 同一标签页只自动刷新一次，永久缺失时保留错误提示和手动入口。
			if (window.sessionStorage.getItem(reloadKey)) return;
			window.sessionStorage.setItem(reloadKey, "1");
			const response = await fetch(window.location.href, {
				cache: "no-store",
				headers: { Accept: "text/html" },
			});
			if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
				window.location.reload();
			}
		} catch {
			// 无法读取存储或连接服务时，由页面上的链接提供手动恢复。
		}
	}

	window.addEventListener(
		"error",
		(event) => {
			const target = event.target;
			const resource = target instanceof HTMLScriptElement
				? target.src
				: target instanceof HTMLLinkElement && (target.rel === "stylesheet" || target.rel === "modulepreload")
					? target.href
					: undefined;
			if (resource && new URL(resource).origin === window.location.origin) void recover();
		},
		true,
	);
	window.addEventListener("vite:preloadError", () => void recover());
	window.addEventListener("load", () => {
		if (failed) return;
		try {
			window.sessionStorage.removeItem(reloadKey);
		} catch {}
	});

	let theme;
	try {
		theme = window.localStorage.getItem("lystar.web.theme");
	} catch {}
	const dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.dataset.theme = theme === "light" || theme === "dark" ? theme : "";
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#151515" : "#ffffff");
	document
		.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
		?.setAttribute("content", dark ? "black-translucent" : "default");
})();
