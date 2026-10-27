export interface ApiKeyCharacterIssue {
	/** 非法字符在输入中的偏移，从 0 开始。 */
	index: number;
	/** 非法字符的码点，格式为 U+0152。 */
	codePoint: string;
}

/**
 * API Key 会拼成 `Bearer ${apiKey}`，或直接作为 `x-api-key` 的值发送。
 * 这里按请求头的实际约束收紧到 VCHAR（0x21–0x7E）：
 * - SP/HTAB 会切断 Bearer 凭据，上游无法得到完整 Key（RFC 6750 §2.1 的凭据不含空格）；
 * - 控制字符会被拒绝，CR/LF 还会截断请求头（RFC 9110 §5.5）；
 * - 非 ASCII 字符（例如误粘贴的 U+0152）会被 HTTP 客户端拒绝，或变成上游难以解释的错误。
 * 未按单个 Provider 的 Key 格式进一步收紧，避免误拒合法 Key。
 * 返回第一个非法字符，便于直接定位复制或输入时的多余字符。
 */
export function findApiKeyCharacterIssue(value: string): ApiKeyCharacterIssue | undefined {
	let offset = 0;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x21 || code > 0x7e) {
			return {
				index: offset,
				codePoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
			};
		}
		offset += character.length;
	}
	return undefined;
}

export function apiKeyCharacterError(value: string): string | undefined {
	const issue = findApiKeyCharacterIssue(value);
	if (!issue) return undefined;
	return `API Key 第 ${issue.index + 1} 个字符（${issue.codePoint}）不是可打印 ASCII，无法作为请求头发送。请重新复制 Key，去掉多余字符。`;
}
