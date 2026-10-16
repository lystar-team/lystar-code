import { parseSessionToolPayload } from "../state/tool-batching.ts";

interface CodemodeStoreChanges {
	set: Record<string, unknown>;
	delete: string[];
}

export function codemodeStoreChanges(detail: string | undefined): CodemodeStoreChanges | undefined {
	const value = parseSessionToolPayload(detail)?.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const changes = value as Record<string, unknown>;
	if (!changes.set || typeof changes.set !== "object" || Array.isArray(changes.set)) return undefined;
	if (!Array.isArray(changes.delete) || !changes.delete.every((key): key is string => typeof key === "string")) return undefined;
	return { set: changes.set as Record<string, unknown>, delete: changes.delete };
}

export function codemodeStoreTitle(detail: string | undefined): string {
	const changes = codemodeStoreChanges(detail);
	if (!changes) return "保存脚本数据";
	const saved = Object.keys(changes.set).length;
	const deleted = changes.delete.length;
	if (!saved && deleted) return `删除脚本数据（${deleted} 项）`;
	return saved ? `保存脚本数据（${saved} 项${deleted ? `，删除 ${deleted} 项` : ""}）` : "保存脚本数据";
}
