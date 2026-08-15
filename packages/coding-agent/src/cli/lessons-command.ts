import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import {
	approveToolRecoveryLesson,
	disableToolRecoveryLesson,
	getToolRecoveryLesson,
	listToolRecoveryLessons,
	pruneToolRecoveryLessons,
	readToolRecoveryLessonHistory,
	rollbackToolRecoveryLesson,
	type ToolRecoveryLessonStatus,
} from "../core/tool-recovery/lessons-store.ts";

export class LessonsCommandError extends Error {}

type LessonsCommand =
	| { kind: "list"; status?: ToolRecoveryLessonStatus }
	| { kind: "show"; id: string }
	| { kind: "approve" | "disable"; id: string; version?: number }
	| { kind: "rollback"; historyId: string; version?: number }
	| { kind: "prune" };

const STATUSES = new Set<ToolRecoveryLessonStatus>(["candidate", "verified", "active", "suspended", "expired"]);
const USAGE = `${APP_NAME} lessons <list|show|approve|disable|rollback|prune>`;

function parseVersion(value: string | undefined): number {
	if (!value || !/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
		throw new LessonsCommandError("--version 必须是正整数");
	}
	return Number(value);
}

function parseVersionOption(args: string[], start: number): { version?: number } {
	let version: number | undefined;
	for (let index = start; index < args.length; index++) {
		if (args[index] !== "--version") throw new LessonsCommandError(`不支持参数“${args[index]}”`);
		if (version !== undefined) throw new LessonsCommandError("--version 只能指定一次");
		version = parseVersion(args[++index]);
	}
	return version === undefined ? {} : { version };
}

