import { useMemo, useRef } from "react";
import { isHoveringPointer } from "../touch";

interface BoundaryEvent {
	buttons: number;
	pointerId: number;
	pointerType: string;
}

export interface HoverGesture {
	/** 这次进入是否开启了一次悬停：指针是停在表面上方，而不是按住。 */
	enter: (event: BoundaryEvent) => boolean;
	/** 这次离开是否结束了一次真正由该指针开启的悬停。 */
	leave: (event: BoundaryEvent) => boolean;
}

// 改编自 beUI：把一次悬停的进入和离开配对到同一个指针。
//
// 悬停状态只由真正持有它的指针释放，不重新判断 buttons：
// - 手指点完抬手后才补发 leave，若再判断一次“是否悬停”，抬起的手指会被当成鼠标移开，刚展开的面板随即收掉。
// - 鼠标在表面上按下再拖出边界时 leave 带 buttons: 1，忽略它会让展开状态再也收不回来。
//
// 因此这里记的是“接触”而不是“悬停”：以接触方式进入的指针从未持有悬停；没有记录过的 leave 仍然照常生效，
// 否则指针在挂载时就停在表面上（比如面板在光标下方打开）会留下无法收回的状态。
export function useHoverGesture(): HoverGesture {
	const contact = useRef(new Set<number>());

	return useMemo(
		() => ({
			enter: (event) => {
				if (isHoveringPointer(event)) {
					contact.current.delete(event.pointerId);
					return true;
				}
				contact.current.add(event.pointerId);
				return false;
			},
			leave: (event) => {
				const arrivedInContact = contact.current.delete(event.pointerId);
				return !arrivedInContact && event.pointerType !== "touch";
			},
		}),
		[],
	);
}
