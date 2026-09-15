const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const EXTERNAL_SCHEME = /^(?:https?:|mailto:|tel:|irc:|ircs:|xmpp:|data:|blob:|\/\/)/iu;

export function decodeResourceLink(value: string): string {
	const normalized = value.trim();
	try {
		return decodeURI(normalized);
	} catch {
		return normalized;
	}
}

function normalizeResolvedResourcePath(value: string): string {
	const drive = /^[A-Za-z]:/u.exec(value)?.[0];
	const rooted = value.startsWith("/") || drive !== undefined;
	const prefix = drive ? `${drive}/` : value.startsWith("/") ? "/" : "";
	const pathWithoutPrefix = (drive ? value.slice(drive.length) : value).split("/").filter(Boolean).join("/");
	const segments: string[] = [];

	for (const segment of pathWithoutPrefix.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length && segments.at(-1) !== "..") segments.pop();
			else if (!rooted) segments.push(segment);
			continue;
		}
		segments.push(segment);
	}

	const joined = segments.join("/");
	return prefix ? `${prefix}${joined}` : joined || ".";
}

export function resolveResourcePath(basePath: string | undefined, value: string): string {
	const decoded = decodeResourceLink(value);
	const separator = decoded.search(/[?#]/u);
	const target = separator >= 0 ? decoded.slice(0, separator) : decoded;
	if (!target || !basePath || !isLocalResourcePath(decoded) || isAbsoluteResourcePath(target)) return target;

	const isFileUrl = /^file:\/\//iu.test(basePath);
	const normalizedBase = (isFileUrl ? basePath.slice("file://".length) : basePath).replaceAll("\\", "/");
	const baseSeparator = normalizedBase.lastIndexOf("/");
	const baseDirectory = baseSeparator >= 0 ? normalizedBase.slice(0, baseSeparator + 1) : "";
	const resolved = normalizeResolvedResourcePath(`${baseDirectory}${target.replaceAll("\\", "/")}`);
	return isFileUrl ? `file://${resolved}` : resolved;
}

export function isAbsoluteResourcePath(value: string): boolean {
	const normalized = value.trim().replace(/^file:\/\//iu, "");
	return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(normalized);
}

export function isExternalResourceLink(value: string): boolean {
	return EXTERNAL_SCHEME.test(value.trim());
}

export function isLocalResourcePath(value: string): boolean {
	const normalized = value.trim();
	if (!normalized || normalized.startsWith("#") || isExternalResourceLink(normalized)) return false;
	if (!URL_SCHEME.test(normalized)) return true;
	return /^file:/iu.test(normalized);
}
