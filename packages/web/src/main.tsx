import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/tokens.css";
import "./styles/prose.css";
import "./styles.css";

const root = document.documentElement;
root.dataset.platform = /Mac/i.test(navigator.userAgent)
	? "macos"
	: /Windows/i.test(navigator.userAgent)
		? "windows"
		: "linux";

createRoot(document.getElementById("app")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
