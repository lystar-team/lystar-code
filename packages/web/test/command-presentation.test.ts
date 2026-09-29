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
		for (const command of [
			"npm exec --",
			"npm exec -- --unknown",
			"npm run --",
			"npm exec --package -- tsgo",
			"npm exec -- tsgo | tee output.log",
		]) {
			expect(commandRowLabel(command, "output-available")).toBe("已运行 npm 命令");
			expect(commandPresentation(command).icon).toBe("terminal");
		}
		expect(commandRowLabel("npx --", "output-available")).toBe("已运行 npx 命令");
	});

	it("names the program when the full action cannot be inferred", () => {
		const cases = [
			["custom-task --verbose", "已运行 custom-task 命令", "terminal"],
			["rg secret src | head -20", "已运行 rg 命令", "terminal"],
			["find . -name '*.ts' && echo done", "已运行 find 命令", "terminal"],
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
