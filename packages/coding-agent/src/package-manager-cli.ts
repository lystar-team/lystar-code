import { join } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, getAgentDir, RELEASE_REPOSITORY, VERSION } from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { runLystarInstaller } from "./utils/lystar-updater.ts";
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget =
	| { type: "all" }
	| { type: "self" }
	| { type: "extensions"; source?: string }
	| { type: "models" }
	| { type: "rollback" };

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	showExtensionsSkippedNote: boolean;
	local: boolean;
	force: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|lc|lystar] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force|--rollback]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

function printConfigCommandHelp(): void {
	console.log(`${chalk.bold("用法：")}
  ${CONFIG_COMMAND_USAGE}

打开 Package 资源管理界面，启用或关闭 Package 资源。
不加 -l 时默认编辑全局设置（~/${CONFIG_DIR_NAME}/agent/settings.json）。
在界面中按 Tab 切换全局和项目范围。

选项：
  -l, --local       编辑项目覆盖设置（${CONFIG_DIR_NAME}/settings.json）
  -a, --approve     本次命令信任项目本地文件
  -na, --no-approve 本次命令忽略项目本地文件
`);
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("用法：")}
  ${getPackageCommandUsage("install")}

安装 Package 并写入设置。

选项：
  -l, --local       安装到项目设置（${CONFIG_DIR_NAME}/settings.json）
  -a, --approve     本次命令信任项目本地文件
  -na, --no-approve 本次命令忽略项目本地文件

示例：
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("用法：")}
  ${getPackageCommandUsage("remove")}

移除 Package 及设置中的来源。
别名：${APP_NAME} uninstall <source> [-l]

选项：
  -l, --local       从项目设置移除（${CONFIG_DIR_NAME}/settings.json）
  -a, --approve     本次命令信任项目本地文件
  -na, --no-approve 本次命令忽略项目本地文件

示例：
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("用法：")}
  ${getPackageCommandUsage("update")}

更新 ${APP_TITLE}、已安装 Package 或模型目录。

选项：
  --self                  只更新 ${APP_TITLE}，未指定目标时默认使用
  --extensions            只更新已安装 Package
  --models                只刷新模型目录
  --all                   更新 ${APP_TITLE} 和全部 Package
  --extension <source>    只更新一个 Package
  -a, --approve           本次命令信任项目本地文件
  -na, --no-approve       本次命令忽略项目本地文件
  --rollback              回退到上一个 ${APP_TITLE} 版本
  --force                 即使版本相同也重新安装

简写：
  ${APP_NAME} update                只更新 ${APP_TITLE}
  ${APP_NAME} update --all          更新 ${APP_TITLE} 和全部 Package
  ${APP_NAME} update --models       只刷新模型目录
  ${APP_NAME} update <source>       更新一个 Package
  ${APP_NAME} update lc             只更新 ${APP_TITLE}，lystar 和 self 是等价写法
`);
			return;

		case "list":
			console.log(`${chalk.bold("用法：")}
  ${getPackageCommandUsage("list")}

列出用户与项目设置中的 Package。

选项：
  -a, --approve      本次命令信任项目本地文件
  -na, --no-approve  本次命令忽略项目本地文件
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let rollbackFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--rollback") {
			if (command === "update") {
				rollbackFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	let showExtensionsSkippedNote = false;
	if (command === "update") {
		if (rollbackFlag) {
			if (selfFlag || extensionsFlag || modelsFlag || allFlag || extensionFlagSource || source) {
				conflictingOptions = conflictingOptions ?? "--rollback 不能与其他更新目标一起使用";
			}
			updateTarget = { type: "rollback" };
		} else {
			if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
				conflictingOptions =
					conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
			}
			if (allFlag && source) {
				conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
			}

			if (modelsFlag) {
				if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
					conflictingOptions =
						conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
				}
				if (source) {
					conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
				}
				updateTarget = { type: "models" };
			} else if (extensionFlagSource) {
				if (selfFlag || extensionsFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
				}
				if (source) {
					conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
				}
				updateTarget = { type: "extensions", source: extensionFlagSource };
			} else if (source) {
				const sourceIsSelf =
					source === "self" || source === "lc" || source === "lystar" || source === "la" || source === "pi";
				if (sourceIsSelf) {
					updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
				} else {
					if (extensionsFlag || selfFlag || allFlag) {
						conflictingOptions =
							conflictingOptions ??
							"positional update targets cannot be combined with --self, --extensions, or --all";
					}
					updateTarget = { type: "extensions", source };
				}
			} else if (allFlag || (selfFlag && extensionsFlag)) {
				updateTarget = { type: "all" };
			} else if (selfFlag) {
				updateTarget = { type: "self" };
			} else if (extensionsFlag) {
				updateTarget = { type: "extensions" };
			} else {
				updateTarget = { type: "self" };
				showExtensionsSkippedNote = true;
			}
		}
	}

	return {
		command,
		source,
		updateTarget,
		showExtensionsSkippedNote,
		local,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error("刷新模型目录超时。");
		}
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`模型目录刷新失败：${details}`);
		}
		console.log(chalk.green("模型目录已刷新"));
	} finally {
		clearTimeout(timeout);
	}
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("更新说明")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	version: string;
	shouldRun: boolean;
	note?: string;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		throw new Error(`无法检查 ${APP_NAME} 最新版本：${formatVersionCheckError(error)}`, { cause: error });
	}
	if (!latestRelease) {
		throw new Error(`无法检查 ${APP_NAME} 最新版本。`);
	}

	if (force || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(chalk.green(`${APP_TITLE} 已是最新版本（v${VERSION}）`));
	return { version: latestRelease.version, shouldRun: false };
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	const extensionsResult =
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("项目未受信任。使用 --approve 后才能修改项目资源设置。"));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve()
		: globalResolvedPaths;

	await selectConfig({
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		settingsManager,
		cwd,
		agentDir,
		writeScope: local ? "project" : "global",
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	process.exit(0);
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "未知模型目录刷新错误";
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: options.command === "update",
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("项目未受信任。使用 --approve 后才能修改项目 Package 设置。"));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("没有已安装的 Package。"));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("用户 Package："));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("项目 Package："));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (target.type === "rollback") {
					if (!RELEASE_REPOSITORY) {
						throw new Error("当前构建没有配置 LYStar release repository，无法回退版本");
					}
					await runLystarInstaller(RELEASE_REPOSITORY, ["--rollback"]);
					console.log(chalk.green(`已回退 ${APP_TITLE}`));
					return true;
				}
				if (options.showExtensionsSkippedNote) {
					console.log(
						chalk.dim(
							`本次仅更新 ${APP_TITLE}；如需同时更新 Extension，请运行 ${APP_NAME} update --extensions。`,
						),
					);
				}
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Package 已更新"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					if (!RELEASE_REPOSITORY) {
						throw new Error("当前构建没有配置 LYStar release repository，无法检查或安装更新");
					}
					const plan = await getSelfUpdatePlan(options.force);
					if (!plan.shouldRun) return true;
					if (plan.note) printSelfUpdateNote(plan.note);
					await runLystarInstaller(RELEASE_REPOSITORY, ["--version", plan.version]);
					console.log(chalk.green(`已将 ${APP_TITLE} 从 ${VERSION} 更新到 ${plan.version}`));
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "未知 Package 命令错误";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
