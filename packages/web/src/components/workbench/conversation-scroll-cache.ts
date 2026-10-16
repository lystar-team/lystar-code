import type { VirtualItem } from "@tanstack/react-virtual";

export type ConversationScrollAnchor = { key: string; offset: number };

export type ConversationScrollSnapshot = {
	atBottom: boolean;
	anchor?: ConversationScrollAnchor;
	offset: number;
	measurements: VirtualItem[];
};

/** 只保存已测量的位置，不持有消息正文。 */
export class ConversationScrollCache {
	private readonly entries = new Map<string, ConversationScrollSnapshot>();
	private readonly limit: number;

	constructor(limit = 8) {
		this.limit = limit;
	}

	get(key: string): ConversationScrollSnapshot | undefined {
		return this.entries.get(key);
	}

	set(key: string, snapshot: ConversationScrollSnapshot): void {
		this.entries.delete(key);
		this.entries.set(key, snapshot);
		while (this.entries.size > this.limit) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}
}