export function isLessonsCommandHelp(args: string[]): boolean {
	return (
		args[0] === "lessons" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printLessonsCommandHelp(): void {
	console.log(`用法：
  ${APP_NAME} lessons list [--status candidate|verified|active|suspended|expired]
  ${APP_NAME} lessons show <id>
  ${APP_NAME} lessons approve <id> [--version <version>]
  ${APP_NAME} lessons disable <id> [--version <version>]
  ${APP_NAME} lessons rollback <history-id> [--version <version>]
  ${APP_NAME} lessons prune

approve 是人工审批入口。safe_refresh 只能通过 approve 进入 active；suspended 可以重新批准。过期经验必须先更新为 candidate 再批准；回滚到 active 会改为 candidate，需再次 approve。--version 可避免覆盖已被其他会话修改的恢复经验。`);
}

export function parseLessonsCommand(args: string[]): LessonsCommand | undefined {
	if (args[0] !== "lessons") return undefined;
	const command = args[1];
	if (command === "list") {
		if (args.length === 2) return { kind: "list" };
		if (args[2] !== "--status" || args.length !== 4) throw new LessonsCommandError("list 只支持 --status <状态>");
		const status = args[3];
		if (!STATUSES.has(status as ToolRecoveryLessonStatus)) throw new LessonsCommandError(`状态“${status}”无效`);
		return { kind: "list", status: status as ToolRecoveryLessonStatus };
	}
	if (command === "show") {
		if (!args[2] || args.length !== 3) throw new LessonsCommandError("show 需要一个恢复经验 ID");
		return { kind: "show", id: args[2] };
	}
	if (command === "approve" || command === "disable") {
		if (!args[2]) throw new LessonsCommandError(`${command} 需要一个恢复经验 ID`);
		return { kind: command, id: args[2], ...parseVersionOption(args, 3) };
	}
	if (command === "rollback") {
		if (!args[2]) throw new LessonsCommandError("rollback 需要一个历史记录 ID");
		return { kind: "rollback", historyId: args[2], ...parseVersionOption(args, 3) };
	}
	if (command === "prune") {
		if (args.length !== 2) throw new LessonsCommandError("prune 不接受额外参数");
		return { kind: "prune" };
	}
	throw new LessonsCommandError(`未知 lessons 命令“${command ?? ""}”`);
}

function printLesson(lesson: Awaited<ReturnType<typeof getToolRecoveryLesson>>): void {
	console.log(`ID：${lesson.id}
状态：${lesson.status}
范围：${lesson.scope}
Tool：${lesson.matcher.toolName}
失败码：${lesson.matcher.failureCode}
允许动作：${lesson.allowedAction}
版本：${lesson.version}
到期时间：${lesson.expiresAt}
证据：出现 ${lesson.evidence.occurrences} 次，会话 ${lesson.evidence.sessions} 个，恢复 ${lesson.evidence.recovered} 次，失败 ${lesson.evidence.failed} 次
建议：${lesson.guidance}`);
}

async function currentVersion(agentDir: string, id: string): Promise<number> {
	return (await getToolRecoveryLesson(agentDir, id)).version;
}

async function rollbackVersion(agentDir: string, historyId: string): Promise<number> {
	const history = await readToolRecoveryLessonHistory(agentDir);
	const target = history.find((entry) => entry.id === historyId);
	const lessonId = target?.before?.id;
	if (!lessonId) throw new LessonsCommandError("这条历史记录没有可恢复的旧快照");
	return await currentVersion(agentDir, lessonId);
}

export async function runLessonsCommand(args: string[], agentDir = getAgentDir()): Promise<boolean> {
	if (isLessonsCommandHelp(args)) {
		printLessonsCommandHelp();
		return true;
	}

	let command: LessonsCommand | undefined;
	try {
		command = parseLessonsCommand(args);
	} catch (error) {
		const message = error instanceof LessonsCommandError ? error.message : "解析 lessons 命令失败";
		console.error(chalk.red(`错误：${message}`));
		console.error(chalk.dim(`用法：${USAGE}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	try {
		switch (command.kind) {
			case "list": {
				const lessons = await listToolRecoveryLessons(agentDir, { status: command.status });
				if (lessons.length === 0) {
					console.log(command.status ? "没有符合状态的恢复经验。" : "没有保存的恢复经验。");
					return true;
				}
				for (const lesson of lessons) {
					console.log(
						`${lesson.id}\t${lesson.status}\t${lesson.scope}\t${lesson.matcher.toolName}/${lesson.matcher.failureCode}\tv${lesson.version}`,
					);
				}
				return true;
			}
			case "show":
				printLesson(await getToolRecoveryLesson(agentDir, command.id));
				return true;
			case "approve": {
				const version = command.version ?? (await currentVersion(agentDir, command.id));
				const lesson = await approveToolRecoveryLesson(agentDir, command.id, version, { source: "cli" });
				console.log(`已批准恢复经验“${lesson.id}”，当前状态为 active。`);
				return true;
			}
			case "disable": {
				const version = command.version ?? (await currentVersion(agentDir, command.id));
				const lesson = await disableToolRecoveryLesson(agentDir, command.id, version, { source: "cli" });
				console.log(`已停用恢复经验“${lesson.id}”。`);
				return true;
			}
			case "rollback": {
				const version = command.version ?? (await rollbackVersion(agentDir, command.historyId));
				const lesson = await rollbackToolRecoveryLesson(agentDir, command.historyId, version, { source: "cli" });
				console.log(
					lesson.status === "candidate"
						? `已回滚恢复经验“${lesson.id}”到历史记录“${command.historyId}”，当前状态为 candidate，需再次批准。`
						: `已回滚恢复经验“${lesson.id}”到历史记录“${command.historyId}”。`,
				);
				return true;
			}
			case "prune": {
				const count = await pruneToolRecoveryLessons(agentDir, { source: "cli" });
				console.log(count === 0 ? "没有可清理的恢复经验。" : `已清理 ${count} 条过期或长期停用的恢复经验。`);
				return true;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "处理 lessons 命令失败";
		console.error(chalk.red(`错误：${message}`));
		process.exitCode = 1;
		return true;
	}
}
