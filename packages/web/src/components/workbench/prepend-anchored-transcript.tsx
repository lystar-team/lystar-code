import { Component } from "react";
import { VirtualizedConversationTranscript, type VirtualizedConversationTranscriptProps } from "./virtualized-transcript";

type ContentAnchor = { key: string; offset: number };

export function captureConversationContentAnchor(scroller: HTMLElement): ContentAnchor | undefined {
	const { top, bottom } = scroller.getBoundingClientRect();
	const candidates = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-key]")).filter((element) => {
		const bounds = element.getBoundingClientRect();
		let visibleTop = Math.max(top, bounds.top);
		let visibleBottom = Math.min(bottom, bounds.bottom);
		for (let parent = element.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
			if (getComputedStyle(parent).overflowY === "visible") continue;
			const clip = parent.getBoundingClientRect();
			visibleTop = Math.max(visibleTop, clip.top);
			visibleBottom = Math.min(visibleBottom, clip.bottom);
		}
		return bounds.height > 0 && visibleBottom - visibleTop > 0.5;
	});
	for (const element of candidates) {
		const bounds = element.getBoundingClientRect();
		if (bounds.height <= 0 || bounds.bottom <= top + 0.5 || bounds.top >= bottom) continue;
		const visibleChild = candidates.some((child) => child !== element && element.contains(child) &&
			child.getBoundingClientRect().height > 0 && child.getBoundingClientRect().bottom > top + 0.5 && child.getBoundingClientRect().top < bottom);
		if (visibleChild) continue;
		const key = element.dataset.transcriptAnchorKey;
		if (key) return { key, offset: bounds.top - top };
	}
	return undefined;
}

export function restoreConversationContentAnchor(scroller: HTMLElement, anchor: ContentAnchor): void {
	const element = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-key]"))
		.reverse().find((candidate) => candidate.dataset.transcriptAnchorKey === anchor.key);
	if (!element) return;
	let delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
	for (let parent = element.parentElement; parent && parent !== scroller && Math.abs(delta) > 0.5; parent = parent.parentElement) {
		if (parent.scrollHeight <= parent.clientHeight || !/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) continue;
		const before = parent.scrollTop;
		parent.scrollTop += delta;
		delta -= parent.scrollTop - before;
	}
	if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
}

/** Correct the measured content offset after Virtuoso's row-level prepend compensation. */
export class PrependAnchoredConversationTranscript<T> extends Component<VirtualizedConversationTranscriptProps<T>> {
	private scroller?: HTMLElement;
	private anchor?: ContentAnchor;
	private resizeObserver?: ResizeObserver;
	private mutationObserver?: MutationObserver;
	private frame?: number;
	private observedRows = new WeakSet<HTMLElement>();

	getSnapshotBeforeUpdate(previous: VirtualizedConversationTranscriptProps<T>): ContentAnchor | null {
		if (previous.sessionKey !== this.props.sessionKey || this.props.followOutput !== false || previous.items === this.props.items || !this.scroller) return null;
		return captureConversationContentAnchor(this.scroller) ?? null;
	}

	componentDidUpdate(previous: VirtualizedConversationTranscriptProps<T>, _state: unknown, snapshot: ContentAnchor | null): void {
		if (previous.sessionKey !== this.props.sessionKey || this.props.followOutput !== false) this.cancelAnchor();
		if (!snapshot || !this.scroller) return;
		this.cancelAnchor();
		this.anchor = snapshot;
		this.resizeObserver = new ResizeObserver(this.scheduleRestore);
		this.resizeObserver.observe(this.scroller);
		for (const element of this.scroller.querySelectorAll<HTMLElement>("[data-virtualized-transcript-row], [data-transcript-anchor-key]")) this.resizeObserver.observe(element);
		this.mutationObserver = new MutationObserver(this.scheduleRestore);
		this.mutationObserver.observe(this.scroller, { childList: true, subtree: true, attributes: true });
		this.scheduleRestore();
	}

	componentWillUnmount(): void {
		this.cancelAnchor();
	}

	private scheduleRestore = (): void => {
		if (!this.scroller || !this.anchor) return;
		// 等到下一帧才恢复锚点会露出补页后的中间位置。
		restoreConversationContentAnchor(this.scroller, this.anchor);
		if (this.frame !== undefined) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = undefined;
			if (!this.scroller || !this.anchor) return;
			for (const element of this.scroller.querySelectorAll<HTMLElement>("[data-virtualized-transcript-row], [data-transcript-anchor-key]")) {
				if (this.observedRows.has(element)) continue;
				this.observedRows.add(element);
				this.resizeObserver?.observe(element);
			}
			restoreConversationContentAnchor(this.scroller, this.anchor);
		});
	};

	private cancelAnchor = (): void => {
		this.anchor = undefined;
		this.resizeObserver?.disconnect();
		this.resizeObserver = undefined;
		this.observedRows = new WeakSet();		this.mutationObserver?.disconnect();
		this.mutationObserver = undefined;
		if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
		this.frame = undefined;
	};

	private handleScrollerRef = (element: HTMLElement | null): void => {
		this.scroller = element ?? undefined;
		this.props.onScrollerRef?.(element);
	};

	private handleScrollAway = (): void => { this.cancelAnchor(); this.props.onUserScrollAway(); };
	private handleScrollUp = (): void => { this.cancelAnchor(); this.props.onUserScrollUp(); };
	private handleScrollDown = (): void => { this.cancelAnchor(); this.props.onUserScrollDown(); };
	private handleExpansion = (): void => { this.cancelAnchor(); this.props.onExpansionIntent?.(); };

	render() {
		return <VirtualizedConversationTranscript {...this.props}
			onScrollerRef={this.handleScrollerRef}
			onUserScrollAway={this.handleScrollAway}
			onUserScrollUp={this.handleScrollUp}
			onUserScrollDown={this.handleScrollDown}
			onExpansionIntent={this.handleExpansion}
		/>;
	}
}
