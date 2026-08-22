import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const guiRoots = ["packages/gui", "packages/gui-host", "packages/gui-protocol"];
const reverseRoots = ["packages/coding-agent", "packages/tui", "packages/protocol", "packages/client", "packages/server"];
const ignoredDirectories = new Set(["binaries", "dist", "node_modules", "resources", "target"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const failures = [];

function collect(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collect(join(directory, entry.name), files);
			continue;
		}
		if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(join(directory, entry.name));
	}
	return files;
}

function specifiers(file) {
	const sourceText = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
	const values = [];
	function add(node) {
		if (node && ts.isStringLiteralLike(node)) values.push({ value: node.text, position: node.getStart(source) });
	}
	function visit(node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")
		) {
			add(node.arguments[0]);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
		ts.forEachChild(node, visit);
	}
	visit(source);
	return { source, values };
}

function report(file, source, position, message) {
	const location = source.getLineAndCharacterOfPosition(position);
	failures.push(`${relative(root, file)}:${location.line + 1}:${location.character + 1}: ${message}`);
}

function isGuiSpecifier(value) {
	return value.startsWith("@lystar/code-gui") || /(?:^|\/)packages\/gui(?:-host|-protocol)?(?:\/|$)/.test(value);
}

for (const guiRoot of guiRoots) {
	for (const file of collect(join(root, guiRoot))) {
		const path = relative(root, file);
		const { source, values } = specifiers(file);
		for (const { value, position } of values) {
			if (value.includes("modes/interactive") || value.startsWith("@earendil-works/pi-tui")) {
				report(file, source, position, `GUI code must not import TUI implementation: ${value}`);
			}
			if (!value.startsWith("@earendil-works/pi-coding-agent")) continue;
			if (path !== "packages/gui-host/src/runtime-adapter.ts") {
				report(file, source, position, `only runtime-adapter.ts may import Coding Agent: ${value}`);
			} else if (value !== "@earendil-works/pi-coding-agent/core") {
				report(file, source, position, `runtime-adapter.ts must use the public ./core export: ${value}`);
			}
		}
	}
}

for (const reverseRoot of reverseRoots) {
	for (const file of collect(join(root, reverseRoot))) {
		const { source, values } = specifiers(file);
		for (const { value, position } of values) {
			if (isGuiSpecifier(value)) report(file, source, position, `core/TUI packages must not depend on GUI code: ${value}`);
		}
	}
}

if (failures.length > 0) {
	console.error("GUI dependency boundaries are violated:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
