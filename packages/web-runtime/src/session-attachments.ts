import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent/core";

const SESSION_ATTACHMENT_DIRECTORY = ".attachments";
const MAX_SESSION_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const FILE_TAG_PATTERN = /<file\b[^>]*>[\s\S]*?<\/file>/gu;
const FILE_PATH_PATTERN = /\bname="([^"]*)"/u;
const FILE_NAME_PATTERN = /\bfilename="([^"]*)"/u;
const FILE_MIME_PATTERN = /\bmimeType="([^"]*)"/u;
const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"image/apng": ".apng",
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"text/css": ".css",
	"text/html": ".html",
	"text/javascript": ".js",
	"text/markdown": ".md",
	"text/plain": ".txt",
	"text/typescript": ".ts",
};

export interface PromptFileReference {
	path: string;
	filename: string;
	mimeType: string;
}

export interface PersistedSessionAttachment extends PromptFileReference {
	byteLength: number;
	contentHash: string;
}

type DisplayOnlyImageContent = ImageContent & { sendToModel?: boolean };
type RewritableSessionManager = SessionManager & {
	rewriteEntries(entries: readonly SessionEntry[]): void;
};

function isInside(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function xmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeXmlAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function attachmentExtension(filename: string | undefined, mimeType: string): string {
	const extension = filename ? extname(filename).toLowerCase() : "";
	return /^\.[a-z0-9][a-z0-9._-]{0,15}$/u.test(extension) ? extension : (ATTACHMENT_EXTENSIONS[mimeType] ?? ".bin");
}

function mimeTypeFromReference(path: string, filename: string): string {
	const extension = extname(filename || path).toLowerCase();
	return (
		Object.entries(ATTACHMENT_EXTENSIONS).find(([, candidate]) => candidate === extension)?.[0] ??
		"application/octet-stream"
	);
}

function contentTexts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap((part) => {
		if (typeof part === "string") return [part];
		if (!part || typeof part !== "object" || Array.isArray(part)) return [];
		return (part as { type?: unknown; text?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
			? [(part as { text: string }).text]
			: [];
	});
}

export function promptFileReferences(value: unknown): PromptFileReference[] {
	const references: PromptFileReference[] = [];
	for (const text of contentTexts(value)) {
		for (const match of text.matchAll(FILE_TAG_PATTERN)) {
			const tag = match[0];
			const rawPath = tag.match(FILE_PATH_PATTERN)?.[1];
			if (!rawPath) continue;
			const path = decodeXmlAttribute(rawPath).trim();
			if (!path) continue;
			const rawFilename = tag.match(FILE_NAME_PATTERN)?.[1];
			const filename = decodeXmlAttribute(rawFilename ?? "").trim() || basename(path) || "附件";
			const rawMimeType = tag.match(FILE_MIME_PATTERN)?.[1];
			const mimeType = decodeXmlAttribute(rawMimeType ?? "").trim() || mimeTypeFromReference(path, filename);
			references.push({ path, filename, mimeType });
		}
	}
	return references;
}

export function sessionAttachmentDirectory(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	return join(dirname(resolvedPath), SESSION_ATTACHMENT_DIRECTORY, basename(resolvedPath, extname(resolvedPath)));
}

export function resolveSessionAttachmentPath(sessionPath: string, candidate: string): string | undefined {
	try {
		const directory = realpathSync(sessionAttachmentDirectory(sessionPath));
		const path = realpathSync(candidate);
		if (!isInside(directory, path) || !statSync(path).isFile()) return undefined;
		return path;
	} catch {
		return undefined;
	}
}

export async function persistSessionAttachment(
	sessionPath: string,
	input: { bytes: Uint8Array; filename?: string; mimeType: string },
): Promise<PersistedSessionAttachment> {
	if (input.bytes.byteLength === 0) throw new Error("附件内容不能为空");
	if (input.bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES) {
		throw new Error(`附件超过 ${MAX_SESSION_ATTACHMENT_BYTES} 字节的持久化限制`);
	}
	const bytes = Buffer.from(input.bytes);
	const contentHash = createHash("sha256").update(bytes).digest("hex");
	const directory = sessionAttachmentDirectory(sessionPath);
	const filename = input.filename?.trim() || `attachment${attachmentExtension(undefined, input.mimeType)}`;
	const path = join(directory, `${contentHash}${attachmentExtension(filename, input.mimeType)}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await readFile(path);
		if (createHash("sha256").update(existing).digest("hex") !== contentHash) {
			const temporaryPath = join(directory, `.${contentHash}.${process.pid}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
				await rename(temporaryPath, path);
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
		}
	}
	return { path, filename, mimeType: input.mimeType, byteLength: bytes.byteLength, contentHash };
}

export function replacePromptFilePath(text: string, sourcePath: string, targetPath: string): string {
	return text.replaceAll(`name="${xmlAttribute(sourcePath)}"`, `name="${xmlAttribute(targetPath)}"`);
}

function promptFileTag(reference: PromptFileReference): string {
	return `<file name="${xmlAttribute(reference.path)}" filename="${xmlAttribute(reference.filename)}" mimeType="${xmlAttribute(reference.mimeType)}"></file>`;
}

function isLegacyDisplayOnlyImage(part: TextContent | ImageContent): part is DisplayOnlyImageContent {
	return part.type === "image" && (part as DisplayOnlyImageContent).sendToModel === false;
}

async function migrateEntry(
	sessionPath: string,
	entry: SessionEntry,
): Promise<{ entry: SessionEntry; changed: boolean }> {
	if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) {
		return { entry, changed: false };
	}
	const content = entry.message.content;
	const fileReferences = promptFileReferences(content).filter((reference) => reference.mimeType.startsWith("image/"));
	const replacements: Array<{ sourcePath: string; targetPath: string }> = [];
	const appendedReferences: PromptFileReference[] = [];
	const nextContent: Array<TextContent | ImageContent> = [];
	let imageIndex = 0;
	let changed = false;

	for (const part of content) {
		if (!isLegacyDisplayOnlyImage(part)) {
			nextContent.push(part);
			continue;
		}
		const reference = fileReferences[imageIndex++];
		try {
			const bytes = Buffer.from(part.data, "base64");
			if (bytes.byteLength === 0) {
				nextContent.push(part);
				continue;
			}
			const persisted = await persistSessionAttachment(sessionPath, {
				bytes,
				filename: reference?.filename,
				mimeType: part.mimeType,
			});
			if (reference) replacements.push({ sourcePath: reference.path, targetPath: persisted.path });
			else appendedReferences.push(persisted);
			changed = true;
		} catch {
			nextContent.push(part);
		}
	}
	if (!changed) return { entry, changed: false };

	let hasText = false;
	const rewrittenContent = nextContent.map((part) => {
		if (part.type !== "text") return part;
		hasText = true;
		let text = part.text;
		for (const replacement of replacements) {
			text = replacePromptFilePath(text, replacement.sourcePath, replacement.targetPath);
		}
		if (appendedReferences.length > 0) {
			text = `${text}\n\n${appendedReferences.map(promptFileTag).join("\n")}`.trim();
			appendedReferences.length = 0;
		}
		return { ...part, text };
	});
	if (!hasText && appendedReferences.length > 0) {
		rewrittenContent.unshift({ type: "text", text: appendedReferences.map(promptFileTag).join("\n") });
	}
	return {
		entry: {
			...entry,
			message: { ...entry.message, content: rewrittenContent },
		},
		changed: true,
	};
}

