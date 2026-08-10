const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

export function extractOpenAICodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (typeof accountId !== "string" || accountId.length === 0) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}
