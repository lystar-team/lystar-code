export interface MouseEvent {
	button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "other";
	column: number;
	row: number;
	shift: boolean;
	motion: boolean;
	released: boolean;
}

export function parseMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;

	const code = Number.parseInt(match[1], 10);
	const column = Number.parseInt(match[2], 10) - 1;
	const row = Number.parseInt(match[3], 10) - 1;
	if (column < 0 || row < 0) return undefined;

	let button: MouseEvent["button"];
	if ((code & 64) !== 0) {
		button = (code & 3) === 0 ? "wheel-up" : (code & 3) === 1 ? "wheel-down" : "other";
	} else {
		switch (code & 3) {
			case 0:
				button = "left";
				break;
			case 1:
				button = "middle";
				break;
			case 2:
				button = "right";
				break;
			default:
				button = "other";
		}
	}

	return {
		button,
		column,
		row,
		shift: (code & 4) !== 0,
		motion: (code & 32) !== 0,
		released: match[4] === "m",
	};
}
