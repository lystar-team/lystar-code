(() => {
	"use strict";

	const terminalElement = document.getElementById("terminal");
	const fitAddon = new FitAddon.FitAddon();
	const decoder = new TextDecoder("utf-8");
	const term = new Terminal({
		allowProposedApi: false,
		allowTransparency: false,
		convertEol: false,
		cursorBlink: true,
		fontFamily: '"LYStar Mono CJK", "Cascadia Mono", Consolas, monospace',
		fontSize: 15,
		fontWeight: "400",
		letterSpacing: 0,
		lineHeight: 1.18,
		scrollback: 10000,
		theme: {
			background: "#101214",
			foreground: "#e7e9ec",
			cursor: "#55c2ff",
			cursorAccent: "#101214",
			selectionBackground: "#24506a",
			black: "#101214",
			red: "#ef6b73",
			green: "#70c991",
			yellow: "#e6be68",
			blue: "#67a7e8",
			magenta: "#c58be2",
			cyan: "#55c2c2",
			white: "#d8dadd",
			brightBlack: "#6e7681",
			brightRed: "#ff7b83",
			brightGreen: "#86d9a5",
			brightYellow: "#f0cb78",
			brightBlue: "#79b8ff",
			brightMagenta: "#d2a8ff",
			brightCyan: "#70d7d7",
			brightWhite: "#ffffff",
		},
		linkHandler: {
			activate: (_event, uri) => window.chrome.webview.postMessage(`open:${uri}`),
		},
	});

	term.loadAddon(fitAddon);
	term.open(terminalElement);
	term.onData((data) => window.chrome.webview.postMessage(`input:${data}`));
	term.onTitleChange((title) => {
		document.title = title || "LYStar Code";
		window.chrome.webview.postMessage(`title:${document.title}`);
	});
	term.attachCustomKeyEventHandler((event) => {
		if (!event.ctrlKey || !event.shiftKey || event.type !== "keydown") return true;
		if (event.code === "KeyC" && term.hasSelection()) {
			void navigator.clipboard.writeText(term.getSelection());
			return false;
		}
		if (event.code === "KeyV") {
			void navigator.clipboard
				.readText()
				.then((text) => window.chrome.webview.postMessage(`input:${text}`))
				.catch(() => {});
			return false;
		}
		return true;
	});

	function decodeBase64(value) {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return decoder.decode(bytes, { stream: true });
	}

	function fit() {
		fitAddon.fit();
		window.chrome.webview.postMessage(`resize:${term.cols},${term.rows}`);
	}

	window.chrome.webview.addEventListener("message", (event) => {
		const message = String(event.data ?? "");
		if (message.startsWith("data:")) {
			term.write(decodeBase64(message.slice(5)));
		} else if (message.startsWith("exit:")) {
			term.write(`\r\n\x1b[90m[进程已退出，代码 ${message.slice(5)}]\x1b[0m\r\n`);
		}
	});

	const resizeObserver = new ResizeObserver(fit);
	resizeObserver.observe(terminalElement);
	window.addEventListener("focus", () => term.focus());
	fit();
	term.focus();
	window.chrome.webview.postMessage("ready");
	document.fonts.ready.then(() => {
		fit();
		term.focus();
	});
})();