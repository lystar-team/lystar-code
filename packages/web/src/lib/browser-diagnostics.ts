const DIAGNOSTIC_STORAGE_KEY = "lystar.web.browser-diagnostics.v1";
const MAX_DIAGNOSTIC_ENTRIES = 50;

export interface BrowserDiagnosticEntry {
	id: string;
	timestamp: string;
	scope: string;
	message: string;
	stack?: string;
	componentStack?: string;
	location?: string;
	visibility?: DocumentVisibilityState;
	memory?: {
		usedBytes: number;
		totalBytes: number;
		limitBytes: number;
	};
}

type PerformanceWithMemory = Performance & {
	memory?: {
		usedJSHeapSize: number;
		totalJSHeapSize: number;
		jsHeapSizeLimit: number;
	};
};

let installed = false;
let memoryEntries: BrowserDiagnosticEntry[] = [];

function normalizedError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

function storedEntries(): BrowserDiagnosticEntry[] {
	if (typeof window === "undefined") return memoryEntries;
	try {
		const parsed: unknown = JSON.parse(window.sessionStorage.getItem(DIAGNOSTIC_STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? (parsed as BrowserDiagnosticEntry[]) : memoryEntries;
	} catch {
		return memoryEntries;
	}
}

function persistEntries(entries: BrowserDiagnosticEntry[]): void {
	memoryEntries = entries;
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(entries));
	} catch {
		// 内存中的诊断记录仍可下载。
	}
}

export function recordBrowserDiagnostic(scope: string, value: unknown, componentStack?: string): string {
	const error = normalizedError(value);
	const memory = typeof performance === "undefined" ? undefined : (performance as PerformanceWithMemory).memory;
	const entry: BrowserDiagnosticEntry = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		scope,
		message: error.message || error.name,
		...(error.stack ? { stack: error.stack } : {}),
		...(componentStack ? { componentStack } : {}),
		...(typeof window === "undefined"
			? {}
			: {
					location: `${window.location.pathname}${window.location.search}${window.location.hash}`,
					visibility: document.visibilityState,
				}),
		...(memory
			? {
					memory: {
						usedBytes: memory.usedJSHeapSize,
						totalBytes: memory.totalJSHeapSize,
						limitBytes: memory.jsHeapSizeLimit,
					},
				}
			: {}),
	};
	persistEntries([...storedEntries(), entry].slice(-MAX_DIAGNOSTIC_ENTRIES));
	return entry.id;
}

export function downloadBrowserDiagnostics(): void {
	if (typeof window === "undefined") return;
	const payload = {
		generatedAt: new Date().toISOString(),
		userAgent: navigator.userAgent,
		entries: storedEntries(),
	};
	const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = `lystar-web-diagnostics-${payload.generatedAt.replaceAll(":", "-")}.json`;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export function installBrowserDiagnostics(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	window.addEventListener("error", (event) => {
		recordBrowserDiagnostic("window.error", event.error ?? new Error(event.message));
	});
	window.addEventListener("unhandledrejection", (event) => {
		recordBrowserDiagnostic("window.unhandledrejection", event.reason);
	});
}
