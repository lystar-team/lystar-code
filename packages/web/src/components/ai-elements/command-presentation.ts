import type { ToolBatchState } from "../../types.ts";

type CommandIcon = "search" | "folder" | "file" | "git" | "script" | "terminal";

export interface CommandPresentation {
	action: string;
	target: string;
	icon: CommandIcon;
	composite?: boolean;
	resultUncertain?: boolean;
}

type ShellOperator = "&&" | "||" | ";" | "\n" | "|" | "|&" | "&";

interface ShellSegment {
	words: string[];
	/** 会写文件的输出重定向目标（/dev/null 与文件描述符复制除外）。 */
	writes: string[];
	/** 该段接收上一段管道输出。 */
	piped: boolean;
	/** 该段以 ; 换行或 & 开始。 */
	sequenced: boolean;
	/** 该段以 || 开始。 */
	branched: boolean;
	/** 该段以 && 开始。 */
	chained: boolean;
	/** 该段从 heredoc 读取正文。 */
	heredoc: boolean;
}

type ShellToken =
	| { kind: "word"; value: string }
	| { kind: "operator"; value: ShellOperator }
	| { kind: "redirect"; op: string; write: boolean };

interface ScanResult {
	segments: ShellSegment[];
	incomplete: boolean;
}

function skipHeredocBody(command: string, start: number, delimiter: string, stripTabs: boolean): number {
	const end = command.length;
	let index = start;
	while (index <= end) {
		const lineEnd = command.indexOf("\n", index);
		const rawLine = lineEnd === -1 ? command.slice(index) : command.slice(index, lineEnd);
		const line = (stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine).replace(/\r$/u, "");
		if (line === delimiter) return lineEnd === -1 ? end : lineEnd + 1;
		if (lineEnd === -1) return end;
		index = lineEnd + 1;
	}
	return end;
}

