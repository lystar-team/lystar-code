import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
	prompt: () => Promise<void>;
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
	const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent>();
	const [isInstalled, setIsInstalled] = useState(() => detectStandalone());
	const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
	const [isIos] = useState(() => detectIos());
	const [isSecureContext] = useState(() => window.isSecureContext);
	const canFullscreen = typeof document.documentElement.requestFullscreen === "function";

	useEffect(() => {
		const displayMode = window.matchMedia("(display-mode: standalone)");
		const updateStandalone = () => setIsInstalled(detectStandalone());
		const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
		const handleBeforeInstallPrompt = (event: Event) => {
			event.preventDefault();
			setDeferredPrompt(event as BeforeInstallPromptEvent);
		};
		const handleAppInstalled = () => {
			setDeferredPrompt(undefined);
			setIsInstalled(true);
		};

		displayMode.addEventListener("change", updateStandalone);
		document.addEventListener("fullscreenchange", updateFullscreen);
		window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
		window.addEventListener("appinstalled", handleAppInstalled);
		return () => {
			displayMode.removeEventListener("change", updateStandalone);
			document.removeEventListener("fullscreenchange", updateFullscreen);
			window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
			window.removeEventListener("appinstalled", handleAppInstalled);
		};
	}, []);

	const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
		if (!deferredPrompt) return "unavailable";
		await deferredPrompt.prompt();
		const choice = await deferredPrompt.userChoice;
		setDeferredPrompt(undefined);
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
