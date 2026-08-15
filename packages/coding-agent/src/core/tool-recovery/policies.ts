import type { ToolRecoveryController, ToolRecoveryObservation } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { appendSessionRecoveryLedger, createRecoveryLedgerEntry } from "./ledger.ts";
import { adaptToolRecoveryObservation } from "./registry.ts";

export interface ToolRecoveryDiagnostics {
	mode: "observe";
	toolFailureTotal: Array<{ tool: string; code: string; count: number }>;
	toolRecoveryAttemptTotal: Array<{ tool: string; action: "observe"; count: number }>;
	duration: { count: number; totalMs: number; maxMs: number };
	activeCircuits: 0;
}

class ToolRecoveryMetrics {
	private readonly failures = new Map<string, number>();
	private readonly attempts = new Map<string, number>();
	private durationCount = 0;
	private durationTotalMs = 0;
	private durationMaxMs = 0;

	record(observation: ToolRecoveryObservation): void {
		const attemptKey = `${observation.toolName}\u0000observe`;
		this.attempts.set(attemptKey, (this.attempts.get(attemptKey) ?? 0) + 1);
		this.durationCount++;
		this.durationTotalMs += observation.durationMs;
		this.durationMaxMs = Math.max(this.durationMaxMs, observation.durationMs);
		if (!observation.failure) return;
		const failureKey = `${observation.toolName}\u0000${observation.failure.code}`;
		this.failures.set(failureKey, (this.failures.get(failureKey) ?? 0) + 1);
	}

	snapshot(): ToolRecoveryDiagnostics {
		const unpack = (entries: Map<string, number>) =>
			Array.from(entries, ([key, count]) => {
				const [tool, code] = key.split("\u0000");
				return { tool: tool!, code: code!, count };
			}).sort((left, right) => left.tool.localeCompare(right.tool) || left.code.localeCompare(right.code));
		return {
			mode: "observe",
			toolFailureTotal: unpack(this.failures),
			toolRecoveryAttemptTotal: unpack(this.attempts).map(({ tool, count }) => ({ tool, action: "observe", count })),
			duration: { count: this.durationCount, totalMs: this.durationTotalMs, maxMs: this.durationMaxMs },
			activeCircuits: 0,
		};
	}
}

export class ObserveOnlyToolRecoveryController implements ToolRecoveryController {
	private readonly options: {
		agentDir: string;
		sessionManager: SessionManager;
		getTurnId: () => string;
	};
	private readonly metrics = new ToolRecoveryMetrics();
	private readonly observations = new Map<string, number>();
	private readonly circuits = new Map<string, number>();

	constructor(options: { agentDir: string; sessionManager: SessionManager; getTurnId: () => string }) {
		this.options = options;
	}

	preflight(): void {}

	async observe(observation: ToolRecoveryObservation, signal?: AbortSignal, error?: unknown): Promise<void> {
		await adaptToolRecoveryObservation(observation, error, signal);
		this.metrics.record(observation);
		const failure = observation.failure;
		const sessionFile = this.options.sessionManager.getSessionFile();
		if (!failure || !sessionFile) return;

		const key = `${observation.toolCallId}\u0000${failure.fingerprint}`;
		const attempt = (this.observations.get(key) ?? 0) + 1;
		this.observations.set(key, attempt);
		this.circuits.set(`${observation.callSignature}\u0000${failure.fingerprint}`, attempt);
		await appendSessionRecoveryLedger(
			this.options.agentDir,
			sessionFile,
			createRecoveryLedgerEntry({
				sessionId: this.options.sessionManager.getSessionId(),
				turnId: this.options.getTurnId(),
				toolCallId: observation.toolCallId,
				toolName: observation.toolName,
				callSignature: observation.callSignature,
				failureFingerprint: failure.fingerprint,
				failureCode: failure.code,
				attempt,
				action: "observe",
				outcome: failure.code === "CANCELLED" ? "cancelled" : "failed",
				durationMs: observation.durationMs,
				createdAt: failure.occurredAt,
			}),
		);
	}

	getDiagnostics(): ToolRecoveryDiagnostics {
		return this.metrics.snapshot();
	}
}
