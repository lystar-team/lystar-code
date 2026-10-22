import { createHash } from "node:crypto";

interface DeepSeekModel {
	id: string;
	provider: string;
	api: string;
	baseUrl: string;
	compat?: { supportsMidConvoSystemMessages?: boolean };
}

/** Only the official, documented routes opt in. Explicit user overrides remain authoritative. */
export function withDeepSeekCacheCompatibility<T extends DeepSeekModel>(model: T): T {
	if (model.provider !== "deepseek" || model.api !== "openai-completions") return model;
	if (model.id !== "deepseek-flash" && model.id !== "deepseek-v4-pro") return model;
	let endpoint: URL;
	try {
		endpoint = new URL(model.baseUrl);
	} catch {
		return model;
	}
	if (endpoint.origin !== "https://api.deepseek.com" || model.compat?.supportsMidConvoSystemMessages !== undefined)
		return model;
	return { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } };
}

export interface PrefixObservation {
	request: number;
	messages: number;
	unchangedMessages: number;
	toolsChanged: boolean;
	firstChangedMessage?: number;
	firstChangedRole?: string;
	change: "initial" | "append" | "tools" | "history" | "unchanged";
}

/** Observe provider wire messages, including reasoning and tool schemas; never estimates cache tokens. */
export class DeepSeekPrefixTracker {
	private previousMessages: string[] = [];
	private previousTools: string | undefined;
	private requests = 0;
	private observations: PrefixObservation[] = [];

	observe(payload: unknown): PrefixObservation | undefined {
		if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages))
			return;
		const messages = payload.messages.map((message: unknown) =>
			createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		);
		const tools = createHash("sha256")
			.update(JSON.stringify("tools" in payload ? payload.tools : null))
			.digest("hex");
		let unchangedMessages = 0;
		while (
			unchangedMessages < messages.length &&
			unchangedMessages < this.previousMessages.length &&
			messages[unchangedMessages] === this.previousMessages[unchangedMessages]
		)
			unchangedMessages++;
		const toolsChanged = this.requests > 0 && tools !== this.previousTools;
		const firstChangedMessage =
			this.requests > 0 && unchangedMessages < this.previousMessages.length ? unchangedMessages : undefined;
		const firstChanged: unknown =
			firstChangedMessage === undefined ? undefined : payload.messages[firstChangedMessage];
		const firstChangedRole =
			firstChanged &&
			typeof firstChanged === "object" &&
			"role" in firstChanged &&
			typeof firstChanged.role === "string"
				? firstChanged.role
				: undefined;
		const change =
			this.requests === 0
				? "initial"
				: toolsChanged
					? "tools"
					: unchangedMessages < this.previousMessages.length
						? "history"
						: messages.length > this.previousMessages.length
							? "append"
							: "unchanged";
		const observation: PrefixObservation = {
			request: ++this.requests,
			messages: messages.length,
			unchangedMessages,
			toolsChanged,
			...(firstChangedMessage === undefined ? {} : { firstChangedMessage }),
			...(firstChangedRole === undefined ? {} : { firstChangedRole }),
			change,
		};
		this.previousMessages = messages;
		this.previousTools = tools;
		this.observations.push(observation);
		return observation;
	}

	snapshot(): readonly PrefixObservation[] {
		return this.observations.map((observation) => ({ ...observation }));
	}

	reset(): void {
		this.previousMessages = [];
		this.previousTools = undefined;
		this.requests = 0;
		this.observations = [];
	}
}
