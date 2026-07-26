import { readFileSync } from "node:fs";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";

type SkillCommand = SlashCommandInfo & { source: "skill" };

type SkillQuery = {
	symbol: "$" | "@";
	explicitSkill: boolean;
	query: string;
	prefix: string;
};

const SKILL_REFERENCE_PATTERN = /([$@])\[([a-z0-9][a-z0-9-]*)\]/g;
const LEADING_SKILL_COMMAND_PATTERN = /^\/skill:([a-z0-9][a-z0-9-]*)(?:\s+|$)/;

function getSkillName(command: SkillCommand): string {
	return command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
}

function getSkillCommands(pi: ExtensionAPI): SkillCommand[] {
	return pi.getCommands().filter((command): command is SkillCommand => command.source === "skill");
}

export function extractSkillQuery(textBeforeCursor: string): SkillQuery | undefined {
	const match = textBeforeCursor.match(/(?:^|[^a-z0-9_$@])([$@])(\[?)([a-z0-9-]*)$/i);
	if (!match) return undefined;

	const symbol = match[1] as "$" | "@";
	const explicitSkill = match[2] === "[";
	const query = match[3] ?? "";
	return { symbol, explicitSkill, query, prefix: `${symbol}${explicitSkill ? "[" : ""}${query}` };
}

function createSkillItems(commands: SkillCommand[], query: string, symbol: "$" | "@"): AutocompleteItem[] {
	const matches = query
		? fuzzyFilter(commands, query, (command) => `${getSkillName(command)} ${command.description ?? ""}`)
		: commands;

	return matches.map((command) => {
		const name = getSkillName(command);
		return {
			value: `${symbol}[${name}]`,
			label: name,
			description: command.description ? `[Skill] ${command.description}` : "[Skill]",
		};
	});
}

function mergeSuggestions(
	base: AutocompleteSuggestions | null,
	skills: AutocompleteItem[],
	query: SkillQuery,
): AutocompleteSuggestions | null {
	if (query.symbol === "$" || query.explicitSkill) {
		return skills.length > 0 ? { items: skills, prefix: query.prefix } : null;
	}

	const files = base?.items ?? [];
	const items = query.query
		? fuzzyFilter(
				[...files, ...skills],
				query.query,
				(item) => `${item.label ?? item.value} ${item.description ?? ""}`,
			)
		: [...files, ...skills];
	if (items.length === 0) return null;
	return { items, prefix: base?.prefix ?? query.prefix };
}

function applySkillCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
	const afterCursor = currentLine.slice(cursorCol);
	const suffix = afterCursor.startsWith(" ") ? "" : " ";
	const nextLines = [...lines];
	nextLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
	return {
		lines: nextLines,
		cursorLine,
		cursorCol: beforePrefix.length + item.value.length + suffix.length,
	};
}

export function createSkillReferenceAutocompleteProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const query = extractSkillQuery(currentLine.slice(0, cursorCol));
			if (!query) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const skills = createSkillItems(getSkillCommands(pi), query.query, query.symbol);
			const base =
				query.symbol === "@" && !query.explicitSkill
					? await current.getSuggestions(lines, cursorLine, cursorCol, options)
					: null;
			if (options.signal.aborted) return null;
			return mergeSuggestions(base, skills, query);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (/^[$@]\[[a-z0-9][a-z0-9-]*\]$/.test(item.value)) {
				return applySkillCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function collectReferencedSkillNames(text: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	const leadingCommand = text.match(LEADING_SKILL_COMMAND_PATTERN)?.[1];
	if (leadingCommand) {
		names.push(leadingCommand);
		seen.add(leadingCommand);
	}

	for (const match of text.matchAll(SKILL_REFERENCE_PATTERN)) {
		const name = match[2];
		if (!seen.has(name)) {
			names.push(name);
			seen.add(name);
		}
	}
	return names;
}

function escapeXmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function buildSingleSkillBlock(command: SkillCommand, body: string): string {
	const name = getSkillName(command);
	const location = command.sourceInfo.path;
	const baseDir = command.sourceInfo.baseDir ?? location;
	return `<skill name="${name}" location="${escapeXmlAttribute(location)}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

function buildCombinedSkillBlock(skills: Array<{ command: SkillCommand; body: string }>): string {
	const names = skills.map(({ command }) => getSkillName(command));
	const sections = skills.map(({ command, body }) => {
		const name = getSkillName(command);
		const location = command.sourceInfo.path;
		const baseDir = command.sourceInfo.baseDir ?? location;
		return `## ${name}\n\nLocation: ${location}\nReferences are relative to ${baseDir}.\n\n${body}`;
	});
	return `<skill name="${names.join(" + ")}" location="multiple">\nThe user explicitly referenced the following Skills. Apply all of them to the user message below in the listed order.\n\n${sections.join("\n\n---\n\n")}\n</skill>`;
}

export function expandSkillReferences(text: string, commands: SkillCommand[]): string | undefined {
	const names = collectReferencedSkillNames(text);
	const hasInlineReferences = SKILL_REFERENCE_PATTERN.test(text);
	SKILL_REFERENCE_PATTERN.lastIndex = 0;
	if (!hasInlineReferences) return undefined;

	const byName = new Map(commands.map((command) => [getSkillName(command), command]));
	const skills = names.map((name) => {
		const command = byName.get(name);
		if (!command) throw new Error(`Skill“${name}”当前不可用，请执行 /reload 后重新选择。`);
		const body = stripFrontmatter(readFileSync(command.sourceInfo.path, "utf8")).trim();
		return { command, body };
	});

	const userText = text.replace(LEADING_SKILL_COMMAND_PATTERN, "").trim();
	const block =
		skills.length === 1 ? buildSingleSkillBlock(skills[0].command, skills[0].body) : buildCombinedSkillBlock(skills);
	return userText ? `${block}\n\n${userText}` : block;
}

export default function skillReferenceExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => createSkillReferenceAutocompleteProvider(pi, current));
	});

	pi.on("input", (event, ctx) => {
		if (event.text.startsWith("<skill ")) return { action: "continue" as const };
		try {
			const expanded = expandSkillReferences(event.text, getSkillCommands(pi));
			return expanded
				? { action: "transform" as const, text: expanded, images: event.images }
				: { action: "continue" as const };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(message, "error");
			if (ctx.mode === "tui") ctx.ui.setEditorText(event.text);
			return { action: "handled" as const };
		}
	});
}
