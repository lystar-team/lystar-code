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
