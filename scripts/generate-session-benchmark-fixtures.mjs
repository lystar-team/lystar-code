import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultOutputDir = resolve(__dirname, "..", ".tmp", "session-bench");
const bytesPerMiB = 1024 * 1024;
const defaultSizes = [16, 64, 256];
const defaultSeed = 8401;
const categoryRatios = {
	normal: 0.6,
	tool: 0.2,
	rich: 0.1,
	compaction: 0.05,
	state: 0.05,
};
const maximumEntryBytes = 32 * 1024;
const tinyGifBase64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function printHelp() {
	console.log(`Usage:
  node scripts/generate-session-benchmark-fixtures.mjs [options]

Generates deterministic pi Session JSONL benchmark fixtures without committing them.

Options:
  --output <dir>    Output directory (default: .tmp/session-bench)
  --sizes <list>    Comma-separated fixture sizes in MiB (default: 16,64,256)
  --seed <number>   Deterministic random seed (default: 8401)
  --help            Show this help
`);
}

function parsePositiveInteger(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

function parseSizes(value) {
	const sizes = value.split(",").map((size) => parsePositiveInteger(size.trim(), "--sizes"));
	if (sizes.length === 0) {
		throw new Error("--sizes must include at least one size");
	}
	return sizes;
}

function parseArgs(argv) {
	const options = {
		outputDir: defaultOutputDir,
		sizes: defaultSizes,
		seed: defaultSeed,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--output" || arg === "--sizes" || arg === "--seed") {
			if (index + 1 >= argv.length) {
				throw new Error(`Missing value for ${arg}`);
			}
			const value = argv[++index];
			if (arg === "--output") {
				options.outputDir = resolve(value);
			} else if (arg === "--sizes") {
				options.sizes = parseSizes(value);
			} else {
				options.seed = parsePositiveInteger(value, "--seed");
			}
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function createRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function createFiller(length, random) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const offset = Math.floor(random() * alphabet.length);
	const pattern = `${alphabet.slice(offset)}${alphabet.slice(0, offset)}`;
	return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

function createUsage() {
	return {
		input: 1024,
		output: 256,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createFixtureWriter(path, seed, sizeMiB) {
	const random = createRandom(seed);
	const fd = openSync(path, "w");
	let bytesWritten = 0;
	let entryNumber = 0;
	let activeId = null;
	const normalEntryIds = [];

	function nextId() {
		entryNumber++;
		return `entry-${entryNumber.toString(36).padStart(6, "0")}`;
	}

	function timestamp() {
		return new Date(Date.UTC(2026, 0, 1, 0, 0, entryNumber)).toISOString();
	}

	function serialize(entry) {
		return `${JSON.stringify(entry)}\n`;
	}

	function writeEntry(entry, advanceActive = true) {
		const line = serialize(entry);
		writeSync(fd, line);
		bytesWritten += Buffer.byteLength(line);
		if (advanceActive) {
			activeId = entry.id;
		}
		return entry.id;
	}

	function createEntry(type, properties = {}, parentId = activeId) {
		return {
			type,
			id: nextId(),
			parentId,
			timestamp: timestamp(),
			...properties,
		};
	}

	function writeEntryWithText(textEntry, targetBytes) {
		const prefix = textEntry.getText();
		textEntry.setText("");
		const baseBytes = Buffer.byteLength(serialize(textEntry.entry));
		textEntry.setText(prefix);
		const prefixBytes = Buffer.byteLength(serialize(textEntry.entry)) - baseBytes;
		if (targetBytes < baseBytes + prefixBytes) {
			throw new Error(`Fixture entry needs ${baseBytes + prefixBytes} bytes but only ${targetBytes} remain`);
		}
		textEntry.setText(`${prefix}${createFiller(targetBytes - baseBytes - prefixBytes, random)}`);
		const line = serialize(textEntry.entry);
		if (Buffer.byteLength(line) !== targetBytes) {
			throw new Error("Fixture entry did not reach its target byte size");
		}
		return writeEntry(textEntry.entry);
	}

	function writeTextChunks(budget, createTextEntry, onEntry) {
		let remaining = budget;
		while (remaining > 0) {
			const textEntry = createTextEntry();
			const prefix = textEntry.getText();
			textEntry.setText("");
			const baseBytes = Buffer.byteLength(serialize(textEntry.entry));
			textEntry.setText(prefix);
			if (remaining < baseBytes) {
				throw new Error(`Fixture category has ${remaining} bytes remaining, below minimum entry size ${baseBytes}`);
			}
			const targetBytes = remaining <= maximumEntryBytes || remaining - maximumEntryBytes < baseBytes ? remaining : maximumEntryBytes;
			const id = writeEntryWithText(textEntry, targetBytes);
			if (onEntry) {
				onEntry(id);
			}
			remaining -= targetBytes;
		}
	}

	function withText(entry, initialText, applyText) {
		let text = initialText;
		return {
			entry,
			getText: () => text,
			setText: (value) => {
				applyText(value);
				text = value;
			},
		};
	}

	function userTextEntry(prefix) {
		const entry = createEntry("message", {
			message: {
				role: "user",
				content: [{ type: "text", text: prefix }],
				timestamp: timestamp(),
			},
		});
		return withText(entry, prefix, (text) => {
			entry.message.content[0].text = text;
		});
	}

	function assistantTextEntry(prefix) {
		const entry = createEntry("message", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: prefix }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: createUsage(),
				stopReason: "stop",
				timestamp: timestamp(),
			},
		});
		return withText(entry, prefix, (text) => {
			entry.message.content[0].text = text;
		});
	}

	function toolResultEntry(toolCallId, prefix) {
		const entry = createEntry("message", {
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: prefix }],
				isError: false,
				timestamp: timestamp(),
			},
		});
		return withText(entry, prefix, (text) => {
			entry.message.content[0].text = text;
		});
	}

	function richTextEntry(index) {
		const variants = [
			"# Benchmark heading\n\n| column | value |\n| --- | --- |\n| status | active |\n\n```ts\nconst fixture = true;\n```\n\n",
			"```mermaid\nflowchart LR\n  Session --> Tail\n  Tail --> Render\n```\n\n",
			"Inline math $E = mc^2$ and display math:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n",
			"> Markdown benchmark block\n> preserves tables, code fences, Mermaid, and LaTeX content.\n\n",
		];
		return assistantTextEntry(variants[index % variants.length]);
	}

	function compactionEntry(prefix) {
		const entry = createEntry("compaction", {
			summary: prefix,
			firstKeptEntryId: normalEntryIds[Math.max(0, normalEntryIds.length - 1)],
			tokensBefore: 120000,
		});
		return withText(entry, prefix, (text) => {
			entry.summary = text;
		});
	}

	function customStateEntry(prefix) {
		const entry = createEntry("custom", {
			customType: "session-benchmark",
			data: { note: prefix },
		});
		return withText(entry, prefix, (text) => {
			entry.data.note = text;
		});
	}

	try {
		const header = {
			type: "session",
			version: 3,
			id: `session-benchmark-${seed}-${sizeMiB}mb`,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: process.cwd(),
		};
		const headerLine = serialize(header);
		writeSync(fd, headerLine);
		bytesWritten += Buffer.byteLength(headerLine);

		const targetBytes = sizeMiB * bytesPerMiB;
		const payloadBytes = targetBytes - bytesWritten;
		const stateBytes = Math.floor(payloadBytes * categoryRatios.state);
		const compactionBytes = Math.floor(payloadBytes * categoryRatios.compaction);
		const richBytes = Math.floor(payloadBytes * categoryRatios.rich);
		const toolBytes = Math.floor(payloadBytes * categoryRatios.tool);
		const normalBytes = payloadBytes - stateBytes - compactionBytes - richBytes - toolBytes;

		let normalIndex = 0;
		writeTextChunks(normalBytes, () => {
			const entry = normalIndex % 2 === 0 ? userTextEntry("Implement the requested session change. ") : assistantTextEntry("The change is complete. ");
			normalIndex++;
			return entry;
		}, (id) => normalEntryIds.push(id));

		let toolBytesRemaining = toolBytes;
		let toolIndex = 0;
		while (toolBytesRemaining > 0) {
			const toolCallId = `tool-benchmark-${toolIndex}`;
			const toolCall = createEntry("message", {
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: `src/file-${toolIndex}.ts` } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: createUsage(),
					stopReason: "toolUse",
					timestamp: timestamp(),
				},
			});
			const toolCallBytes = Buffer.byteLength(serialize(toolCall));
			if (toolBytesRemaining < toolCallBytes) {
				throw new Error("Tool benchmark category cannot fit a tool call");
			}
			writeEntry(toolCall);
			toolBytesRemaining -= toolCallBytes;

			const result = toolResultEntry(toolCallId, `Long tool output ${toolIndex}: `);
			const resultPrefix = result.getText();
			result.setText("");
			const resultBaseBytes = Buffer.byteLength(serialize(result.entry));
			result.setText(resultPrefix);
			if (toolBytesRemaining < resultBaseBytes) {
				throw new Error("Tool benchmark category cannot fit a tool result");
			}
			const resultBytes =
				toolBytesRemaining <= maximumEntryBytes || toolBytesRemaining - maximumEntryBytes < resultBaseBytes
					? toolBytesRemaining
					: maximumEntryBytes;
			writeEntryWithText(result, resultBytes);
			toolBytesRemaining -= resultBytes;
			toolIndex++;
		}

		let richIndex = 0;
		writeTextChunks(richBytes, () => richTextEntry(richIndex++));

		writeTextChunks(compactionBytes, () => compactionEntry("# Compaction checkpoint\n\nPrior work is summarized here.\n\n"));

		const modelChange = createEntry("model_change", { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		const thinkingChange = createEntry("thinking_level_change", { thinkingLevel: "high" }, modelChange.id);
		const branch = createEntry(
			"message",
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "This entry is a deterministic side branch." }],
					timestamp: timestamp(),
				},
			},
			normalEntryIds[Math.floor(normalEntryIds.length / 2)],
		);
		const label = createEntry(
			"label",
			{
				targetId: normalEntryIds[normalEntryIds.length - 1],
				label: "benchmark checkpoint",
			},
			thinkingChange.id,
		);
		const image = createEntry(
			"message",
			{
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Image reference for benchmark coverage." },
						{ type: "image", mimeType: "image/gif", data: tinyGifBase64 },
					],
					timestamp: timestamp(),
				},
			},
			label.id,
		);
		const stateEntries = [modelChange, thinkingChange, branch, label, image];
		let staticStateBytes = 0;
		for (const entry of stateEntries) {
			staticStateBytes += Buffer.byteLength(serialize(entry));
		}
		if (staticStateBytes > stateBytes) {
			throw new Error("State benchmark category exceeds its byte budget");
		}
		writeEntry(modelChange);
		writeEntry(thinkingChange);
		writeEntry(branch, false);
		writeEntry(label);
		writeEntry(image);
		writeTextChunks(stateBytes - staticStateBytes, () => customStateEntry("session benchmark metadata: "));

		if (bytesWritten !== targetBytes) {
			throw new Error(`Fixture size mismatch: expected ${targetBytes}, wrote ${bytesWritten}`);
		}
	} finally {
		closeSync(fd);
	}

	return statSync(path).size;
}

export function generateFixtures({ outputDir, sizes, seed }) {
	mkdirSync(outputDir, { recursive: true });
	return sizes.map((sizeMiB) => {
		const path = resolve(outputDir, `session-${sizeMiB}mb.jsonl`);
		const bytes = createFixtureWriter(path, seed, sizeMiB);
		return { path, sizeMiB, bytes };
	});
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	for (const fixture of generateFixtures(options)) {
		console.log(`${fixture.path} ${fixture.bytes} bytes`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
