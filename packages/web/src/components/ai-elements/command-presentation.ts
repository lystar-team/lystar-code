import type { ToolBatchState } from "../../types.ts";

type CommandIcon = "search" | "folder" | "file" | "git" | "script" | "terminal";

export interface CommandPresentation {
	action: string;
	target: string;
	icon: CommandIcon;
}

function commandWords(command: string): string[] | undefined {
	if (/[\r\n`$]/u.test(command)) return undefined;
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let started = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === "\\" && quote !== "'") {
			if (index + 1 >= command.length) return undefined;
			word += command[++index];
			started = true;
		} else if (char === quote) {
			quote = undefined;
		} else if (!quote && (char === "'" || char === '"')) {
			quote = char;
			started = true;
		} else if (!quote && /\s/u.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else if (!quote && /[;&|<>]/u.test(char)) {
			return undefined;
		} else {
			word += char;
			started = true;
		}
	}
	if (quote) return undefined;
	if (started) words.push(word);
	return words;
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

export function commandPresentation(command: string): CommandPresentation {
	const words = commandWords(command);
	const invocation = words ? resolveInvocation(words) : undefined;
	const executable = invocation?.program;
	const args = invocation?.args ?? [];
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const scope = (path: string | undefined) => path && path !== "." ? `（${path}）` : "";
	if ((executable === "tsc" || executable === "tsgo") && args.includes("--noEmit")) {
		const project = option("-p") ?? option("--project");
		return { action: "检查", target: `TypeScript 类型${project && !project.startsWith("-") ? scope(project) : ""}`, icon: "script" };
	}
	if (executable === "find") {
		if (args.some((arg) => ["-o", "-or", "-exec", "-execdir", "-delete", "!", "-not"].includes(arg)))
			return commandFallback(command, words);
		const root = args[0]?.startsWith("-") ? undefined : args[0];
		const name = option("-name") ?? option("-iname") ?? option("-path");
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
		const pattern = files ? option("-g") ?? option("--glob") : option("-e") ?? option("--regexp") ?? operands[0];
		const path = files ? operands[0] : operands[pattern === operands[0] ? 1 : 0];
		return { action: files ? "查找" : "搜索", target: files ? `${pattern ? `${pattern} 文件` : "文件"}${scope(path)}` : pattern ? `${pattern}${scope(path)}` : "内容", icon: "search" };
	}
	if (executable === "ls") {
		const path = args.find((arg) => !arg.startsWith("-"));
		return { action: "查看", target: path ? `${path} 目录` : "当前目录", icon: "folder" };
	}
	if (executable === "pwd") return { action: "查看", target: "当前目录", icon: "folder" };
	if (["cat", "head", "tail", "sed"].includes(executable ?? "")) {
		if (executable === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i") && arg.length > 2 || arg === "--in-place"))
			return commandFallback(command, words);
		const path = args.at(-1);
		const hasFile = Boolean(
			path && !path.startsWith("-") &&
			(executable === "sed" ? args.length >= (args[0] === "-n" ? 3 : 2) :
				!(args.length === 2 && ["-n", "-c"].includes(args[0] ?? ""))),
		);
		return { action: "读取", target: hasFile ? `${path} 文件` : "文件", icon: "file" };
	}
	if (executable === "git") {
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
	if (["npx", "bunx"].includes(executable ?? "") && args[0] && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,47}$/u.test(args[0])) {
		if (args[0] === "vitest") return { action: "运行", target: "Vitest 测试", icon: "script" };
		return { action: "运行", target: `${args[0]} 工具`, icon: "script" };
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

export function commandRowLabel(command: string, state: ToolBatchState): string {
	const { action, target } = commandPresentation(command);
	const activity = `${action}${/^[\p{Script=Han}]/u.test(target) ? "" : " "}${target}`;
	if (state === "input-available") return `正在${activity}`;
	if (state === "input-queued") return `准备${activity}`;
	if (state === "output-error") return `${activity}失败`;
	if (state === "output-cancelled") return `${activity}已取消`;
	if (state === "output-interrupted") return `${activity}已中断`;
	return `已${activity}`;
}
