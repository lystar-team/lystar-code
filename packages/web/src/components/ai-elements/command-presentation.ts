import parseShell from "shell-quote/parse";
import type { ToolBatchState } from "../../types.ts";

type CommandIcon = "search" | "folder" | "file" | "git" | "script" | "terminal";

export interface CommandPresentation {
	action: string;
	target: string;
	icon: CommandIcon;
	composite?: boolean;
	resultUncertain?: boolean;
}

type ShellSegment = { words: string[]; piped: boolean; sequenced: boolean; redirected: boolean };

function balancedQuotes(command: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === "\\" && quote !== "'") {
			if (index + 1 >= command.length) return false;
			index++;
		} else if (char === quote) {
			quote = undefined;
		} else if (!quote && (char === "'" || char === '"')) {
			quote = char;
		}
	}
	return !quote;
}

function shellSegments(command: string): ShellSegment[] | undefined {
	// shell-quote handles words and operators, but not command substitution or multiline shell programs.
	if (/[\r\n`]/u.test(command) || command.includes("$(") || !balancedQuotes(command)) return undefined;
	const segments: ShellSegment[] = [];
	let current: ShellSegment = { words: [], piped: false, sequenced: false, redirected: false };
	let redirectTarget = false;
	let pendingSeparator = false;
	try {
		for (const token of parseShell(command, (name) => `$${name}`)) {
			if (typeof token !== "string" && "comment" in token) break;
			if (redirectTarget) {
				if (typeof token !== "string" && token.op !== "glob") return undefined;
				redirectTarget = false;
				continue;
			}
			if (typeof token === "string" || token.op === "glob") {
				current.words.push(typeof token === "string" ? token : token.pattern);
				pendingSeparator = false;
				continue;
			}
			if ([">", ">>", "<", ">&", "<&", "<<<"].includes(token.op)) {
				current.redirected = true;
				redirectTarget = true;
				continue;
			}
			if (!["&&", ";", "|", "|&"].includes(token.op) || current.words.length === 0) return undefined;
			segments.push(current);
			current = { words: [], piped: token.op === "|" || token.op === "|&", sequenced: token.op === ";", redirected: false };
			pendingSeparator = true;
		}
	} catch {
		return undefined;
	}
	if (pendingSeparator || redirectTarget) return undefined;
	if (current.words.length) segments.push(current);
	return segments;
}

function programName(value: string | undefined): string | undefined {
	const name = value?.split("/").at(-1);
	return name && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,47}$/u.test(name) ? name : undefined;
}

const packageManagers = ["npm", "pnpm", "yarn", "bun"];
const managerValueOptions = ["--workspace", "-w", "--prefix", "--filter", "--dir", "--cwd", "-C"];
const managerSwitchOptions = ["--silent", "--offline"];
const runnerValueOptions = [...managerValueOptions, "--package", "-p", "--call", "-c"];
const runnerSwitchOptions = [...managerSwitchOptions, "--yes", "-y"];

function operands(args: string[], valueOptions: readonly string[], switchOptions: readonly string[]): string[] | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") return args.slice(index + 1);
		if (!arg.startsWith("-")) break;
		const separator = arg.indexOf("=");
		const option = separator === -1 ? arg : arg.slice(0, separator);
		if (valueOptions.includes(option)) {
			if (separator !== -1) {
				if (separator === arg.length - 1) return undefined;
				index++;
			} else {
				if (!args[index + 1] || args[index + 1].startsWith("-")) return undefined;
				index += 2;
			}
		} else if (switchOptions.includes(arg)) {
			index++;
		} else {
			return undefined;
		}
	}
	return args.slice(index);
}

type Invocation = { program: string; args: string[]; script?: string; wrapped?: boolean };

function resolveInvocation(words: string[]): Invocation | undefined {
	const initial = programName(words[0]);
	if (!initial) return undefined;
	let program = initial;
	let args = words.slice(1);
	let wrapped = false;
	for (let depth = 0; depth < 4; depth++) {
		if (program === "npx" || program === "bunx") {
			const target = operands(args, runnerValueOptions, runnerSwitchOptions);
			const next = programName(target?.[0]);
			if (!next) return undefined;
			program = next;
			args = target?.slice(1) ?? [];
			wrapped = true;
			continue;
		}
		if (!packageManagers.includes(program)) return { program, args, wrapped };
		const managerArgs = operands(args, managerValueOptions, managerSwitchOptions);
		if (!managerArgs) return undefined;
		if (["exec", "x", "dlx"].includes(managerArgs[0] ?? "")) {
			const target = operands(managerArgs.slice(1), runnerValueOptions, runnerSwitchOptions);
			const next = programName(target?.[0]);
			if (!next) return undefined;
			program = next;
			args = target?.slice(1) ?? [];
			wrapped = true;
			continue;
		}
		if (managerArgs[0] === "run") {
			const target = operands(managerArgs.slice(1), managerValueOptions, managerSwitchOptions);
			const script = target?.[0];
			if (!script || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/u.test(script)) return undefined;
			return { program, args: target?.slice(1) ?? [], script };
		}
		return { program, args: managerArgs };
	}
	return undefined;
}

function commandFallback(command: string, words?: string[]): CommandPresentation {
	const first = words?.[0] ?? command.trimStart().match(/^[^\s;&|<>`$'"\\]+/u)?.[0];
	const name = programName(first);
	if (!name) return { action: "执行", target: "命令", icon: "terminal" };
	if (/\.(?:sh|mjs|cjs|js|ts|tsx|py)$/u.test(name))
		return { action: "运行", target: `${name} 脚本`, icon: "script" };
	return { action: "运行", target: `${name} 命令`, icon: "terminal" };
}

function literal(value: string | undefined): string | undefined {
	return value && !value.includes("$") ? value : undefined;
}

function simpleCommandPresentation(words: string[]): CommandPresentation {
	const invocation = resolveInvocation(words);
	const executable = invocation?.program;
	const args = invocation?.args ?? [];
	const command = words.join(" ");
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const scope = (path: string | undefined) => path && path !== "." ? `（${path}）` : "";
	if ((executable === "tsc" || executable === "tsgo") && args.includes("--noEmit")) {
		const project = literal(option("-p") ?? option("--project"));
		return { action: "检查", target: `TypeScript 类型${project && !project.startsWith("-") ? scope(project) : ""}`, icon: "script" };
	}
	if (executable === "find") {
		if (args.some((arg) => ["-o", "-or", "-exec", "-execdir", "-delete", "!", "-not"].includes(arg)))
			return commandFallback(command, words);
		const root = args[0]?.startsWith("-") ? undefined : literal(args[0]);
		const name = literal(option("-name") ?? option("-iname") ?? option("-path"));
		const directory = option("-type") === "d";
		return { action: "查找", target: `${name ? `${name} ${directory ? "目录" : "文件"}` : directory ? "目录" : "文件"}${scope(root)}`, icon: "search" };
	}
	if (executable === "rg" || executable === "grep") {
		const files = executable === "rg" && args.includes("--files");
		const valueOptions = ["-g", "--glob", "-e", "--regexp", "--include", "--exclude", "-m", "--max-count", "-A", "-B", "-C", "--type", "-t"];
		const switches = ["-n", "-i", "-F", "-l", "-L", "-r", "-R", "--files", "--hidden", "--line-number", "--ignore-case", "--fixed-strings", "--no-heading"];
		if (args.some((arg) => arg.startsWith("-") && !valueOptions.includes(arg) && !switches.includes(arg)))
			return commandFallback(command, words);
		const operands = args.filter((arg, index) =>
			!arg.startsWith("-") && !valueOptions.includes(args[index - 1]) && !valueOptions.includes(arg),
		);
		const rawPattern = files ? option("-g") ?? option("--glob") : option("-e") ?? option("--regexp") ?? operands[0];
		const pattern = literal(rawPattern);
		const path = literal(files ? operands[0] : operands[rawPattern === operands[0] ? 1 : 0]);
		return { action: files ? "查找" : "搜索", target: files ? `${pattern ? `${pattern} 文件` : "文件"}${scope(path)}` : pattern ? `${pattern}${scope(path)}` : "内容", icon: "search" };
	}
	if (executable === "ls") {
		const path = literal(args.find((arg) => !arg.startsWith("-")));
		return { action: "查看", target: path ? `${path} 目录` : "当前目录", icon: "folder" };
	}
	if (executable === "pwd") return { action: "查看", target: "当前目录", icon: "folder" };
	if (["cat", "head", "tail", "sed"].includes(executable ?? "")) {
		if (executable === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i") && arg.length > 2 || arg === "--in-place"))
			return commandFallback(command, words);
		const path = literal(args.at(-1));
		const hasFile = Boolean(
			path && !path.startsWith("-") &&
			(executable === "sed" ? args.length >= (args[0] === "-n" ? 3 : 2) :
				!(args.length === 2 && ["-n", "-c"].includes(args[0] ?? ""))),
		);
		return { action: "读取", target: hasFile ? `${path} 文件` : "文件", icon: "file" };
	}
	if (executable === "git") {
		if (args[0] === "tag") {
			const options = args.slice(1);
			if (options.some((arg) => arg === "-d" || arg === "--delete")) return { action: "删除", target: "Git 标签", icon: "git" };
			if (options.some((arg) => arg === "-l" || arg === "--list")) return { action: "查看", target: "Git 标签", icon: "git" };
			if (options.some((arg) => arg === "-v" || arg === "--verify")) return { action: "验证", target: "Git 标签", icon: "git" };
			if (options.some((arg) => arg === "-f" || arg === "--force")) return { action: "创建或更新", target: "Git 标签", icon: "git" };
			if (options.some((arg) => ["-a", "--annotate", "-s", "--sign", "-m", "--message", "-F", "--file"].includes(arg)) || options[0] && !options[0].startsWith("-"))
				return { action: "创建", target: "Git 标签", icon: "git" };
			return { action: "查看", target: "Git 标签", icon: "git" };
		}
		if (args[0] === "push") {
			const options = args.slice(1);
			const deleting = options.some((arg) => arg === "-d" || arg === "--delete" || /^:[^:]/u.test(arg));
			if (options.some((arg) => arg === "-n" || arg === "--dry-run"))
				return { action: "检查", target: deleting ? "远端引用删除" : "Git 推送", icon: "git" };
			if (deleting) return { action: "删除", target: "远端引用", icon: "git" };
			if (options.some((arg) => arg === "--mirror" || arg === "--prune"))
				return { action: "同步", target: "远端引用", icon: "git" };
			if (options.some((arg) => arg === "-f" || arg === "--force"))
				return { action: "强制更新", target: "远端引用", icon: "git" };
			return { action: "推送", target: "到远端仓库", icon: "git" };
		}
		if (args[0] === "ls-remote") {
			const tags = args.some((arg) => arg.startsWith("refs/tags/"));
			return { action: "查询", target: tags ? "远端标签" : "远端引用", icon: "git" };
		}
		if (args[0] === "status") return { action: "查看", target: "代码变更", icon: "git" };
		if (args[0] === "diff") return { action: args.includes("--check") ? "检查" : "查看", target: "代码差异", icon: "git" };
		if (args[0] === "log") return { action: "查看", target: "提交记录", icon: "git" };
		if (args[0] === "show") return { action: "查看", target: "提交内容", icon: "git" };
		if (args[0] && /^[a-z][a-z-]*$/u.test(args[0]))
			return { action: "运行", target: `git ${args[0]} 命令`, icon: "git" };
	}
	if (executable === "vitest" || executable === "node" && /(?:^|\/)vitest\/dist\/cli\.js$/u.test(args[0] ?? ""))
		return { action: "运行", target: "Vitest 测试", icon: "script" };
	if (executable === "node" && args[0] === "--test")
		return { action: "运行", target: "Node 测试", icon: "script" };
	if (["node", "python", "python3", "bash", "sh"].includes(executable ?? "")) {
		const script = args[0];
		const filename = script?.split("/").at(-1);
		if (script && !script.startsWith("-") && filename && /\.(?:sh|mjs|cjs|js|ts|tsx|py)$/u.test(filename))
			return { action: "运行", target: `${filename} 脚本`, icon: "script" };
	}
	if (packageManagers.includes(executable ?? "") || invocation?.script) {
		const script = invocation?.script ?? args[0];
		if (["check", "lint", "typecheck"].includes(script ?? "")) return { action: "检查", target: "项目代码", icon: "script" };
		if (script === "test") return { action: "运行", target: "项目测试", icon: "script" };
		if (script === "build") return { action: "构建", target: "项目", icon: "script" };
		if (script === "install" || script === "ci") return { action: "安装", target: "项目依赖", icon: "script" };
		if (invocation?.script) return { action: "运行", target: `${script} 脚本`, icon: "script" };
		return commandFallback(command, words);
	}
	if (invocation?.wrapped) return { action: "运行", target: `${executable} 工具`, icon: "script" };
	return commandFallback(command, words);
}

function segmentWords(words: string[]): string[] {
	let index = words[0] === "env" ? 1 : 0;
	while (/^[a-zA-Z_][a-zA-Z_0-9]*=/u.test(words[index] ?? "")) index++;
	return words.slice(index);
}

export function commandPresentation(command: string): CommandPresentation {
	const segments = shellSegments(command);
	if (!segments) return /[;&|\r\n]|\$\(/u.test(command)
		? { action: "执行", target: "组合命令", icon: "terminal" }
		: commandFallback(command);
	const commands = segments.map((segment) => ({ ...segment, words: segmentWords(segment.words) }))
		.filter((segment) => segment.words.length > 0 && segment.words[0] !== "export");
	if (!commands.length) return commandFallback(command);
	const substantive = commands.filter((segment, index) => {
		const program = programName(segment.words[0]);
		if (program === "cd") return false;
		if ((program === "echo" || program === "printf") && !segment.redirected) return false;
		if (["head", "tail", "tee"].includes(program ?? "") && segment.piped) return false;
		if (program === "cat" && commands[index + 1]?.piped) return false;
		return true;
	});
	if (!substantive.length) {
		const last = commands.at(-1);
		if (last?.words[0] === "cd") return { action: "切换", target: `工作目录${literal(last.words[1]) ? `（${last.words[1]}）` : ""}`, icon: "folder" };
		return simpleCommandPresentation(last?.words ?? []);
	}
	const actions = substantive.map((segment) => simpleCommandPresentation(segment.words));
	const readOnly = actions.every(({ action }) => ["查找", "搜索", "查看", "读取", "查询"].includes(action));
	const resultUncertain = !readOnly && segments.some((segment) => segment.piped || segment.sequenced);
	if (actions.length === 1) return segments.length > 1 ? { ...actions[0], composite: true, resultUncertain } : actions[0];
	const [first, second, third] = actions;
	const describe = ({ action, target }: CommandPresentation) => `${action}${/^[\p{Script=Han}]/u.test(target) ? "" : " "}${target}`;
	const target = actions.length === 2
		? `${first.target}并${describe(second)}`
		: actions.length === 3
			? `${first.target}、${describe(second)}并${describe(third)}`
			: `${first.target}、${describe(second)}等 ${actions.length} 项操作`;
	return { action: first.action, target, icon: actions.every((item) => item.icon === first.icon) ? first.icon : "terminal", composite: true, resultUncertain };
}

export function commandRowLabel(command: string, state: ToolBatchState): string {
	const { action, target, composite, resultUncertain } = commandPresentation(command);
	const activity = `${action}${/^[\p{Script=Han}]/u.test(target) ? "" : " "}${target}`;
	if (state === "input-available") return `正在${activity}`;
	if (state === "input-queued") return `准备${activity}`;
	if (state === "output-error") return composite ? `${activity}未完成` : `${activity}失败`;
	if (state === "output-cancelled") return `${activity}已取消`;
	if (state === "output-interrupted") return `${activity}已中断`;
	return resultUncertain ? `已执行${activity}` : `已${activity}`;
}
