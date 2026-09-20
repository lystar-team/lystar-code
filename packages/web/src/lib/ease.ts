// 引入自 beUI 的共享动效 Token（https://beui.dev）。只保留当前组件使用的曲线和弹簧，
// 后续引入其它 beUI 组件时在此追加。

/** 内容入场与状态过渡的主曲线，比默认 ease-out 更利落。 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** 循环动画（旋转、往返）使用的对称曲线。 */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** 按钮等可点击表面的按下反馈。 */
export const SPRING_PRESS = {
	type: "spring",
	stiffness: 500,
	damping: 30,
	mass: 0.6,
} as const;
