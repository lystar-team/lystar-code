import { describe, expect, it } from "vitest";
import { commandPresentation, commandRowLabel } from "../src/components/ai-elements/command-presentation.ts";

describe("command presentation", () => {
	it("keeps search targets and locations while hiding shell flags", () => {
		const command = "find /home/yean/projectWorkspace/liteasy-pi-agent -maxdepth 3 -name 'tsconfig*'";
		expect(commandRowLabel(command, "input-available")).toBe(
			"正在查找 tsconfig* 文件（/home/yean/projectWorkspace/liteasy-pi-agent）",
		);
		expect(commandPresentation(command).icon).toBe("search");
		expect(commandRowLabel("find . -type d -name 'components'", "output-available")).toBe("已查找 components 目录");
		expect(commandRowLabel("rg --files -g '*.tsx' packages/web", "output-available")).toBe(
			"已查找 *.tsx 文件（packages/web）",
		);
		expect(commandRowLabel("rg -n 'lease status' src", "output-available")).toBe("已搜索 lease status（src）");
		expect(commandRowLabel("grep -R renewal src", "output-available")).toBe("已搜索 renewal（src）");
		expect(commandRowLabel("rg -n --max-count 3 'lease status' src", "output-available")).toBe(
			"已搜索 lease status（src）",
		);
	});

	it("distinguishes directory, file, Git and project actions", () => {
		const cases = [
			["ls -la packages/web", "已查看 packages/web 目录", "folder"],
			["cat src/app.ts", "已读取 src/app.ts 文件", "file"],
			["git status --short", "已查看代码变更", "git"],
			["git diff --check", "已检查代码差异", "git"],
			["npm run check", "已检查项目代码", "script"],
			["pnpm test", "已运行项目测试", "script"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandRowLabel("head -n 5", "output-available")).toBe("已读取文件");
		expect(commandRowLabel("sed -n '1,3p'", "output-available")).toBe("已读取文件");
	});

	it("distinguishes Git tag and push effects from reads and dry runs", () => {
		const cases = [
			["git tag -a v1 -m release", "已创建 Git 标签"],
			["git tag -f v1 HEAD", "已创建或更新 Git 标签"],
			["git tag --force v1 HEAD", "已创建或更新 Git 标签"],
			["git tag -l 'v*'", "已查看 Git 标签"],
			["git tag -d v1", "已删除 Git 标签"],
			["git tag --verify v1", "已验证 Git 标签"],
			["git push origin main", "已推送到远端仓库"],
			["git push origin --delete obsolete", "已删除远端引用"],
			["git push origin :obsolete", "已删除远端引用"],
			["git push --mirror origin", "已同步远端引用"],
			["git push --prune origin", "已同步远端引用"],
			["git push --force origin main", "已强制更新远端引用"],
			["git push --dry-run --delete origin obsolete", "已检查远端引用删除"],
			["git ls-remote origin refs/tags/v1", "已查询远端标签"],
		] as const;
		for (const [command, label] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe("git");
		}
	});

	it("reflects failed, queued and cancelled states without claiming success", () => {
		expect(commandRowLabel("find src -name app.ts", "input-queued")).toBe("准备查找 app.ts 文件（src）");
		expect(commandRowLabel("find src -name app.ts", "output-error")).toBe("查找 app.ts 文件（src）失败");
		expect(commandRowLabel("npm run check", "output-cancelled")).toBe("检查项目代码已取消");
	});

	it("resolves the executed program across package-manager runners", () => {
		const cases = [
			[
				"npm exec -- tsgo -p packages/web/tsconfig.json --noEmit",
				"已检查 TypeScript 类型（packages/web/tsconfig.json）",
				"script",
			],
			["npm --workspace=@lystar/code-web exec -- tsgo --noEmit", "已检查 TypeScript 类型", "script"],
			["pnpm -C packages/web exec -- tsc --noEmit", "已检查 TypeScript 类型", "script"],
			["npx --yes --package typescript -- tsc --noEmit", "已检查 TypeScript 类型", "script"],
			["npm exec --package=typescript -- tsgo --noEmit", "已检查 TypeScript 类型", "script"],
			["yarn dlx -- vitest --run", "已运行 Vitest 测试", "script"],
			["bun x -- tsgo --noEmit", "已检查 TypeScript 类型", "script"],
			["pnpm exec -- prettier --check .", "已运行 prettier 工具", "script"],
			["pnpm exec -- node node_modules/vitest/dist/cli.js --run", "已运行 Vitest 测试", "script"],
			["npm run check -- --reporter=verbose", "已检查项目代码", "script"],
			["npm --workspace packages/web run lint", "已检查项目代码", "script"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandRowLabel("npm exec -- tsgo --noEmit", "input-available")).toBe("正在检查 TypeScript 类型");
		expect(commandRowLabel("npm exec -- tsgo --noEmit", "output-error")).toBe("检查 TypeScript 类型失败");
	});

	it("never treats separators, switches or missing runner targets as script names", () => {
		for (const command of ["npm exec --", "npm exec -- --unknown", "npm run --", "npm exec --package -- tsgo"]) {
			expect(commandRowLabel(command, "output-available")).toBe("已运行 npm 命令");
			expect(commandPresentation(command).icon).toBe("terminal");
		}
		expect(commandRowLabel("npm exec -- tsgo | tee output.log", "output-available")).toBe("已执行运行 tsgo 工具");
		expect(commandRowLabel("npx --", "output-available")).toBe("已运行 npx 命令");
	});

	it("keeps common compound actions concise without certifying masked side effects", () => {
		const cases = [
			["cd /workspace && find src -name '*.tsx'", "已查找 *.tsx 文件（src）", "search"],
			["cd /workspace && rg -n 'renewal' src | head -20", "已搜索 renewal（src）", "search"],
			["cd /workspace && npm run check", "已检查项目代码", "script"],
			["cd /workspace; git status --short", "已查看代码变更", "git"],
			["cd /workspace && git status && npm run check", "已查看代码变更并检查项目代码", "terminal"],
			["cd /workspace", "已切换工作目录（/workspace）", "folder"],
			["find . -name '*.ts' && echo done", "已查找 *.ts 文件", "search"],
			["rg secret src | head -20", "已搜索 secret（src）", "search"],
			["echo info && git push origin main", "已推送到远端仓库", "git"],
			["git push origin main | tail -5", "已执行推送到远端仓库", "git"],
			["git push origin main; true", "已执行推送到远端仓库并运行 true 命令", "terminal"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandRowLabel("cd /workspace && false && git push origin main", "output-error")).toBe(
			"运行 false 命令并推送到远端仓库未完成",
		);
		expect(commandRowLabel("git push origin main | tail -5", "input-available")).toBe("正在推送到远端仓库");
		expect(commandRowLabel("git push origin main | tail -5", "input-queued")).toBe("准备推送到远端仓库");
		expect(commandRowLabel("git push origin main | tail -5", "output-cancelled")).toBe("推送到远端仓库已取消");
	});

	it("describes tag creation, remote push and verification across assignments and a pipe", () => {
		const command = `cd /workspace && version="0.87.1-lystar.4" && tag="v\${version}" && git tag -a "$tag" HEAD -m "LYStar Code $tag" && git push origin "$tag" 2>&1 | tail -5 && echo "TAG VERIFY" && git ls-remote origin "refs/tags/$tag"`;
		expect(commandRowLabel(command, "input-available")).toBe("正在创建 Git 标签、推送到远端仓库并查询远端标签");
		expect(commandRowLabel(command, "output-available")).toBe("已执行创建 Git 标签、推送到远端仓库并查询远端标签");
		expect(commandRowLabel(command, "output-error")).toBe("创建 Git 标签、推送到远端仓库并查询远端标签未完成");
		expect(commandPresentation(command).icon).toBe("git");
	});

	it("uses a neutral compound title when branch selection or syntax is uncertain", () => {
		for (const command of [
			"cd /workspace && git push origin main || echo failed",
			"cd /workspace && git status &&",
			"cd /workspace && git status |",
			"cd /workspace && git tag -a 'unfinished",
			"cd /workspace && version=$(date +%s) && git tag v1",
			"cd /workspace\ngit status",
		]) {
			expect(commandRowLabel(command, "output-available")).toBe("已执行组合命令");
			expect(commandPresentation(command).icon).toBe("terminal");
		}
	});

	it("names the program when the full action cannot be inferred", () => {
		const cases = [
			["custom-task --verbose", "已运行 custom-task 命令", "terminal"],
			["rg secret src | head -20", "已搜索 secret（src）", "search"],
			["find . -name '*.ts' && echo done", "已查找 *.ts 文件", "search"],
			["find . -name '*.tmp' -delete", "已运行 find 命令", "terminal"],
			["sed -i 's/a/b/' src/app.ts", "已运行 sed 命令", "terminal"],
			["find . -name 'unfinished", "已运行 find 命令", "terminal"],
			["./test.sh", "已运行 test.sh 脚本", "script"],
			["git fetch origin", "已运行 git fetch 命令", "git"],
			["node node_modules/vitest/dist/cli.js --run test/command.test.ts", "已运行 Vitest 测试", "script"],
			["node scripts/generate-schema.mjs", "已运行 generate-schema.mjs 脚本", "script"],
			["npx prettier --check .", "已运行 prettier 工具", "script"],
			["pnpm exec vitest --run", "已运行 Vitest 测试", "script"],
			["", "已执行命令", "terminal"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandRowLabel("custom-task --verbose", "input-available")).toBe("正在运行 custom-task 命令");
		expect(commandRowLabel("custom-task --verbose", "output-error")).toBe("运行 custom-task 命令失败");
	});
});
