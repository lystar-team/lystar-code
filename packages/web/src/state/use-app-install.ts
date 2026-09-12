import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
	prompt: () => Promise<void>;
}

type InstallPromptSubscriber = (prompt: BeforeInstallPromptEvent | undefined) => void;

let capturedInstallPrompt: BeforeInstallPromptEvent | undefined;
let captureInitialized = false;
const installPromptSubscribers = new Set<InstallPromptSubscriber>();

function publishInstallPrompt(prompt: BeforeInstallPromptEvent | undefined): void {
	capturedInstallPrompt = prompt;
	for (const subscriber of installPromptSubscribers) subscriber(prompt);
}

export function initializeAppInstallCapture(): void {
	if (captureInitialized) return;
	captureInitialized = true;
	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		publishInstallPrompt(event as BeforeInstallPromptEvent);
	});
	window.addEventListener("appinstalled", () => publishInstallPrompt(undefined));
}

export interface AppInstallState {
	readonly canInstall: boolean;
	readonly canFullscreen: boolean;
	readonly isFullscreen: boolean;
	readonly isInstalled: boolean;
	readonly isIos: boolean;
	readonly isSecureContext: boolean;
	install: () => Promise<"accepted" | "dismissed" | "unavailable">;
	toggleFullscreen: () => Promise<boolean>;
}

function detectIos(): boolean {
	return /iPad|iPhone|iPod/iu.test(navigator.platform) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function detectStandalone(): boolean {
	const displayModeStandalone = window.matchMedia("(display-mode: standalone)").matches;
	const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
	return displayModeStandalone || iosStandalone;
}

export function useAppInstall(): AppInstallState {
	const [deferredPrompt, setDeferredPrompt] = useState(() => capturedInstallPrompt);
	const [isInstalled, setIsInstalled] = useState(() => detectStandalone());
	const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
	const [isIos] = useState(() => detectIos());
	const [isSecureContext] = useState(() => window.isSecureContext);
	const canFullscreen = typeof document.documentElement.requestFullscreen === "function";

	useEffect(() => {
		const displayMode = window.matchMedia("(display-mode: standalone)");
		const updateStandalone = () => setIsInstalled(detectStandalone());
		const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
		const handleInstalled = () => setIsInstalled(true);
		const handleInstallPrompt: InstallPromptSubscriber = (prompt) => setDeferredPrompt(prompt);

		installPromptSubscribers.add(handleInstallPrompt);
		setDeferredPrompt(capturedInstallPrompt);
		displayMode.addEventListener("change", updateStandalone);
		document.addEventListener("fullscreenchange", updateFullscreen);
		window.addEventListener("appinstalled", handleInstalled);
		return () => {
			installPromptSubscribers.delete(handleInstallPrompt);
			displayMode.removeEventListener("change", updateStandalone);
			document.removeEventListener("fullscreenchange", updateFullscreen);
			window.removeEventListener("appinstalled", handleInstalled);
		};
	}, []);

	const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
		if (!deferredPrompt) return "unavailable";
		await deferredPrompt.prompt();
		const choice = await deferredPrompt.userChoice;
		publishInstallPrompt(undefined);
		return choice.outcome;
	}, [deferredPrompt]);

	const toggleFullscreen = useCallback(async (): Promise<boolean> => {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
				return true;
			}
			if (!document.documentElement.requestFullscreen) return false;
			await document.documentElement.requestFullscreen({ navigationUI: "hide" });
			return true;
		} catch {
			return false;
		}
	}, []);

	return {
		canInstall: Boolean(deferredPrompt),
		canFullscreen,
		isFullscreen,
		isInstalled,
		isIos,
		isSecureContext,
		install,
		toggleFullscreen,
	};
}
