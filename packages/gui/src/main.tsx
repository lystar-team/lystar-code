import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./workflow.css";

document.documentElement.dataset.platform = /Mac/i.test(navigator.userAgent)
	? "macos"
	: /Windows/i.test(navigator.userAgent)
		? "windows"
		: "linux";

const root = document.getElementById("root");
if (!root) throw new Error("Missing GUI root element");

createRoot(root).render(<App />);
