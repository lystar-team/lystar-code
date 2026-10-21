// 开发验证服务：使用本机脚本响应，不调用模型。
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseInteractiveUiSnapshot } from "../packages/web-protocol/src/interactive-ui.ts";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { loadWebGatewayConfig } from "../packages/web-gateway/src/config.ts";
import { WebGatewayServer } from "../packages/web-gateway/src/server.ts";
import { serveIpcRuntime, closeIpcRuntime } from "../packages/web-runtime/src/ipc.ts";
import { CodingAgentRuntimeAdapter } from "../packages/web-runtime/src/runtime-adapter.ts";
import { WebRuntimeService } from "../packages/web-runtime/src/service.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir || agentDir === join(homedir(), ".pi", "agent")) {
	throw new Error("请通过 PI_CODING_AGENT_DIR 指定独立的临时验证目录，不使用日常会话目录");
}
const frontendPort = 2440;
const gatewayPort = 2442;
const runtimePort = 2443;
const providerPort = 2444;
const password = "openui-preview";
const snapshotOption = process.argv.indexOf("--snapshot");
const snapshotPath = snapshotOption >= 0 ? process.argv[snapshotOption + 1] : undefined;
const suppliedSnapshot = snapshotPath ? parseInteractiveUiSnapshot(await readFile(snapshotPath, "utf8")) : undefined;
if (snapshotOption >= 0 && !suppliedSnapshot) throw new Error("--snapshot 需要有效的交互快照文件");
const parameterProgram = `root = Stack([Text("下面是本地表达式推演，不是项目实测。修改并发数后，结果在浏览器内重新计算，不请求模型。"), NumberInput($n, "并发数"), Value("每分钟理论处理量（项）", $n * 60), Text("假设：每项耗时 1 秒，不计排队、限流和启动开销。")])\n$n = 2`;

await mkdir(agentDir, { recursive: true });
await writeFile(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				"openui-local": {
					baseUrl: `http://127.0.0.1:${providerPort}/v1`,
					api: "openai-completions",
					apiKey: "local-preview",
					models: [
						{
							id: "scripted-openui",
							name: "接入验证 · 本机脚本（非模型）",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 8192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		},
		null,
		2,
	),
);
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify(
		{
			defaultProvider: "openui-local",
			defaultModel: "scripted-openui",
			defaultThinkingLevel: "off",
			autoCompaction: { enabled: false },
			extensions: [join(root, ".pi/extensions/interactive-ui.ts")],
		},
		null,
		2,
	),
);

const provider = createServer(async (request, response) => {
	try {
		if (request.url === "/v1/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ data: [{ id: "scripted-openui" }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			messages: Array<{ role: string; content: unknown }>;
			tools?: Array<{ function: { name: string } }>;
			stream?: boolean;
		};
		const last = body.messages.at(-1);
		const userText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
		const continuation = userText.includes("请继续分析");
		const parameters = userText.includes("参数");
		const toolName = parameters ? "present_ui" : "inspect_project_ui";
		const toolAvailable = body.tools?.some((tool) => tool.function.name === toolName);
		const callTool = last?.role === "user" && !continuation && toolAvailable;
		const args = parameters
			? suppliedSnapshot
				? {
						title: suppliedSnapshot.title,
						program: suppliedSnapshot.program,
						rows: suppliedSnapshot.rows,
						tables: suppliedSnapshot.tables,
						source: suppliedSnapshot.source.label,
					}
				: {
						title: "并发参数推演",
						program: parameterProgram,
						rows: [],
						source: "验证用手写程序 · 每项耗时 1 秒的假设",
					}
			: { checkTypes: true };
		const text = continuation
			? "已收到从交互界面提交的选择，并通过现有会话发送链路回到这里。本次由本机脚本响应，不调用模型，也不会执行修复。"
			: last?.role === "tool"
				? suppliedSnapshot && parameters
					? "上方内容由专用工具发布。界面定义来自 --snapshot 指定的快照文件；本服务只回放内容和验证交互，不调用模型。"
					: "上方内容由专用工具发布。界面定义来自验证脚本，本服务不调用模型。"
				: "这是本机脚本驱动的接入验证。输入“检查项目”查看实时检查结果，或输入“参数推演”修改数值并观察本地计算。";
		console.log(
			JSON.stringify({
				at: new Date().toISOString(),
				type: "scripted_provider",
				role: last?.role,
				tool: callTool ? toolName : undefined,
				toolAvailable,
			}),
		);
		const id = `openui-preview-${Date.now()}`;
		if (!body.stream) {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					id,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "scripted-openui",
					choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
					usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
				}),
			);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const emit = (delta: unknown, finish: string | null = null) =>
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "scripted-openui", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
			);
		emit({ role: "assistant" });
		if (callTool)
			emit({
				tool_calls: [
					{
						index: 0,
						id: `ui-${Date.now()}`,
						type: "function",
						function: { name: toolName, arguments: JSON.stringify(args) },
					},
				],
			});
		else emit({ content: text });
		emit({}, callTool ? "tool_calls" : "stop");
		response.end("data: [DONE]\n\n");
	} catch (error) {
		console.error(error);
		response.writeHead(500).end(String(error));
	}
});
await new Promise<void>((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));
const service = new WebRuntimeService(new CodingAgentRuntimeAdapter({ agentDir }), {
	agentDir,
	persistent: true,
	journalPath: join(agentDir, "host", "operations.jsonl"),
});
const runtimeServer = await serveIpcRuntime(service, `tcp://127.0.0.1:${runtimePort}`);
const config = await loadWebGatewayConfig({
	agentDir,
	defaultPort: gatewayPort,
	defaultRuntimePort: runtimePort,
	staticDir: join(root, "packages/web"),
});
const gateway = new WebGatewayServer({
	...config,
	port: gatewayPort,
	token: password,
	manageRuntime: false,
	runtimeEndpoint: `tcp://127.0.0.1:${runtimePort}`,
});
await gateway.listen();
const vite = await createViteServer({
	configFile: join(root, "packages/web/vite.config.ts"),
	root: join(root, "packages/web"),
	cacheDir: join(agentDir, "vite-cache"),
	server: { port: frontendPort, strictPort: true },
});
await vite.listen();
console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${frontendPort}`,
		password,
		agentDir,
		provider: "本机脚本，不是模型",
		source: root,
		temporaryRoot: tmpdir(),
	}),
);
let closing = false;
const close = async () => {
	if (closing) return;
	closing = true;
	await vite.close();
	await gateway.close();
	await closeIpcRuntime(runtimeServer);
	await service.dispose();
	provider.close();
};
process.once("SIGINT", () => {
	void close();
});
process.once("SIGTERM", () => {
	void close();
});
