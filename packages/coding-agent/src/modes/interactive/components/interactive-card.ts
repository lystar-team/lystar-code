import type { Component } from "@earendil-works/pi-tui";
import type { SubagentRunTarget } from "./subagent-run.ts";

export type InteractiveCardAction =
	| { type: "toggle"; component: InteractiveCard }
	| { type: "openSubagent"; target: SubagentRunTarget };

/** Shared contract for every transcript card that responds to a primary click. */
export interface InteractiveCard extends Component {
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	/** Default behavior is to toggle the whole card for every rendered row. */
	getCardClickActionAtRow?(row: number): InteractiveCardAction | undefined;
	/** Stable key used when a transcript is rebuilt, for example in a live Subagent view. */
	getCardStateKey?(): string | undefined;
	/** Nested cards whose state must survive transcript rebuilds. */
	getChildCards?(): readonly InteractiveCard[];
}

export function isInteractiveCard(component: Component | undefined): component is InteractiveCard {
	return (
		typeof component === "object" &&
		component !== null &&
		"isExpanded" in component &&
		typeof component.isExpanded === "function" &&
		"setExpanded" in component &&
		typeof component.setExpanded === "function"
	);
}

export function resolveInteractiveCardAction(
	component: Component | undefined,
	row: number,
): InteractiveCardAction | undefined {
	if (!isInteractiveCard(component) || row < 0) return undefined;
	return component.getCardClickActionAtRow?.(row) ?? { type: "toggle", component };
}

export function activateInteractiveCard(
	component: Component | undefined,
	row: number,
	onOpenSubagent: (target: SubagentRunTarget) => void,
): InteractiveCardAction | undefined {
	const action = resolveInteractiveCardAction(component, row);
	if (action?.type === "toggle") action.component.setExpanded(!action.component.isExpanded());
	if (action?.type === "openSubagent") onOpenSubagent(action.target);
	return action;
}

export function visitInteractiveCards(components: readonly Component[], visit: (card: InteractiveCard) => void): void {
	for (const component of components) {
		if (!isInteractiveCard(component)) continue;
		visit(component);
		visitInteractiveCards(component.getChildCards?.() ?? [], visit);
	}
}
