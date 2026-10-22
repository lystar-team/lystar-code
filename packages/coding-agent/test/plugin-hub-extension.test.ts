import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { createPluginHubExtension } from "../src/extensions/plugin-hub/index.ts";
import type { PluginAdapter, PluginAdapterController, PluginAdapterEntry } from "../src/extensions/plugin-hub/types.ts";

function adapter(id: string) {
	const controller = {
		commands: ["list", "install", "reload"],
		list: vi.fn(async (): Promise<readonly PluginAdapterEntry[]> => []),
		execute: vi.fn(async (_args: string, _context: ExtensionCommandContext): Promise<void> => {}),
	} satisfies PluginAdapterController;
	return { id, name: `Harness ${id}`, register: vi.fn(() => controller), controller };
}

async function harness(adapters: readonly PluginAdapter[]) {
	const runtime = createExtensionRuntime();
	const sendMessage = vi.fn<typeof runtime.sendMessage>();
	runtime.sendMessage = sendMessage;
	const extension = await loadExtensionFromFactory(
		createPluginHubExtension(adapters), process.cwd(), createEventBus(), runtime, "<inline:plugin-hub>",
	);
	const command = extension.commands.get("plugins");
	if (!command) throw new Error("Plugin hub command was not registered");
	const waitForIdle = vi.fn(async () => {});
	const reload = vi.fn(async () => {});
	const notify = vi.fn();
	const context = { waitForIdle, reload, ui: { notify } } as unknown as ExtensionCommandContext;
	return { sendMessage, waitForIdle, reload, notify, context, execute: (args: string) => command.handler(args, context) };
}

describe("plugin hub extension", () => {
	it("registers independent sources and aggregates their entry states", async () => {
		const first = adapter("first");
		const second = adapter("second");
		first.controller.list.mockResolvedValue([{ id: "read", name: "Read", state: "active" }, { id: "write", name: "Write", state: "active" }]);
		second.controller.list.mockResolvedValue([{ id: "search", name: "Search", state: "disabled" }]);
		const hub = await harness([first, second]);
		await hub.execute("");
		expect(first.register).toHaveBeenCalledOnce();
		expect(second.register).toHaveBeenCalledOnce();
		expect(hub.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			customType: "plugin-hub-overview",
			content: expect.stringContaining("| first | Harness first | 2 | active: 2 |"),
		}), undefined, undefined);
		expect(hub.sendMessage.mock.calls[0][0].content).toContain("| second | Harness second | 1 | disabled: 1 |");
	});

	it("routes commands to their source and preserves spaces, newlines and trailing whitespace", async () => {
		const first = adapter("first");
		const second = adapter("second");
		const hub = await harness([first, second]);
		await hub.execute("first install alpha  beta\ngamma ");
		expect(first.controller.execute).toHaveBeenCalledExactlyOnceWith("install alpha  beta\ngamma ", hub.context);
		expect(second.controller.execute).not.toHaveBeenCalled();
		await hub.execute("second install delta");
		expect(second.controller.execute).toHaveBeenCalledExactlyOnceWith("install delta", hub.context);
	});

	it("defaults an omitted source operation to list", async () => {
		const source = adapter("first");
		const hub = await harness([source]);
		await hub.execute("first");
		expect(source.controller.execute).toHaveBeenCalledExactlyOnceWith("list", hub.context);
	});

	it("isolates a failing source query while retaining healthy source results", async () => {
		const first = adapter("first");
		const second = adapter("second");
		first.controller.list.mockRejectedValue(new Error("source lookup failed"));
		second.controller.list.mockResolvedValue([{ id: "read", name: "Read", state: "active" }]);
		const hub = await harness([first, second]);
		await hub.execute("list");
		const content = hub.sendMessage.mock.calls[0][0].content;
		expect(content).toContain("查询失败：source lookup failed");
		expect(content).toContain("| second | Harness second | 1 | active: 1 |");
	});

	it("reports an unknown source without dispatching", async () => {
		const source = adapter("first");
		const hub = await harness([source]);
		await hub.execute("missing list");
		expect(hub.notify).toHaveBeenCalledWith(expect.stringContaining("未知插件来源：missing"), "error");
		expect(source.controller.execute).not.toHaveBeenCalled();
	});

	it("rejects unsupported operations before entering the adapter", async () => {
		const source = adapter("first");
		const hub = await harness([source]);
		await hub.execute("first unsupported");
		expect(hub.notify).toHaveBeenCalledWith(expect.stringContaining("list、install、reload"), "error");
		expect(source.controller.execute).not.toHaveBeenCalled();
	});

	it("waits for the active turn before dispatching a management operation", async () => {
		const source = adapter("first");
		const hub = await harness([source]);
		let finish!: () => void;
		hub.waitForIdle.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
		const operation = hub.execute("first install package");
		expect(source.controller.execute).not.toHaveBeenCalled();
		finish();
		await operation;
		expect(source.controller.execute).toHaveBeenCalledOnce();
	});

	it("passes the current command context to adapter reload operations", async () => {
		const source = adapter("first");
		source.controller.execute.mockImplementation(async (_args, context) => { await context.reload(); });
		const hub = await harness([source]);
		await hub.execute("first reload");
		expect(source.controller.execute).toHaveBeenCalledExactlyOnceWith("reload", hub.context);
		expect(hub.reload).toHaveBeenCalledOnce();
	});

	it("propagates adapter execution failures", async () => {
		const source = adapter("first");
		source.controller.execute.mockRejectedValue(new Error("reload failed"));
		const hub = await harness([source]);
		await expect(hub.execute("first reload")).rejects.toThrow("reload failed");
	});

	it("rejects duplicate source identifiers before registering adapters", async () => {
		const source = adapter("first");
		await expect(harness([source, source])).rejects.toThrow("插件来源重复：first");
		expect(source.register).not.toHaveBeenCalled();
	});

	it.each(["", "list", "two sources"])("rejects invalid source identifier %j", async id => {
		const source = adapter(id);
		await expect(harness([source])).rejects.toThrow("无效插件来源标识");
		expect(source.register).not.toHaveBeenCalled();
	});
});