export async function migrateLegacyWebAttachments(manager: SessionManager): Promise<boolean> {
	const sessionPath = manager.getSessionFile();
	if (!sessionPath || !existsSync(sessionPath)) return false;
	const nextEntries: SessionEntry[] = [];
	let changed = false;
	for (const entry of manager.getEntries()) {
		const migrated = await migrateEntry(sessionPath, entry);
		nextEntries.push(migrated.entry);
		changed ||= migrated.changed;
	}
	if (!changed) return false;
	(manager as RewritableSessionManager).rewriteEntries(nextEntries);
	return true;
}

export async function rebindSessionAttachments(manager: SessionManager, sourceSessionPath: string): Promise<boolean> {
	const targetSessionPath = manager.getSessionFile();
	if (!targetSessionPath || resolve(targetSessionPath) === resolve(sourceSessionPath)) return false;
	const nextEntries: SessionEntry[] = [];
	let changed = false;
	for (const entry of manager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) {
			nextEntries.push(entry);
			continue;
		}
		const replacements = new Map<string, string>();
		for (const reference of promptFileReferences(entry.message.content)) {
			if (replacements.has(reference.path)) continue;
			const sourcePath = resolveSessionAttachmentPath(sourceSessionPath, reference.path);
			if (!sourcePath) continue;
			try {
				const persisted = await persistSessionAttachment(targetSessionPath, {
					bytes: await readFile(sourcePath),
					filename: reference.filename,
					mimeType: reference.mimeType,
				});
				replacements.set(reference.path, persisted.path);
			} catch {}
		}
		if (replacements.size === 0) {
			nextEntries.push(entry);
			continue;
		}
		const content = entry.message.content.map((part) => {
			if (part.type !== "text") return part;
			let text = part.text;
			for (const [sourcePath, targetPath] of replacements) {
				text = replacePromptFilePath(text, sourcePath, targetPath);
			}
			return { ...part, text };
		});
		nextEntries.push({ ...entry, message: { ...entry.message, content } });
		changed = true;
	}
	if (!changed) return false;
	(manager as RewritableSessionManager).rewriteEntries(nextEntries);
	return true;
}
