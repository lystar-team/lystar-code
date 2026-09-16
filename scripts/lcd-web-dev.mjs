export const DEVELOPMENT_WEB_FRONTEND_PORT = 2420;

export function shouldBuildDevelopmentWeb(args) {
	if (args[0] === "web-runtime") return args[1] === "serve";
	if (args[0] !== "web") return false;
	const command = args[1];
	if (command === undefined || command === "--foreground") return true;
	if (command === "gateway" || command === "runtime") return args[2] === "start" || args[2] === "restart";
	if (command === "service") {
		return ["install", "start", "restart", "reconcile"].includes(args[2]);
	}
	return false;
}

export function shouldRunDevelopmentWebFrontend(args) {
	return args[0] === "web" && (args.length === 1 || (args.length === 2 && args[1] === "--foreground"));
}
