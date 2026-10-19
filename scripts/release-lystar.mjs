#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./generate-release-metadata.mjs";
import { execNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "lystar-team/lystar-code";
const versionPattern = /^(\d+)\.(\d+)\.(\d+)-lystar\.(\d+)$/;
const options = { mode: "release", version: null, gh: "gh", upstreamTag: null, allPlatforms: false };
const argv = process.argv.slice(2);
let phase = "读取参数";
let prepared = false;

function run(command, args, overrides = {}) {
	return execFileSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
		...overrides,
	});
}

function gh(args, overrides = {}) {
	return run(options.gh, [...args, "--repo", repository], overrides);
}

function npm(args) {
	console.log(`\n执行 npm ${args.join(" ")}`);
	execNpmSync(args, { cwd: root, stdio: "inherit", timeout: 900_000 });
}

function readJson(path) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function compareVersions(left, right) {
	const a = versionPattern.exec(left).slice(1).map(Number);
	const b = versionPattern.exec(right).slice(1).map(Number);
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function resolveUpstream(tag, current) {
	if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("--upstream-tag 需要正式 Pi Tag，例如 v2.0.0");
	const piVersion = tag.slice(1);
	const commit = run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim();
	run("git", ["merge-base", "--is-ancestor", commit, "HEAD"]);
	const upstreamPackage = JSON.parse(run("git", ["show", `${tag}:packages/coding-agent/package.json`]));
	if (upstreamPackage.version !== piVersion) throw new Error(`${tag} 的 Pi 包版本不是 ${piVersion}`);
	const previousVersion = JSON.parse(gh(["release", "view", "--json", "tagName"])).tagName.replace(/^v/, "");
	if (!versionPattern.test(previousVersion)) throw new Error("GitHub latest 不是有效的 LYStar 正式版本");
	const currentPi = current.split("-lystar.")[0];
	const previousPi = previousVersion.split("-lystar.")[0];
	if (compareVersions(`${piVersion}-lystar.1`, `${currentPi}-lystar.1`) < 0 || compareVersions(`${piVersion}-lystar.1`, `${previousPi}-lystar.1`) < 0) {
		throw new Error("指定 Pi Tag 早于当前产品或最新正式版基线");
	}
	const localTags = run("git", ["tag", "--list", `v${piVersion}-lystar.*`]).trim().split("\n");
	const remoteTags = run("git", ["ls-remote", "--tags", "origin", `refs/tags/v${piVersion}-lystar.*`]).trim().split("\n").map((line) => line.split(/\s+/)[1]?.replace("refs/tags/", ""));
	const revisions = [...localTags, ...remoteTags].filter((value) => value?.startsWith(`v${piVersion}-lystar.`) && versionPattern.test(value.slice(1))).map((value) => Number(versionPattern.exec(value.slice(1))[4]));
	const allocatedRevision = Math.max(0, ...revisions);
	const sameBaseline = piVersion === previousPi;
	const revision = sameBaseline || allocatedRevision > 0
		? Math.max(allocatedRevision, sameBaseline ? Number(versionPattern.exec(previousVersion)[4]) : 0, currentPi === piVersion ? Number(versionPattern.exec(current)[4]) : 0) + 1
		: 1;
	return { piVersion, commit, previousVersion, version: `${piVersion}-lystar.${revision}` };
}

function commit(paths, message, releaseChecked = false) {
	const changed = run("git", ["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
	const unexpected = changed.filter((path) => !paths.has(path));
	if (unexpected.length) throw new Error(`检查期间出现其他文件改动，未提交：\n${unexpected.join("\n")}`);
	if (!changed.length) return;
	run("git", ["diff", "--check"], { stdio: "inherit" });
	run("git", ["add", "--", ...changed]);
	const directory = mkdtempSync(join(tmpdir(), "lystar-release-commit-"));
	try {
		const messageFile = join(directory, "message.txt");
		writeFileSync(messageFile, `${message}\n`);
		run("git", ["commit", "-F", messageFile], {
			stdio: "inherit",
			timeout: 900_000,
			env: { ...process.env, PI_ALLOW_LOCKFILE_CHANGE: "1", PI_RELEASE_CHECKED: releaseChecked ? "1" : "" },
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function prepareVersion(previous, version, packages, upstream) {
	const paths = new Set([
		"package-lock.json",
		"packages/coding-agent/npm-shrinkwrap.json",
		"packages/coding-agent/install-lock/package.json",
		"packages/coding-agent/install-lock/package-lock.json",
		"README.md",
		"packages/coding-agent/README.md",
		"docs/lystar-agent-plan.md",
		"AGENT_VERIFICATION.md",
	]);
	const date = new Intl.DateTimeFormat("sv-SE").format(new Date());
	const previousVersion = upstream?.previousVersion ?? previous;
	const piVersion = version.split("-lystar.")[0];
	const allowedVersions = new Set(upstream ? [previous, previousVersion, piVersion, version] : [previous]);
	for (const directory of packages) {
		const path = `${directory}/package.json`;
		const data = readJson(path);
		if (!data.private && !allowedVersions.has(data.version)) throw new Error(`${path} 的版本不属于本次发行基线：${data.version}`);
		paths.add(path);
		if (allowedVersions.has(data.version)) data.version = version;
		if (data.piConfig) data.piConfig.productVersion = version;
		writeFileSync(join(root, path), `${JSON.stringify(data, null, "\t")}\n`);
		const lock = `${directory}/package-lock.json`;
		if (existsSync(join(root, lock))) {
			paths.add(lock);
			const contents = readJson(lock);
			if (allowedVersions.has(contents.version)) contents.version = version;
			if (allowedVersions.has(contents.packages?.[""]?.version)) contents.packages[""].version = version;
			writeFileSync(join(root, lock), `${JSON.stringify(contents, null, "\t")}\n`);
		}
		const changelog = `${directory}/CHANGELOG.md`;
		if (!existsSync(join(root, changelog))) continue;
		paths.add(changelog);
		const text = readFileSync(join(root, changelog), "utf8");
		const start = text.indexOf("## [Unreleased]");
		if (start < 0) throw new Error(`${changelog} 缺少 [Unreleased]`);
		const bodyStart = text.indexOf("\n", start) + 1;
		const next = text.indexOf("\n## [", bodyStart);
		const bodyEnd = next < 0 ? text.length : next + 1;
		const notes = text.slice(bodyStart, bodyEnd).trim();
		if (!notes && directory !== "packages/coding-agent") continue;
		const releaseNotes = notes || "### Changed\n\n- 递增 LYStar Code 发行版本，同步 workspace 包、内部依赖与发行锁文件。";
		writeFileSync(join(root, changelog), `${text.slice(0, bodyStart).trimEnd()}\n\n## [${version}] - ${date}\n\n${releaseNotes}\n\n${text.slice(bodyEnd)}`);
	}
	for (const path of ["README.md", "packages/coding-agent/README.md"]) {
		let text = readFileSync(join(root, path), "utf8");
		const documentedVersion = [...allowedVersions].find((value) => text.includes(`\`${value}\``));
		if (!documentedVersion) throw new Error(`${path} 当前版本不属于本次发行基线`);
		text = text.replaceAll(`\`${documentedVersion}\``, `\`${version}\``);
		if (upstream) {
			for (const value of new Set([previous, previousVersion].map((value) => value.split("-lystar.")[0]))) {
				text = text.replaceAll(`\`v${value}\``, `\`v${piVersion}\``);
			}
			text = text.replace(/上游 commit 为 `[a-f0-9]{40}`/, `上游 commit 为 \`${upstream.commit}\``);
		}
		writeFileSync(join(root, path), text);
	}
	const planPath = join(root, "docs/lystar-agent-plan.md");
	let plan = readFileSync(planPath, "utf8");
	const baseline = plan.match(/Pi `v([\d.]+)`，commit `([a-f0-9]{40})`；产品版本 `([^`]+)`/);
	if (!baseline || !allowedVersions.has(baseline[3]) || (!upstream && baseline[1] !== piVersion)) {
		throw new Error("建设方案中的 Pi 基线或产品版本未同步");
	}
	const matrix = "|---|---|---|---|---|---|";
	if (!plan.includes(matrix)) throw new Error("未找到兼容矩阵");
	const piCommit = upstream?.commit ?? baseline[2];
	plan = plan.replace(baseline[0], `Pi \`v${piVersion}\`，commit \`${piCommit}\`；产品版本 \`${version}\``);
	if (upstream && baseline[1] !== piVersion) plan = plan.replace(/当前上游基线：\d{4}-\d{2}-\d{2}/, `当前上游基线：${date}`);
	if (!plan.includes(`| \`${version}\` |`)) {
		const row = `| \`${version}\` | \`${piVersion}\` | \`${piCommit.slice(0, 10)}...\` | 见本版 CHANGELOG | 见本版 CHANGELOG | 见本版 CHANGELOG |`;
		plan = plan.replace(matrix, `${matrix}\n${row}`);
	}
	writeFileSync(planPath, plan);
	const recordPath = join(root, "AGENT_VERIFICATION.md");
	let record = readFileSync(recordPath, "utf8");
	const currentFact = record.match(/当前(?:正式|产品)版本为 `([^`]+)`/);
	if (!currentFact || !allowedVersions.has(currentFact[1])) throw new Error("验证记录的当前版本不属于本次发行基线");
	record = record.replace(currentFact[0], `当前产品版本为 \`${version}\``).replace(/上一正式 Tag 为 `[^`]+`/, `上一正式 Tag 为 \`v${previousVersion}\``);
	if (upstream) record = record.replace(/上游 Pi 基线为 `v[\d.]+`（`[a-f0-9]{40}`）/, `上游 Pi 基线为 \`v${piVersion}\`（\`${piCommit}\`）`);
	writeFileSync(recordPath, record);
	run(process.execPath, ["scripts/sync-versions.js"], { stdio: "inherit" });
	npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	for (const script of ["generate-coding-agent-install-lock.mjs", "generate-coding-agent-shrinkwrap.mjs"]) {
		run(process.execPath, [`scripts/${script}`], { stdio: "inherit" });
	}
	return paths;
}

async function waitForRelease(tag, sha) {
	phase = "等待五平台 Release workflow";
	let workflow;
	for (let attempt = 0; attempt < 24; attempt++) {
		const runs = JSON.parse(gh(["run", "list", "--workflow", "release.yml", "--event", "push", "--branch", tag, "--commit", sha, "--limit", "5", "--json", "databaseId,headSha,headBranch,status,conclusion"]));
		workflow = runs.find((entry) => entry.headSha === sha && entry.headBranch === tag);
		if (workflow) break;
		await setTimeout(5_000);
	}
	if (!workflow) throw new Error(`两分钟内未发现 ${tag} 的 Release workflow；用 --resume 继续等待`);
	console.log(`Release workflow：${workflow.databaseId}`);
	gh(["run", "watch", String(workflow.databaseId), "--exit-status", "--interval", "15"], { stdio: "inherit", timeout: 3_600_000 });
	const result = JSON.parse(gh(["run", "view", String(workflow.databaseId), "--json", "status,conclusion,jobs"]));
	if (result.status !== "completed" || result.conclusion !== "success" || result.jobs.some((job) => job.conclusion !== "success")) {
		throw new Error(`Release workflow ${workflow.databaseId} 未全部成功；检查失败任务，不移动现有 Tag`);
	}
	return workflow.databaseId;
}

function verifyRelease(version, tag, sha) {
	phase = "核验公开资产";
	const latest = JSON.parse(gh(["release", "view", "--json", "tagName"]));
	if (options.mode !== "verify" && latest.tagName !== tag) throw new Error(`${tag} 已不是 GitHub latest；使用 --verify 核验历史资产`);
	const release = JSON.parse(gh(["release", "view", tag, "--json", "url,isDraft,isPrerelease,publishedAt,assets"]));
	if (release.isDraft || release.isPrerelease) throw new Error(`${tag} 不是公开正式 Release`);
	const expected = releaseAssetNames(version);
	if (release.assets.length !== expected.length || expected.some((name) => !release.assets.some((asset) => asset.name === name))) {
		throw new Error("公开 Release 资产未与五平台发行清单一致");
	}
	const platform = `${process.platform}-${process.arch}`;
	const archive = expected.find((name) => name.endsWith(`-${platform}.tar.gz`));
	const downloaded = options.allPlatforms ? expected : expected.filter((name) => !name.startsWith("lystar-agent-") || name === archive);
	const directory = mkdtempSync(join(tmpdir(), `lystar-release-${version}-`));
	const checksumScope = options.allPlatforms ? "五平台" : platform;
	console.log(`下载并校验 ${checksumScope} 归档及公共清单：${directory}`);
	const assets = join(directory, "assets");
	mkdirSync(assets);
	gh(["release", "download", tag, "--dir", assets, ...downloaded.flatMap((name) => ["--pattern", name])], { stdio: "inherit", timeout: 1_800_000 });
	mkdirSync(join(directory, "scripts"));
	writeFileSync(join(directory, "scripts/generate-release-metadata.mjs"), readFileSync(join(root, "scripts/generate-release-metadata.mjs")));
	for (const name of ["install.sh", "install.ps1", "install.cmd"]) {
		let contents = run("git", ["show", `${tag}:scripts/${name}`]);
		// 原生 runner 按 .gitattributes 将 Windows 安装脚本检出为 CRLF。
		if (name === "install.cmd" || name === "install.ps1") contents = contents.replace(/\r?\n/g, "\r\n");
		writeFileSync(join(directory, "scripts", name), contents);
	}
	const verifyArgs = options.allPlatforms ? ["--verify"] : ["--verify-platform", platform];
	run(process.execPath, [join(directory, "scripts/generate-release-metadata.mjs"), ...verifyArgs, assets, version, repository], { cwd: directory, stdio: "inherit" });
	const manifest = JSON.parse(readFileSync(join(assets, "release-manifest.json"), "utf8"));
	if (Object.values(manifest.assets).some((asset) => release.assets.find((entry) => entry.name === asset.file)?.size !== asset.size)) {
		throw new Error("公开归档大小与 manifest 不一致");
	}
	gh(["attestation", "verify", join(assets, archive), "--signer-workflow", `${repository}/.github/workflows/release.yml`, "--source-ref", `refs/tags/${tag}`, "--source-digest", sha], { stdio: "inherit", timeout: 180_000 });
	console.log(`公开资产、来源证明与安装器一致性检查通过。验证文件保留在 ${directory}`);
	return { release, directory, checksumScope };
}

async function main() {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help") {
			console.log("用法：npm run release:lystar -- [--dry-run | --resume | --verify <version>] [--upstream-tag <vX.Y.Z>] [--gh <path>] [--all-platforms]\n默认递增 LYStar 修订号、检查、提交推送、打 Tag、等待 Release 并核验当前平台归档与公共清单。\n--upstream-tag 指定已合入的 Pi Tag；新 Pi 基线从 lystar.1 开始，已发布的同基线继续递增。\n--dry-run 仅预览；--resume 不递增版本；--verify 仅核验指定已发布版本。\n--all-platforms 与 --verify 配合，下载并校验全部五平台归档。");
			return;
		}
		if (arg === "--gh") {
			const path = argv[++index];
			if (!path || path.startsWith("--")) throw new Error("--gh 需要 GitHub CLI 路径");
			options.gh = path.includes("/") || path.includes("\\") ? resolve(path) : path;
		} else if (arg === "--upstream-tag" && !options.upstreamTag) {
			options.upstreamTag = argv[++index];
			if (!options.upstreamTag || options.upstreamTag.startsWith("--")) throw new Error("--upstream-tag 需要 Pi Tag");
		} else if (["--dry-run", "--resume", "--verify"].includes(arg) && options.mode === "release") {
			options.mode = arg.slice(2);
			if (arg === "--verify") {
				const value = argv[++index];
				if (!value) throw new Error("--verify 需要版本号");
				options.version = value.replace(/^v/, "");
			}
		} else if (arg === "--all-platforms" && !options.allPlatforms) {
			options.allPlatforms = true;
		} else {
			throw new Error(`未知或重复参数：${arg}`);
		}
	}
	if (options.allPlatforms && options.mode !== "verify") throw new Error("--all-platforms 需要 --verify <version>");
	const product = readJson("packages/coding-agent/package.json");
	const current = product.piConfig.productVersion;
	const parts = versionPattern.exec(current);
	if (!parts || product.piConfig.releaseRepository !== repository) throw new Error("产品版本或发行仓库配置不正确");
	if (options.upstreamTag && !["release", "dry-run"].includes(options.mode)) throw new Error("--upstream-tag 仅用于发布或预览；续跑与核验沿用已准备的版本");
	phase = "选择发行基线";
	const upstream = options.upstreamTag ? resolveUpstream(options.upstreamTag, current) : null;
	if (product.version !== current && (!upstream || ![upstream.piVersion, upstream.version].includes(product.version))) {
		throw new Error("包版本与产品版本不一致；合并上游后请通过 --upstream-tag 指定已合入的 Pi Tag");
	}
	const next = upstream?.version ?? `${parts[1]}.${parts[2]}.${parts[3]}-lystar.${Number(parts[4]) + 1}`;
	const version = options.mode === "release" || options.mode === "dry-run" ? next : options.version ?? current;
	if (!versionPattern.test(version)) throw new Error(`无效 LYStar 版本：${version}`);
	const tag = `v${version}`;
	const packages = findPackageDirectories(join(root, "packages")).map((path) => relative(root, path)).filter((path) => path !== "packages/coding-agent/install-lock");
	const status = run("git", ["status", "--porcelain"]);
	if (options.mode === "dry-run") {
		console.log(`预览：${current} → ${version}\n仓库：${repository}\nTag：${tag}\n同步 ${packages.length} 个 package manifest、内部依赖、锁文件、Changelog 与版本文档。\n增量安装依赖 → npm run check:release → 已有发行测试 → 提交并推送 main → annotated Tag → 五平台 CI 构建 → 当前平台归档与公共清单、隔离升级核验。\nGitHub CLI：${options.gh}\n${status ? `正式发布前需要提交的改动：\n${status}` : "工作区干净。"}\n此次预览未修改文件、提交或发布。`);
		if (upstream) console.log(`上游基线：${options.upstreamTag}（${upstream.commit}）；最新正式版：${upstream.previousVersion}`);
		return;
	}
	phase = "发布前检查";
	if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("本地发布入口支持 Linux/macOS x64/ARM64；Windows 产物由原生 CI 构建");
	if (options.mode !== "verify" && status) throw new Error(`先提交待发布代码；脚本不会漏掉或自动提交这些改动：\n${status}`);
	if (options.mode !== "verify" && run("git", ["branch", "--show-current"]).trim() !== "main") throw new Error("请在 main 分支运行发布入口");
	if (!/github\.com[:/]lystar-team\/lystar-code(?:\.git)?$/.test(run("git", ["remote", "get-url", "origin"]).trim())) throw new Error("origin 未指向 LYStar 发布仓库");
	try {
		gh(["attestation", "verify", "--help"], { stdio: "ignore" });
	} catch {
		throw new Error("需要支持 attestation verify 的 GitHub CLI；升级 gh 或通过 --gh 指定新版路径。尚未修改版本");
	}
	gh(["run", "list", "--limit", "1", "--json", "databaseId"]);
	const remoteTag = run("git", ["ls-remote", "origin", `refs/tags/${tag}`]).trim();
	if (options.mode === "release" && remoteTag) throw new Error(`${tag} 已存在；核验或续跑请使用 --verify/--resume`);
	if (options.mode === "verify" && !remoteTag) throw new Error(`${tag} 尚未推送`);
	if (options.mode !== "verify") {
		run("git", ["fetch", "origin", "main"], { stdio: "inherit" });
		run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
	}
	if (!remoteTag) {
		let paths;
		if (options.mode === "release") {
			phase = "同步版本与锁文件";
			prepared = true;
			paths = prepareVersion(current, version, packages, upstream);
		} else if (!readFileSync(join(root, "packages/coding-agent/CHANGELOG.md"), "utf8").includes(`## [${version}]`)) {
			throw new Error("当前版本尚未完成准备；--resume 不会再次递增版本");
		}
		phase = "发布检查";
		if (!paths) npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
		npm(["run", "check:release"]);
		run("bash", ["scripts/test-install-sh.sh"], { stdio: "inherit", timeout: 180_000 });
		run(process.execPath, ["--test", "scripts/generate-release-metadata.test.mjs"], { stdio: "inherit" });
		run(process.execPath, [join(root, "node_modules/vitest/dist/cli.js"), "--run", "test/config.test.ts", "test/lystar-updater.test.ts", "test/version-check.test.ts", "--maxWorkers=2"], { cwd: join(root, "packages/coding-agent"), stdio: "inherit", timeout: 180_000 });
		if (paths) {
			phase = "提交发行版本";
			commit(paths, `feat(coding-agent): 发布 LYStar Code ${version}`, true);
		}
		if (run("git", ["status", "--porcelain"])) throw new Error("检查后工作区仍有改动，请提交后 --resume");
		phase = "推送 main 和 Tag";
		const localTags = run("git", ["tag", "--list", tag]).trim();
		if (localTags) {
			if (run("git", ["rev-parse", `${tag}^{}`]).trim() !== run("git", ["rev-parse", "HEAD"]).trim() || run("git", ["cat-file", "-t", tag]).trim() !== "tag") throw new Error(`本地 ${tag} 未指向当前发行提交或不是 annotated Tag，不移动它`);
		} else {
			run("git", ["tag", "-a", tag, "HEAD", "-m", `LYStar Code ${tag}`, "-m", "五平台独立发行包，变更说明见本版 CHANGELOG。"]);
		}
		run("git", ["push", "origin", "HEAD:refs/heads/main"], { stdio: "inherit" });
		run("git", ["push", "origin", tag], { stdio: "inherit" });
	} else {
		run("git", ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { stdio: "inherit" });
	}
	const sha = run("git", ["rev-parse", `${tag}^{}`]).trim();
	if (run("git", ["cat-file", "-t", tag]).trim() !== "tag" || JSON.parse(run("git", ["show", `${tag}:packages/coding-agent/package.json`])).piConfig.productVersion !== version) throw new Error("Tag 类型或版本与发行目标不一致");
	const workflow = await waitForRelease(tag, sha);
	const result = verifyRelease(version, tag, sha);
	if (options.mode !== "verify" && run("git", ["rev-parse", "HEAD"]).trim() === sha) {
		phase = "记录发布结果";
		const path = join(root, "AGENT_VERIFICATION.md");
		let text = readFileSync(path, "utf8");
		text = text.replace(`当前产品版本为 \`${version}\``, `当前正式版本为 \`${version}\``).replace(/^> 更新日期：.+$/m, `> 更新日期：${new Intl.DateTimeFormat("sv-SE").format(new Date())}`);
		const record = `## ${version} 自动发布验证\n\n- 记录时间：${new Date().toISOString()}。Annotated Tag \`${tag}\` 指向 \`${sha}\`；Release workflow \`${workflow}\` 的全部 job 成功，公开 Release 不是 draft/prerelease。\n- ${releaseAssetNames(version).length} 个公开资产清单、五平台 manifest 与 SHA 清单、三个安装器一致性校验通过；${result.checksumScope} 归档 SHA 和大小校验通过；${process.platform}-${process.arch} 来源证明通过。\n- 验证产物：\`${result.directory}\`。\n\n`;
		text = text.replace(/\n(?=## (?!当前事实))/, `\n${record}`);
		writeFileSync(path, text);
		commit(new Set(["AGENT_VERIFICATION.md"]), `docs: 记录 ${version} 自动发布验证`);
		run("git", ["push", "origin", "HEAD:refs/heads/main"], { stdio: "inherit" });
	} else if (options.mode === "resume" && run("git", ["rev-parse", "HEAD^"]).trim() === sha && run("git", ["diff", "--name-only", sha, "HEAD"]).trim() === "AGENT_VERIFICATION.md") {
		phase = "推送发布记录";
		run("git", ["push", "origin", "HEAD:refs/heads/main"], { stdio: "inherit" });
	}
	console.log(`\n${options.mode === "verify" ? "验证" : "发布"}完成：${tag}\n${result.release.url}`);
}

main().catch((error) => {
	console.error(`\n${phase}失败：${error.message}`);
	if (prepared) console.error("当前版本改动已保留。发布前失败：修复并提交后用 --resume；Tag 已推送：用 --resume 继续等待与核验。不要再次运行默认递增命令。");
	process.exitCode = 1;
});