// 只按 shell 的引用与转义规则切分单词，不执行也不展开任何内容。
// 引号内、转义后、$() 与反引号内以及 heredoc 正文里的分隔符都不参与顶层切分。
function tokenizeShell(command: string): { tokens: ShellToken[]; incomplete: boolean } {
	const tokens: ShellToken[] = [];
	const length = command.length;
	const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let index = 0;
	let incomplete = false;
	let word = "";
	let hasWord = false;

	const flushWord = () => {
		if (!hasWord) return;
		tokens.push({ kind: "word", value: word });
		word = "";
		hasWord = false;
	};

	const scanCommandSubstitution = (start: number): number => {
		let depth = 0;
		let quote: "'" | '"' | undefined;
		for (let cursor = start + 1; cursor < length; cursor++) {
			const char = command[cursor];
			if (quote === "'") {
				if (char === "'") quote = undefined;
				continue;
			}
			if (char === "\\") {
				cursor++;
				continue;
			}
			if (quote === '"') {
				if (char === '"') quote = undefined;
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (char === "(") depth++;
			else if (char === ")") {
				depth--;
				if (depth === 0) return cursor + 1;
			}
		}
		incomplete = true;
		return length;
	};

	const scanBacktick = (start: number): number => {
		for (let cursor = start + 1; cursor < length; cursor++) {
			if (command[cursor] === "\\") {
				cursor++;
				continue;
			}
			if (command[cursor] === "`") return cursor + 1;
		}
		incomplete = true;
		return length;
	};

	const readHeredocDelimiter = (): string | undefined => {
		while (index < length && (command[index] === " " || command[index] === "\t")) index++;
		let value = "";
		let any = false;
		while (index < length && !" \t\r\n;&|<>".includes(command[index] ?? "")) {
			const char = command[index];
			if (char === "'" || char === '"') {
				const end = command.indexOf(char, index + 1);
				if (end === -1) {
					value += command.slice(index + 1);
					index = length;
					incomplete = true;
					break;
				}
				value += command.slice(index + 1, end);
				index = end + 1;
			} else if (char === "\\") {
				value += command[index + 1] ?? "";
				index += 2;
			} else {
				value += char;
				index++;
			}
			any = true;
		}
		return any ? value : undefined;
	};

	while (index < length) {
		const char = command[index];
		if (char === "\\") {
			if (index + 1 >= length) {
				hasWord = true;
				incomplete = true;
				break;
			}
			if (command[index + 1] === "\n") {
				index += 2;
				continue;
			}
			word += command[index + 1];
			hasWord = true;
			index += 2;
			continue;
		}
		if (char === "'") {
			const end = command.indexOf("'", index + 1);
			if (end === -1) {
				word += command.slice(index + 1);
				hasWord = true;
				index = length;
				incomplete = true;
				break;
			}
			word += command.slice(index + 1, end);
			hasWord = true;
			index = end + 1;
			continue;
		}
		if (char === '"') {
			hasWord = true;
			index++;
			let closed = false;
			while (index < length) {
				const inner = command[index];
				if (inner === "\\") {
					if (index + 1 >= length) {
						index++;
						incomplete = true;
						break;
					}
					if (command[index + 1] === "\n") {
						index += 2;
						continue;
					}
					if ('"\\$`'.includes(command[index + 1] ?? "")) {
						word += command[index + 1];
						index += 2;
						continue;
					}
					word += "\\";
					index++;
					continue;
				}
				if (inner === '"') {
					index++;
					closed = true;
					break;
				}
				if (inner === "$" && command[index + 1] === "(") {
					const end = scanCommandSubstitution(index);
					word += command.slice(index, end);
					index = end;
					continue;
				}
				if (inner === "`") {
					const end = scanBacktick(index);
					word += command.slice(index, end);
					index = end;
					continue;
				}
				word += inner;
				index++;
			}
			if (!closed) incomplete = true;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") {
			const end = scanCommandSubstitution(index);
			word += command.slice(index, end);
			hasWord = true;
			index = end;
			continue;
		}
		if (char === "`") {
			const end = scanBacktick(index);
			word += command.slice(index, end);
			hasWord = true;
			index = end;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r" || char === "(" || char === ")") {
			flushWord();
			index++;
			continue;
		}
		if (char === "\n") {
			flushWord();
			tokens.push({ kind: "operator", value: "\n" });
			index++;
			for (const heredoc of pendingHeredocs) {
				index = skipHeredocBody(command, index, heredoc.delimiter, heredoc.stripTabs);
			}
			pendingHeredocs.length = 0;
			continue;
		}
		if (char === ">" || char === "<" || (char === "&" && command[index + 1] === ">")) {
			// 2>、2>> 这类文件描述符前缀属于重定向运算符，不是单词。
			if (hasWord && /^[0-9]+$/u.test(word)) {
				word = "";
				hasWord = false;
			}
			flushWord();
			if (char === ">") {
				if (command[index + 1] === ">") tokens.push({ kind: "redirect", op: ">>", write: true });
				else if (command[index + 1] === "&") tokens.push({ kind: "redirect", op: ">&", write: false });
				else tokens.push({ kind: "redirect", op: ">", write: true });
				index += command[index + 1] === ">" || command[index + 1] === "&" ? 2 : 1;
				continue;
			}
			if (char === "<") {
				if (command[index + 1] === "<" && command[index + 2] === "<") {
					tokens.push({ kind: "redirect", op: "<<<", write: false });
					index += 3;
					continue;
				}
				if (command[index + 1] === "<") {
					const stripTabs = command[index + 2] === "-";
					index += stripTabs ? 3 : 2;
					const delimiter = readHeredocDelimiter();
					if (delimiter === undefined) incomplete = true;
					else pendingHeredocs.push({ delimiter, stripTabs });
					tokens.push({ kind: "redirect", op: stripTabs ? "<<-" : "<<", write: false });
					continue;
				}
				if (command[index + 1] === "&") {
					tokens.push({ kind: "redirect", op: "<&", write: false });
					index += 2;
					continue;
				}
				tokens.push({ kind: "redirect", op: "<", write: false });
				index++;
				continue;
			}
			if (command[index + 2] === ">") {
				tokens.push({ kind: "redirect", op: "&>>", write: true });
				index += 3;
			} else {
				tokens.push({ kind: "redirect", op: "&>", write: true });
				index += 2;
			}
			continue;
		}
		if (char === "&" && command[index + 1] === "&") {
			flushWord();
			tokens.push({ kind: "operator", value: "&&" });
			index += 2;
			continue;
		}
		if (char === "|" && command[index + 1] === "|") {
			flushWord();
			tokens.push({ kind: "operator", value: "||" });
			index += 2;
			continue;
		}
		if (char === "|" && command[index + 1] === "&") {
			flushWord();
			tokens.push({ kind: "operator", value: "|&" });
			index += 2;
			continue;
		}
		if (char === "|") {
			flushWord();
			tokens.push({ kind: "operator", value: "|" });
			index++;
			continue;
		}
		if (char === "&") {
			flushWord();
			tokens.push({ kind: "operator", value: "&" });
			index++;
			continue;
		}
		if (char === ";") {
			flushWord();
			tokens.push({ kind: "operator", value: ";" });
			index++;
			continue;
		}
		word += char;
		hasWord = true;
		index++;
	}
	flushWord();
	return { tokens, incomplete };
}

function groupSegments(tokens: ShellToken[]): { segments: ShellSegment[]; incomplete: boolean } {
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let writes: string[] = [];
	let piped = false;
	let sequenced = false;
	let branched = false;
	let chained = false;
	let heredoc = false;
	let incomplete = false;
	let redirectTarget = false;
	let redirectWrite = false;

	const commit = (next: ShellOperator | null) => {
		if (words.length || writes.length || heredoc) {
			segments.push({ words, writes, piped, sequenced, branched, chained, heredoc });
		}
		words = [];
		writes = [];
		piped = next === "|" || next === "|&";
		sequenced = next === ";" || next === "\n" || next === "&";
		branched = next === "||";
		chained = next === "&&";
		heredoc = false;
	};

	for (const token of tokens) {
		if (token.kind === "word") {
			if (redirectTarget) {
				redirectTarget = false;
				if (redirectWrite && token.value !== "/dev/null") writes.push(token.value);
				redirectWrite = false;
				continue;
			}
			words.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			if (redirectTarget) incomplete = true;
			if (token.op === "<<" || token.op === "<<-") {
				// heredoc 的分隔符已在分词阶段读走，正文不参与命令切分。
				heredoc = true;
				redirectTarget = false;
				redirectWrite = false;
			} else {
				redirectTarget = true;
				redirectWrite = token.write;
			}
			continue;
		}
		if (redirectTarget) {
			incomplete = true;
			redirectTarget = false;
			redirectWrite = false;
		}
		if (!words.length && !writes.length && !heredoc) incomplete = true;
		commit(token.value);
	}
	if (redirectTarget) incomplete = true;
	const lastToken = tokens.at(-1);
	if (lastToken?.kind === "operator" && lastToken.value !== "\n") incomplete = true;
	commit(null);
	return { segments, incomplete };
}

function scanShell(command: string): ScanResult {
	const { tokens, incomplete } = tokenizeShell(command);
	const grouped = groupSegments(tokens);
	return { segments: grouped.segments, incomplete: incomplete || grouped.incomplete };
}

function programName(value: string | undefined): string | undefined {
	const name = value?.split("/").at(-1);
	return name && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(name) ? name : undefined;
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

function fallbackWords(command: string): string[] {
	const trimmed = command.trim();
	return trimmed ? trimmed.split(/\s+/u) : [];
}

// 无法推断语义时，保留具体程序与参数，不把已识别内容抹成“组合命令”。
function commandFallback(command: string, words?: string[]): CommandPresentation {
	const list = words?.length ? words : fallbackWords(command);
	const first = list[0];
	const detail = list.join(" ").trim();
	const name = programName(first);
	// 首词不是可识别的程序名时，只要还有原始片段就保留，不能只给“执行命令”。
	if (!name) return detail ? { action: "执行", target: detail, icon: "terminal" } : { action: "执行", target: "命令", icon: "terminal" };
	const filename = first?.split("/").at(-1) ?? name;
	const rest = list.slice(1);
	if (/\.(?:sh|mjs|cjs|js|ts|tsx|py)$/u.test(filename)) {
		const suffix = rest.length ? `（${rest.join(" ")}）` : "";
		return { action: "运行", target: `${filename} 脚本${suffix}`, icon: "script" };
	}
	return { action: "运行", target: detail || name, icon: "terminal" };
}

function literal(value: string | undefined): string | undefined {
	return value && !value.includes("$") ? value : undefined;
}

function joinScope(paths: string[]): string {
	return paths.length ? `（${paths.join("、")}）` : "";
}

function simpleCommandPresentation(words: string[]): CommandPresentation {
	const invocation = resolveInvocation(words);
	const executable = invocation?.program;
	const args = invocation?.args ?? [];
	const command = words.join(" ");
	const option = (name: string) => {
		const index = args.indexOf(name);
		if (index >= 0) return args[index + 1];
		const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
		return prefixed ? prefixed.slice(name.length + 1) : undefined;
	};
	const scope = (path: string | undefined) => (path && path !== "." ? `（${path}）` : "");
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
		const takesValue = (arg: string) => valueOptions.includes(arg) || valueOptions.some((value) => arg.startsWith(`${value}=`));
		if (args.some((arg) => arg.startsWith("-") && arg !== "--" && !takesValue(arg) && !switches.includes(arg)))
			return commandFallback(command, words);
		const operands = args.filter((arg, index) => {
			if (arg.startsWith("-")) return false;
			const previous = args[index - 1];
			return !(previous !== undefined && valueOptions.includes(previous));
		});
		const explicitPattern = option("-e") ?? option("--regexp");
		const rawPattern = files ? option("-g") ?? option("--glob") : explicitPattern ?? operands[0];
		const pathCandidates = files || explicitPattern ? operands : operands.slice(1);
		const paths = pathCandidates.filter((value) => !value.startsWith("-") && literal(value));
		const pattern = literal(rawPattern);
		return {
			action: files ? "查找" : "搜索",
			target: files ? `${pattern ? `${pattern} 文件` : "文件"}${joinScope(paths)}` : `${pattern ?? "内容"}${joinScope(paths)}`,
			icon: "search",
		};
	}
	if (executable === "ls") {
		const path = literal(args.find((arg) => !arg.startsWith("-")));
		return { action: "查看", target: path ? `${path} 目录` : "当前目录", icon: "folder" };
	}
	if (executable === "pwd") return { action: "查看", target: "当前目录", icon: "folder" };
	if (executable === "wc") {
		const files = args.filter((arg) => !arg.startsWith("-") && literal(arg));
		const unit = args.includes("-l") ? "行数" : args.includes("-w") ? "词数" : args.includes("-m") ? "字符数" : args.includes("-c") ? "字节数" : "内容";
		return { action: "统计", target: `${files.length ? `${files.join("、")} ` : ""}${unit}`, icon: "file" };
	}
	if (executable === "tee") {
		const files = args.filter((arg) => !arg.startsWith("-") && literal(arg));
		return { action: "写入", target: files.length ? `${files.join("、")} 文件` : "文件", icon: "file" };
	}
	if (["cat", "head", "tail", "sed"].includes(executable ?? "")) {
		if (executable === "sed" && args.some((arg) => arg === "-i" || (arg.startsWith("-i") && arg.length > 2) || arg === "--in-place"))
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
			if (options.some((arg) => ["-a", "--annotate", "-s", "--sign", "-m", "--message", "-F", "--file"].includes(arg)) || (options[0] && !options[0].startsWith("-")))
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
			return { action: "运行", target: `git ${args.join(" ")}`, icon: "git" };
	}
	if (executable === "agent-browser") {
		const browserArgs = operands(args, ["--session", "--profile"], ["--restore", "--json"]);
		const operation = browserArgs?.[0] === "find" ? browserArgs[3] : browserArgs?.[0];
		if (operation === "set" && browserArgs?.[1] === "viewport") return { action: "调整", target: "浏览器视口", icon: "script" };
		const activities: Record<string, Pick<CommandPresentation, "action" | "target">> = {
			open: { action: "打开", target: "网页" },
			snapshot: { action: "查看", target: "网页内容" },
			screenshot: { action: "截取", target: "网页截图" },
			click: { action: "点击", target: "网页元素" },
			fill: { action: "填写", target: "网页内容" },
			eval: { action: "执行", target: "网页脚本" },
		};
		const activity = activities[operation ?? ""];
		if (activity) return { ...activity, icon: "search" };
	}
	const biomeArgs = executable === "biome" ? args : executable === "node" && /(?:^|\/)@biomejs\/biome\/bin\/biome$/u.test(args[0] ?? "") ? args.slice(1) : undefined;
	if (biomeArgs?.[0] === "check") return { action: biomeArgs.includes("--write") ? "修正" : "检查", target: "Biome 代码规范", icon: "script" };
	if (executable === "vitest" || (executable === "node" && /(?:^|\/)vitest\/dist\/cli\.js$/u.test(args[0] ?? "")))
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
		// 保留脚本名，用户才能看出到底跑了哪个脚本或子命令。
		if (["check", "lint", "typecheck"].includes(script ?? "")) return { action: "检查", target: `${script} 脚本`, icon: "script" };
		if (script === "test") return { action: "运行", target: `${script} 脚本`, icon: "script" };
		if (script === "build") return { action: "构建", target: `${script} 脚本`, icon: "script" };
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

const heredocScripts: Record<string, string> = {
	bash: "shell 脚本",
	sh: "shell 脚本",
	zsh: "shell 脚本",
	dash: "shell 脚本",
	python: "Python 脚本",
	python3: "Python 脚本",
	node: "Node 脚本",
};

function describeSegment(segment: ShellSegment): CommandPresentation[] {
	const program = programName(segment.words[0]);
	const actions: CommandPresentation[] = [];
	const isEcho = program === "echo" || program === "printf";
	const heredocTarget = segment.heredoc && program ? heredocScripts[program] : undefined;
	if (heredocTarget) {
		actions.push({ action: "运行", target: heredocTarget, icon: "script" });
	} else if (!isEcho && segment.words.length) {
		actions.push(simpleCommandPresentation(segment.words));
	}
	for (const file of segment.writes) actions.push({ action: "写入", target: `${file} 文件`, icon: "file" });
	return actions;
}

function cdPresentation(words: string[]): CommandPresentation {
	const directory = literal(words.slice(1).find((word) => !word.startsWith("-")));
	return { action: "切换", target: `工作目录${directory ? `（${directory}）` : ""}`, icon: "folder" };
}

function joinActions(actions: CommandPresentation[]): { action: string; target: string; icon: CommandIcon } {
	const [first, ...rest] = actions;
	const describe = ({ action, target }: CommandPresentation) => `${action}${/^[\p{Script=Han}]/u.test(target) ? "" : " "}${target}`;
	const labels = rest.map(describe);
	const target = labels.length === 1
		? `${first.target}并${labels[0]}`
		: `${first.target}、${labels.slice(0, -1).join("、")}并${labels.at(-1) ?? ""}`;
	return { action: first.action, target, icon: actions.every((item) => item.icon === first.icon) ? first.icon : "terminal" };
}

// 展示层只推断用户能看懂的动作，不执行、不展开命令。
// 无法推断的片段保留具体程序与参数；任何已识别操作都不会被“组合命令”覆盖。
export function commandPresentation(command: string): CommandPresentation {
	const scan = scanShell(command);
	const commands = scan.segments
		.map((segment) => ({ ...segment, words: segmentWords(segment.words) }))
		.filter((segment) => segment.words.length > 0 || segment.writes.length > 0);
	if (!commands.length) return commandFallback(command);

	const substantive = commands.filter((segment, index) => {
		const program = programName(segment.words[0]);
		if (!program) return segment.writes.length > 0;
		if (program === "cd") return false;
		if (program === "export" || program === "unset" || program === "set" || program === ":") return false;
		if ((program === "echo" || program === "printf") && segment.writes.length === 0) return false;
		if (["head", "tail", "wc", "sort", "uniq", "tr", "cut"].includes(program) && segment.piped) return false;
		if (program === "cat" && commands[index + 1]?.piped && segment.writes.length === 0) return false;
		return true;
	});

	if (!substantive.length) {
		const last = commands.at(-1);
		if (last?.words[0] === "cd") return cdPresentation(last.words);
		return last?.words.length ? simpleCommandPresentation(last.words) : commandFallback(command);
	}

	const actions: CommandPresentation[] = [];
	for (const segment of substantive) actions.push(...describeSegment(segment));
	if (!actions.length) return commandFallback(command);

	const readOnly = actions.every((item) => ["查找", "搜索", "查看", "读取", "查询", "统计"].includes(item.action));
	// 只有整条链的退出码能反映被展示动作时，才算执行结果确定。
	// && 链遇错即停，聚合退出码仍有效；; 换行 | 与 || 会掩盖前面的动作。
	const masking = substantive.some((segment) => {
		const index = commands.indexOf(segment);
		if (index === -1) return false;
		if (segment.branched) return true;
		if (commands[index + 1]?.piped) return true;
		for (let next = index + 1; next < commands.length; next++) {
			if (!commands[next].chained) return true;
		}
		return false;
	});
	const resultUncertain = scan.incomplete || (!readOnly && masking);

	if (actions.length === 1) {
		const presentation: CommandPresentation = { ...actions[0] };
		if (commands.length > 1 || scan.incomplete) presentation.composite = true;
		if (resultUncertain) presentation.resultUncertain = true;
		return presentation;
	}
	const composed: CommandPresentation = { ...joinActions(actions), composite: true };
	if (resultUncertain) composed.resultUncertain = true;
	return composed;
}

// UI 单独展示状态；这里只给稳定动作，非成功终态才补“未完成”。
export function commandRowLabel(command: string, state: ToolBatchState): string {
	const { action, target } = commandPresentation(command);
	const activity = `${action}${/^[\p{Script=Han}]/u.test(target) ? "" : " "}${target}`;
	if (state === "output-error" || state === "output-cancelled" || state === "output-interrupted") return `${activity}未完成`;
	return activity;
}
