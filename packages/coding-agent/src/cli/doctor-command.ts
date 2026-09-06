import {
	APP_NAME,
	APP_TITLE,
	getToolRecoveryMode,
	type ToolRecoveryMode,
	ToolRecoveryModeError,
	VERSION,
} from "../config.ts";
import { getToolRecoveryDoctorReport, type ToolRecoveryDoctorReport } from "../core/tool-recovery/diagnostics.ts";
import { t } from "../locales/zh-CN.ts";

const RUNTIME_PROTOCOL_VERSION = 1;

export class DoctorCommandError extends Error {}

type DoctorCommand = { json: boolean };

export function isDoctorCommandHelp(args: string[]): boolean {
	return args[0] === "doctor" && (args[1] === "help" || args.includes("--help") || args.includes("-h"));
}

export function printDoctorCommandHelp(): void {
	console.log(`${APP_NAME} doctor [--json]\n\n${t("doctor.help")}`);
}

export function parseDoctorCommand(args: string[]): DoctorCommand | undefined {
	if (args[0] !== "doctor") return undefined;
	let json = false;
	for (const arg of args.slice(1)) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "help" || arg === "--help" || arg === "-h") continue;
		throw new DoctorCommandError(t("doctor.unsupportedOption", { option: arg }));
	}
	return { json };
}

function formatUnavailable(reason: string): string {
	return reason === "no_persistent_fact_source" ? t("doctor.noPersistentFactSource") : reason;
}

function formatText(report: ToolRecoveryDoctorReport): string {
	const metrics = report.recovery.metrics;
	return [
		t("doctor.title"),
		`${t("doctor.product")}: ${report.product.name} ${report.product.version}`,
		`${t("doctor.frontend")}: ${report.frontend.implementation} (${report.frontend.modes.join(", ")})`,
		`${t("doctor.node")}: ${report.nodeVersion}`,
		`${t("doctor.runtimeProtocol")}: ${report.runtimeProtocolVersion}`,
		`${t("doctor.cwd")}: ${report.cwd}`,
		`${t("doctor.agentDir")}: ${report.agentDir}`,
		`${t("doctor.platform")}: ${report.platform}/${report.arch}`,
		`${t("doctor.recovery")}: ${report.recovery.mode}`,
		`${t("doctor.sessionActive")}: ${report.recovery.sessionActive}`,
		`${t("doctor.activeCircuits")}: ${report.recovery.activeCircuits}`,
		`${t("doctor.metrics")}: ${JSON.stringify(metrics)}`,
		`${t("doctor.lessons")}: ${JSON.stringify(report.lessons.counts)}`,
		`${t("doctor.recentConnectionErrors")}: ${t("doctor.unavailable", {
			reason: formatUnavailable(report.recentConnectionErrors.reason),
		})}`,
		`${t("doctor.terminalRepairHistory")}: ${t("doctor.unavailable", {
			reason: formatUnavailable(report.terminalRepairHistory.reason),
		})}`,
		...(report.lessons.available ? [] : [t("doctor.lessonStoreError", { code: report.lessons.error.code })]),
	].join("\n");
}

export async function runDoctorCommand(args: string[], options: { cwd: string; agentDir: string }): Promise<boolean> {
	let command: DoctorCommand | undefined;
	try {
		command = parseDoctorCommand(args);
	} catch (error) {
		const message = error instanceof DoctorCommandError ? error.message : t("doctor.parseFailed");
		console.error(t("common.error", { message }));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	let recoveryMode: ToolRecoveryMode;
	try {
		recoveryMode = getToolRecoveryMode();
	} catch (error) {
		if (error instanceof ToolRecoveryModeError && command.json) {
			console.log(JSON.stringify({ error: { code: error.code, value: error.value } }));
		} else {
			console.error(
				t("common.error", { message: error instanceof Error ? error.message : t("doctor.parseFailed") }),
			);
		}
		process.exitCode = 1;
		return true;
	}
	if (isDoctorCommandHelp(args)) {
		printDoctorCommandHelp();
		return true;
	}

	const report = await getToolRecoveryDoctorReport({
		productName: APP_TITLE,
		productVersion: VERSION,
		runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
		cwd: options.cwd,
		agentDir: options.agentDir,
		recoveryMode,
	});
	console.log(command.json ? JSON.stringify(report) : formatText(report));
	if (!report.lessons.available) process.exitCode = 2;
	return true;
}
