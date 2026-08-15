import type { ToolRecoveryMode } from "../../config.ts";
import {
	getToolRecoveryLessonDiagnostics,
	type ToolRecoveryLessonCounts,
	type ToolRecoveryLessonStoreDiagnostic,
} from "./lessons-store.ts";

export interface ToolRecoveryRuntimeMetrics {
	toolFailureTotal: Array<{ tool: string; code: string; count: number }>;
	toolRecoveryAttemptTotal: Array<{ tool: string; action: string; count: number }>;
	toolRecoverySuccessTotal: Array<{ tool: string; action: string; count: number }>;
	toolRepeatBlockedTotal: Array<{ tool: string; code: string; count: number }>;
	toolUnsafeRetryBlockedTotal: Array<{ tool: string; count: number }>;
	lessonMatchTotal: Array<{ lesson: string; count: number }>;
	lessonRecoverySuccessTotal: Array<{ lesson: string; count: number }>;
	lessonSuspendedTotal: Array<{ lesson: string; count: number }>;
	duration: { count: number; totalMs: number; maxMs: number };
}

export interface ToolRecoveryRuntimeDiagnostics extends ToolRecoveryRuntimeMetrics {
	mode: ToolRecoveryMode;
	activeCircuits: number;
}

export interface ToolRecoveryDiagnosticSummary {
	sessionActive: boolean;
	mode: ToolRecoveryMode;
	activeCircuits: number;
	metrics: Partial<ToolRecoveryRuntimeMetrics>;
}

export interface ToolRecoveryDoctorReport {
	product: { name: string; version: string };
	frontend: {
		implementation: "typescript";
		modes: ["regular", "fullscreen"];
		rust: { b0Status: "stop"; integration: "not_integrated" };
	};
	nodeVersion: string;
	guiProtocolVersion: number;
	cwd: string;
	agentDir: string;
	platform: string;
	arch: string;
	recovery: ToolRecoveryDiagnosticSummary;
	lessons: ToolRecoveryLessonStoreDiagnostic;
	recentConnectionErrors: { available: false; reason: "no_persistent_fact_source" };
	terminalRepairHistory: { available: false; reason: "no_persistent_fact_source" };
}

export function summarizeToolRecoveryDiagnostics(
	diagnostics: ToolRecoveryRuntimeDiagnostics | undefined,
	mode: ToolRecoveryMode,
): ToolRecoveryDiagnosticSummary {
	if (!diagnostics) return { sessionActive: false, mode, activeCircuits: 0, metrics: {} };
	const { activeCircuits, ...metrics } = diagnostics;
	return { sessionActive: true, mode: diagnostics.mode, activeCircuits, metrics };
}

export async function getToolRecoveryDoctorReport(options: {
	productName: string;
	productVersion: string;
	guiProtocolVersion: number;
	cwd: string;
	agentDir: string;
	runtimeDiagnostics?: ToolRecoveryRuntimeDiagnostics;
	recoveryMode: ToolRecoveryMode;
}): Promise<ToolRecoveryDoctorReport> {
	return {
		product: { name: options.productName, version: options.productVersion },
		frontend: {
			implementation: "typescript",
			modes: ["regular", "fullscreen"],
			rust: { b0Status: "stop", integration: "not_integrated" },
		},
		nodeVersion: process.version,
		guiProtocolVersion: options.guiProtocolVersion,
		cwd: options.cwd,
		agentDir: options.agentDir,
		platform: process.platform,
		arch: process.arch,
		recovery: summarizeToolRecoveryDiagnostics(options.runtimeDiagnostics, options.recoveryMode),
		lessons: await getToolRecoveryLessonDiagnostics(options.agentDir),
		recentConnectionErrors: { available: false, reason: "no_persistent_fact_source" },
		terminalRepairHistory: { available: false, reason: "no_persistent_fact_source" },
	};
}

export type { ToolRecoveryLessonCounts };
