

const PROVIDER_ICON_IDS: Record<string, string> = {
	"amazon-bedrock": "bedrock",
	anthropic: "anthropic",
	"ant-ling": "antgroup",
	"azure-openai-responses": "azure",
	baseten: "baseten",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "workersai",
	deepseek: "deepseek",
	fireworks: "fireworks",
	"github-copilot": "githubcopilot",
	google: "google",
	"google-vertex": "vertexai",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi",
	minimax: "minimax",
	"minimax-cn": "minimax",
	mistral: "mistral",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	nvidia: "nvidia",
	openai: "openai",
	"openai-codex": "openai",
	opencode: "opencode",
	"opencode-go": "opencode",
	openrouter: "openrouter",
	together: "together",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	xiaomi: "xiaomimimo",
	zai: "zai",
	"zai-coding-cn": "zai",
};

export function providerIconId(providerId: string) {
	const normalized = providerId.toLowerCase();
	if (PROVIDER_ICON_IDS[normalized]) return PROVIDER_ICON_IDS[normalized];
	if (normalized.startsWith("qwen")) return "qwen";
	if (normalized.startsWith("xiaomi")) return "xiaomimimo";
	if (normalized.startsWith("moonshot")) return "moonshot";
	if (normalized.startsWith("zai")) return "zai";
	return "llmapi";
}

export function modelIconId(providerId: string, modelId: string, name: string) {
	const value = `${providerId} ${modelId} ${name}`.toLowerCase();
	if (/\bclaude\b/iu.test(value)) return "claude";
	if (/\bgemini\b/iu.test(value)) return "gemini";
	if (/\bgemma\b/iu.test(value)) return "gemma";
	if (/\bdeepseek\b/iu.test(value)) return "deepseek";
	if (/\bqwen\b/iu.test(value)) return "qwen";
	if (/\bkimi\b/iu.test(value)) return "kimi";
	if (/\bmistral\b/iu.test(value)) return "mistral";
	if (/\bminimax\b/iu.test(value)) return "minimax";
	if (/\bmoonshot\b/iu.test(value)) return "moonshot";
	if (/\b(chatglm|glm)\b/iu.test(value)) return "chatglm";
	if (/\byi\b/iu.test(value)) return "yi";
	if (/\bnova\b/iu.test(value)) return "nova";
	if (/\b(gpt|openai|o[1-9]\d*)\b/iu.test(value)) return "openai";
	return undefined;
}

export function formatModelDisplayName(model: { id: string; name?: string } | undefined): string {
	if (!model) return "未选择模型";
	const raw = model.name?.trim() || model.id;
	const normalized = raw.replace(/(\d+)-(\d+)/gu, "$1.$2").replace(/[-_/]+/gu, " ");
	return normalized
		.split(/\s+/u)
		.filter(Boolean)
		.map((token) => {
			if (/^gpt$/iu.test(token)) return "GPT";
			if (/^o\d+[a-z]*$/iu.test(token)) return token.toUpperCase();
			if (/^\d+[a-z]+$/iu.test(token)) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
		})
		.join(" ");
}
