/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import type { TuiMode } from "../core/settings-manager.ts";
import { t } from "../locales/zh-CN.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	attached?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	altScreen?: "auto" | "always" | "never";
	mouse?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--use-theme") {
			const themeName = args[i + 1];
			if (themeName === undefined || themeName.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
			} else {
				result.useTheme = themeName;
				i++;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--tui-mode 需要 regular 或 fullscreen" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `TUI 模式“${mode}”无效，可选值：regular、fullscreen`,
				});
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--alt-screen") {
			const mode = args[++i];
			if (mode === "auto" || mode === "always" || mode === "never") {
				result.altScreen = mode;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `--alt-screen 仅支持 auto、always 或 never${mode ? `，收到：${mode}` : ""}`,
				});
			}
		} else if (arg === "--no-alt-screen") {
			result.altScreen = "never";
		} else if (arg === "--mouse") {
			result.mouse = true;
		} else if (arg === "--no-mouse") {
			result.mouse = false;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg === "--attached") {
			result.attached = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI 参数：")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - ${t("app.description")}

${chalk.bold("用法：")}
  ${APP_NAME} [选项] [@文件...] [消息...]

${chalk.bold("命令：")}
  ${APP_NAME} install <source> [-l]     安装 Extension 并写入设置
  ${APP_NAME} remove <source> [-l]      从设置中移除 Extension
  ${APP_NAME} uninstall <source> [-l]   remove 的别名
  ${APP_NAME} update [source|self|lc|lystar] 更新 LYStar Code、Extension 或模型目录
  ${APP_NAME} update --rollback         回退 LYStar Code 到上一版本
  ${APP_NAME} list                      列出设置中的 Extension
  ${APP_NAME} config [-l]               打开 Package 资源管理界面，Tab 切换范围
  ${APP_NAME} auth <command>            输出凭据或检查 Provider 是否可用
  ${APP_NAME} lessons <command>         查看、审批、停用或回滚 Tool 恢复经验
  ${APP_NAME} <command> --help          查看 install/remove/update/config/auth/lessons 等命令帮助

${chalk.bold("选项：")}
  --provider <name>              Provider 名称（默认 google）
  --model <pattern>              模型匹配模式或 ID，支持 provider/id 和 :<thinking>
  --api-key <key>                API key，默认读取环境变量
  --system-prompt <text>         系统提示词
  --append-system-prompt <text>  追加系统提示词文本或文件，可重复使用
  --mode <mode>                  输出模式：text（默认）、json 或 rpc
  --print, -p                    非交互模式，处理消息后退出
  --continue, -c                 继续最近一次会话
  --resume, -r                   选择要继续的会话
  --session <path|id>            使用指定会话文件或部分 UUID
  --session-id <id>              使用准确项目会话 ID，不存在时创建
  --fork <path|id>               从指定会话创建分支
  --session-dir <dir>            会话存储和查找目录
  --no-session                   临时会话，不保存
  --name, -n <name>              设置会话名称
  --models <patterns>            Ctrl+P 循环模型，逗号分隔
                                 支持 glob 和模糊匹配
  --no-tools, -nt                默认禁用全部工具
  --no-builtin-tools, -nbt       默认禁用内置工具，保留 Extension 和自定义工具
  --tools, -t <tools>            启用的工具名称，逗号分隔
  --exclude-tools, -xt <tools>   禁用的工具名称，逗号分隔
  --thinking <level>             思考强度：off、minimal、low、medium、high、xhigh、max
  --extension, -e <path>         加载 Extension 文件，可重复使用
  --no-extensions, -ne           关闭 Extension 自动发现，显式 -e 仍生效
  --skill <path>                 加载 Skill 文件或目录，可重复使用
  --no-skills, -ns               关闭 Skill 自动发现和加载
  --prompt-template <path>       加载 Prompt Template 文件或目录，可重复使用
  --no-prompt-templates, -np     关闭 Prompt Template 自动发现和加载
  --theme <path>                 加载 Theme 文件或目录，可重复使用
  --use-theme <name[/name]>      本次运行使用指定交互主题
  --no-themes                    关闭 Theme 自动发现和加载
  --no-context-files, -nc        关闭 AGENTS.md 和 CLAUDE.md 自动发现
  --export <file>                导出会话为 HTML 后退出
  --list-models [search]         列出可用模型，可附带模糊搜索词
  --verbose                      强制显示详细启动信息
  --tui-mode <mode>              TUI 模式：regular 或 fullscreen
  --alt-screen <mode>            兼容选项：auto、always 或 never
  --no-alt-screen                使用 regular 模式，等价于 --alt-screen never
  --mouse / --no-mouse           启用或关闭全屏鼠标操作
  --approve, -a                  本次运行信任项目本地文件
  --no-approve, -na              本次运行忽略项目本地文件
  --offline                      关闭启动网络请求，等同 PI_OFFLINE=1
  --attached                     Windows 下在当前终端运行 TUI
  --help, -h                     显示帮助
  --version, -v                  显示版本号

Extension 可以注册额外参数，例如 plan-mode 的 --plan。${extensionFlagsText}

${chalk.bold("示例：")}
  # 输出 Provider API key
  ${APP_NAME} auth print-api-key --provider openai

  # 输出 OAuth bearer token，过期前会自动刷新
  ${APP_NAME} auth print-bearer-token --provider openai-codex

  # 检查 Provider 凭据是否可用
  ${APP_NAME} auth check --provider openai

  # 交互模式
  ${APP_NAME}

  # 带初始消息启动交互模式
  ${APP_NAME} "List all .ts files in src/"

  # 在初始消息中附带文件
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # 非交互模式，处理后退出
  ${APP_NAME} -p "List all .ts files in src/"

  # 交互模式下依次发送多条消息
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # 继续上次会话
  ${APP_NAME} --continue "What did we discuss?"

  # 创建命名会话
  ${APP_NAME} --name "Refactor auth module"

  # 使用其他模型
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # 使用带 Provider 前缀的模型
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # 使用模型及思考强度简写
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # 限制 Ctrl+P 循环模型
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # 使用 glob 限制到指定 Provider
  ${APP_NAME} --models "github-copilot/*"

  # 为循环模型固定思考强度
  ${APP_NAME} --models sonnet:high,haiku:low

  # 使用指定思考强度启动
  ${APP_NAME} --thinking high "Solve this complex problem"

  # 只读模式
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # 禁用一个工具，保留其余工具
  ${APP_NAME} --exclude-tools ask_question

  # 导出会话为 HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("环境变量：")}
  ANTHROPIC_AUTH_TOKEN             - Anthropic bearer auth token
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  BASETEN_API_KEY                  - Baseten API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  QWEN_TOKEN_PLAN_API_KEY          - Qwen Token Plan API key (international region)
  QWEN_TOKEN_PLAN_CN_API_KEY       - Qwen Token Plan API key (China region)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - 配置目录（默认 ~/${CONFIG_DIR_NAME}/agent）
  ${ENV_SESSION_DIR.padEnd(32)} - 会话存储目录，可被 --session-dir 覆盖
  PI_PACKAGE_DIR                   - 覆盖 Package 目录，用于 Nix/Guix store
  PI_OFFLINE                       - 设为 1/true/yes 时关闭启动网络请求
  PI_SHARE_VIEWER_URL              - /share 查看地址（默认 https://pi.dev/session/）

${chalk.bold("内置工具名称：")}
  read   - 读取文件内容
  bash   - 执行 Bash 命令
  edit   - 精确查找并替换文件内容
  write  - 创建或覆盖文件
  grep   - 搜索文件内容，只读且默认关闭
  find   - 按 glob 查找文件，只读且默认关闭
  ls     - 列出目录内容，只读且默认关闭
`);
}
