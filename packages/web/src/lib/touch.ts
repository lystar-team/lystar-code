// 改编自 beUI 的指针原语。触摸屏会为手指补发 pointerenter/pointerleave，各家引擎对按钮聚焦的处理也不同，
// 因此“悬停”只认非触摸且未按下的指针：手指和按在玻璃上的笔都算接触，不算悬停。
export const isHoveringPointer = (event: { pointerType: string; buttons: number }): boolean =>
	event.pointerType !== "touch" && event.buttons === 0;
