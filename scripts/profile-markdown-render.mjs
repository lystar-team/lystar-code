import { Markdown } from "../packages/tui/src/components/markdown.ts";

const identity = (text) => text;
const markdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function createContinuousMarkdown() {
	const unit = "## Section\n\nA deterministic paragraph with **bold**, `code`, and [a link](https://example.test).\n\n";
	return unit.repeat(Math.ceil(64 * 1024 / unit.length)).slice(0, 64 * 1024);
}

function createCodeBlock() {
	return [
		"```typescript",
		...Array.from({ length: 500 }, (_, index) => `const value${index} = ${index};`),
		"```",
	].join("\n");
}

function createTable() {
	const header = Array.from({ length: 20 }, (_, index) => `Column ${index + 1}`);
	const separator = header.map(() => "---");
	const rows = Array.from({ length: 50 }, (_, rowIndex) =>
		header.map((_, columnIndex) => `r${rowIndex + 1}c${columnIndex + 1}`),
	);
	return [header, separator, ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function createMermaidSource() {
	return [
		"```mermaid",
		"graph TD",
		...Array.from({ length: 1000 }, (_, index) => `  node${index}[${index}] --> node${index + 1}[${index + 1}]`),
		"```",
	].join("\n");
}

const fixtures = [
	{ name: "continuous-64kb", source: createContinuousMarkdown() },
	{ name: "code-block-500-lines", source: createCodeBlock() },
	{ name: "table-50x20", source: createTable() },
	{ name: "mermaid-large-source", source: createMermaidSource() },
];

const report = {
	width: 80,
	fixtures: fixtures.map(({ name, source }) => {
		const profiles = [];
		const markdown = new Markdown(source, 0, 0, markdownTheme, undefined, {
			profile: (profile) => profiles.push(profile),
		});
		const outputLines = markdown.render(80).length;
		markdown.render(80);
		return { name, outputLines, profiles };
	}),
};

process.stdout.write(`${JSON.stringify(report)}\n`);
