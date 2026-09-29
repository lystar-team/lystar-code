import type { Api, Model } from "@earendil-works/pi-ai";

const FAST_MODE_MODELS = new Set([
	"gpt-5.2",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
]);

export function supportsFastMode(model: Pick<Model<Api>, "api" | "provider" | "id" | "fastModeSupported">): boolean {
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
	return (
		model.fastModeSupported ??
		((model.provider === "openai" || model.provider === "openai-codex" || model.provider === "upstream") &&
			FAST_MODE_MODELS.has(model.id))
	);
}
