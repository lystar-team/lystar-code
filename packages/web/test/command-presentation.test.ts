import { describe, expect, it } from "vitest";
import { commandPresentation, commandRowLabel } from "../src/components/ai-elements/command-presentation.ts";

describe("command presentation", () => {
	it("keeps search targets and all search scopes while hiding shell flags", () => {
		const command = "find /home/yean/projectWorkspace/liteasy-pi-agent -maxdepth 3 -name 'tsconfig*'";
		expect(commandRowLabel(command, "input-available")).toBe(
			"查找 tsconfig* 文件（/home/yean/projectWorkspace/liteasy-pi-agent）",
		);
		expect(commandPresentation(command).icon).toBe("search");
		expect(commandRowLabel("find . -type d -name 'components'", "output-available")).toBe("查找 components 目录");
		expect(commandRowLabel("rg --files -g '*.tsx' packages/web", "output-available")).toBe(
			"查找 *.tsx 文件（packages/web）",
		);
		expect(commandRowLabel("rg -n 'lease status' src", "output-available")).toBe("搜索 lease status（src）");
		expect(commandRowLabel("grep -R renewal src", "output-available")).toBe("搜索 renewal（src）");
		expect(commandRowLabel("rg -n --max-count 3 'lease status' src", "output-available")).toBe(
			"搜索 lease status（src）",
		);
	});

	it("lists every search path instead of dropping extra operands", () => {
		expect(commandRowLabel("rg -n 'renewal' src test", "output-available")).toBe("搜索 renewal（src、test）");
		expect(commandRowLabel("grep -R renewal src packages", "output-available")).toBe("搜索 renewal（src、packages）");
		expect(commandRowLabel("rg --files -g '*.ts' packages/web packages/web-protocol", "output-available")).toBe(
			"查找 *.ts 文件（packages/web、packages/web-protocol）",
		);
	});

	it("distinguishes directory, file, Git and project actions", () => {
		const cases = [
			["ls -la packages/web", "查看 packages/web 目录", "folder"],
			["cat src/app.ts", "读取 src/app.ts 文件", "file"],
			["git status --short", "查看代码变更", "git"],
			["git diff --check", "检查代码差异", "git"],
			["npm run check", "检查 check 脚本", "script"],
			["pnpm test", "运行 test 脚本", "script"],
			["wc -l src/app.ts", "统计 src/app.ts 行数", "file"],
			["wc -m src/app.ts", "统计 src/app.ts 字符数", "file"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandRowLabel("head -n 5", "output-available")).toBe("读取文件");
		expect(commandRowLabel("sed -n '1,3p'", "output-available")).toBe("读取文件");
	});

	it("distinguishes Git tag and push effects from reads and dry runs", () => {
		const cases = [
			["git tag -a v1 -m release", "创建 Git 标签"],
			["git tag -f v1 HEAD", "创建或更新 Git 标签"],
			["git tag --force v1 HEAD", "创建或更新 Git 标签"],
			["git tag -l 'v*'", "查看 Git 标签"],
			["git tag -d v1", "删除 Git 标签"],
			["git tag --verify v1", "验证 Git 标签"],
			["git push origin main", "推送到远端仓库"],
			["git push origin --delete obsolete", "删除远端引用"],
			["git push origin :obsolete", "删除远端引用"],
			["git push --mirror origin", "同步远端引用"],
			["git push --prune origin", "同步远端引用"],
			["git push --force origin main", "强制更新远端引用"],
			["git push --dry-run --delete origin obsolete", "检查远端引用删除"],
			["git ls-remote origin refs/tags/v1", "查询远端标签"],
		] as const;
		for (const [command, label] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe("git");
		}
	});

	it("reflects failed, queued and cancelled states without claiming success", () => {
		expect(commandRowLabel("find src -name app.ts", "input-available")).toBe("查找 app.ts 文件（src）");
		expect(commandRowLabel("find src -name app.ts", "input-queued")).toBe("查找 app.ts 文件（src）");
		expect(commandRowLabel("find src -name app.ts", "output-error")).toBe("查找 app.ts 文件（src）未完成");
		expect(commandRowLabel("npm run check", "output-cancelled")).toBe("检查 check 脚本未完成");
		expect(commandRowLabel("git push origin main", "output-interrupted")).toBe("推送到远端仓库未完成");
	});

	it("resolves the executed program across package-manager runners", () => {
		const cases = [
			[
				"npm exec -- tsgo -p packages/web/tsconfig.json --noEmit",
				"检查 TypeScript 类型（packages/web/tsconfig.json）",
				"script",
			],
			["npm --workspace=@lystar/code-web exec -- tsgo --noEmit", "检查 TypeScript 类型", "script"],
			["pnpm -C packages/web exec -- tsc --noEmit", "检查 TypeScript 类型", "script"],
			["npx --yes --package typescript -- tsc --noEmit", "检查 TypeScript 类型", "script"],
			["npm exec --package=typescript -- tsgo --noEmit", "检查 TypeScript 类型", "script"],
			["yarn dlx -- vitest --run", "运行 Vitest 测试", "script"],
			["bun x -- tsgo --noEmit", "检查 TypeScript 类型", "script"],
			["pnpm exec -- prettier --check .", "运行 prettier 工具", "script"],
			["pnpm exec -- node node_modules/vitest/dist/cli.js --run", "运行 Vitest 测试", "script"],
			["npm run check -- --reporter=verbose", "检查 check 脚本", "script"],
			["npm --workspace packages/web run lint", "检查 lint 脚本", "script"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
	});

	it("describes browser actions without putting session arguments in the title", () => {
		const cases = [
			["agent-browser --session review open http://127.0.0.1:2420/", "打开网页"],
			["agent-browser --session review snapshot -i -c -d 5", "查看网页内容"],
			["agent-browser --session review screenshot /tmp/review.png", "截取网页截图"],
			["agent-browser --session review set viewport 390 844", "调整浏览器视口"],
			["agent-browser --session review find role button click --name 关闭审阅工作区", "点击网页元素"],
			["agent-browser --session review fill @e21 工具调用", "填写网页内容"],
		] as const;
		for (const [command, label] of cases) expect(commandRowLabel(command, "output-available")).toBe(label);
		expect(commandRowLabel("agent-browser --session review unsupported --flag", "output-available")).toContain(
			"unsupported --flag",
		);
	});

	it("describes direct and Node-wrapped Biome checks without listing every input file", () => {
		expect(commandRowLabel("biome check --error-on-warnings .", "output-available")).toBe("检查 Biome 代码规范");
		expect(
			commandRowLabel(
				"node node_modules/@biomejs/biome/bin/biome check --write src/app.ts test/app.test.ts",
				"output-available",
			),
		).toBe("修正 Biome 代码规范");
	});

	it("keeps the program and arguments instead of erasing unknown detail", () => {
		const cases = [
			["custom-task --verbose", "运行 custom-task --verbose", "terminal"],
			["git fetch origin", "运行 git fetch origin", "git"],
			["mkdir -p a/b", "运行 mkdir -p a/b", "terminal"],
			["rg --bogus foo src", "运行 rg --bogus foo src", "terminal"],
			["find . -name '*.tmp' -delete", "运行 find . -name *.tmp -delete", "terminal"],
			["sed -i 's/a/b/' src/app.ts", "运行 sed -i s/a/b/ src/app.ts", "terminal"],
			["npm exec --", "运行 npm exec --", "terminal"],
			["npm run --", "运行 npm run --", "terminal"],
			["npx --", "运行 npx --", "terminal"],
			["./test.sh", "运行 test.sh 脚本", "script"],
			["node scripts/generate-schema.mjs", "运行 generate-schema.mjs 脚本", "script"],
			["node node_modules/vitest/dist/cli.js --run test/command.test.ts", "运行 Vitest 测试", "script"],
			["npx prettier --check .", "运行 prettier 工具", "script"],
			["$CUSTOM --scope web", "执行 $CUSTOM --scope web", "terminal"],
			["", "执行命令", "terminal"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
	});

	it("describes common compound actions and keeps every action in order", () => {
		const cases = [
			["cd /workspace && find src -name '*.tsx'", "查找 *.tsx 文件（src）", "search"],
			["cd /workspace && rg -n 'renewal' src | head -20", "搜索 renewal（src）", "search"],
			["cd /workspace && npm run check", "检查 check 脚本", "script"],
			["cd /workspace; git status --short", "查看代码变更", "git"],
			["cd /workspace && git status && npm run check", "查看代码变更并检查 check 脚本", "terminal"],
			["cd /workspace", "切换工作目录（/workspace）", "folder"],
			["find . -name '*.ts' && echo done", "查找 *.ts 文件", "search"],
			["rg secret src | head -20", "搜索 secret（src）", "search"],
			["echo info && git push origin main", "推送到远端仓库", "git"],
			["git push origin main | tail -5", "推送到远端仓库", "git"],
			["git push origin main; true", "推送到远端仓库并运行 true", "terminal"],
		] as const;
		for (const [command, label, icon] of cases) {
			expect(commandRowLabel(command, "output-available")).toBe(label);
			expect(commandPresentation(command).icon).toBe(icon);
		}
		expect(commandPresentation("git push origin main | tail -5").resultUncertain).toBe(true);
		expect(commandPresentation("cd /workspace && find src -name '*.tsx'").resultUncertain).toBeUndefined();
	});

	it("keeps multi-operation order beyond the first two actions", () => {
		const command = `cd /workspace && version="0.87.1-lystar.4" && tag="v\${version}" && git tag -a "$tag" HEAD -m "release" && git push origin "$tag" && git ls-remote origin "refs/tags/$tag"`;
		expect(commandRowLabel(command, "output-available")).toBe("创建 Git 标签、推送到远端仓库并查询远端标签");
		expect(commandPresentation(command).icon).toBe("git");
	});

	it("keeps separators and pipes inside quotes, escapes and command substitution", () => {
		expect(commandRowLabel('echo "a && b" && git status', "output-available")).toBe("查看代码变更");
		expect(commandRowLabel('git log --format="%h | %s"', "output-available")).toBe("查看提交记录");
		expect(commandRowLabel('git tag "v$(date +%s)"', "output-available")).toBe("创建 Git 标签");
		expect(
			commandRowLabel(
				'cd /workspace && version=$(git describe --tags) && git tag -a "v$version" -m release',
				"output-available",
			),
		).toBe("创建 Git 标签");
		expect(commandRowLabel('git tag "v`date +%s`"', "output-available")).toBe("创建 Git 标签");
	});

	it("splits real newlines and joins line continuations", () => {
		const multilineSearch = ["cd /workspace", "rg -n 'lease status' src"].join("\n");
		expect(commandRowLabel(multilineSearch, "output-available")).toBe("搜索 lease status（src）");
		expect(commandPresentation(multilineSearch).composite).toBe(true);
		const multilineCheck = ["cd /workspace", "npm run check"].join("\n");
		expect(commandRowLabel(multilineCheck, "output-available")).toBe("检查 check 脚本");
		expect(commandPresentation(multilineCheck).resultUncertain).toBeUndefined();
		expect(commandRowLabel("rg -n 'renewal' \\\n  src", "output-available")).toBe("搜索 renewal（src）");
	});

	it("describes scripts read from heredoc bodies without parsing the body", () => {
		const shellScript = ["bash <<'EOF'", 'echo "a && b"', "EOF"].join("\n");
		expect(commandRowLabel(shellScript, "output-available")).toBe("运行 shell 脚本");
		expect(commandPresentation(shellScript).icon).toBe("script");
		expect(commandPresentation(shellScript).resultUncertain).toBeUndefined();
		const pythonScript = ["python3 - <<'PY'", "print('a | b')", "PY"].join("\n");
		expect(commandRowLabel(pythonScript, "output-available")).toBe("运行 Python 脚本");
	});

	it("keeps every wc and tee target", () => {
		expect(commandRowLabel("wc -l a.txt b.txt", "output-available")).toBe("统计 a.txt、b.txt 行数");
		expect(commandRowLabel("wc -c a.txt b.txt", "output-available")).toBe("统计 a.txt、b.txt 字节数");
		expect(commandRowLabel("tee a.log b.log", "output-available")).toBe("写入 a.log、b.log 文件");
	});

	it("keeps recognized operations for incomplete input", () => {
		expect(commandRowLabel("find . -name 'unfinished", "output-available")).toBe("查找 unfinished 文件");
		expect(commandRowLabel('find . -name "unfinished', "output-available")).toBe("查找 unfinished 文件");
		expect(commandPresentation('find . -name "unfinished').resultUncertain).toBe(true);
		expect(commandRowLabel("cd /workspace && rg -n 'foo' src &&", "output-available")).toBe("搜索 foo（src）");
		expect(commandRowLabel("cd /workspace && git status |", "output-available")).toBe("查看代码变更");
		expect(commandRowLabel("cd /workspace && git tag -a 'unfinished", "output-available")).toBe("创建 Git 标签");
		expect(commandPresentation("cd /workspace && rg -n 'foo' src &&").resultUncertain).toBe(true);
	});

	it("treats || as an uncertain branch and keeps the real action", () => {
		expect(commandRowLabel("cd /workspace && git push origin main || echo failed", "output-available")).toBe(
			"推送到远端仓库",
		);
		expect(commandPresentation("cd /workspace && git push origin main || echo failed").resultUncertain).toBe(true);
	});

	it("keeps file-writing side effects from pipes and redirections", () => {
		expect(commandRowLabel("rg foo src | tee out.txt", "output-available")).toBe(
			"搜索 foo（src）并写入 out.txt 文件",
		);
		expect(commandRowLabel("rg foo src > out.txt", "output-available")).toBe("搜索 foo（src）并写入 out.txt 文件");
		expect(commandRowLabel("tee out.txt", "output-available")).toBe("写入 out.txt 文件");
		expect(commandPresentation("rg foo src > out.txt").resultUncertain).toBeUndefined();
		expect(commandPresentation("rg foo src | tee out.txt").resultUncertain).toBe(true);
	});

	it("drops pipeline output filters from the described action", () => {
		expect(commandRowLabel("rg -n foo src | wc -l", "output-available")).toBe("搜索 foo（src）");
		expect(commandRowLabel("git push origin main | tail -5", "output-available")).toBe("推送到远端仓库");
		expect(commandPresentation("git push origin main | tail -5").resultUncertain).toBe(true);
	});
});
