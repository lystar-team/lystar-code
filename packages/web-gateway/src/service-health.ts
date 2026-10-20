import { get } from "node:http";

/** 本机服务探测不经过 fetch 的环境代理或全局连接池。 */
export function requestServiceHealth(url: string, options: { signal: AbortSignal }): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = get(url, { agent: false, signal: options.signal }, (response) => {
			const status = response.statusCode;
			if (status === undefined || status < 200 || status > 599) {
				response.resume();
				reject(new Error(`健康检查返回无效 HTTP 状态码：${String(status)}`));
				return;
			}
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.once("error", reject);
			response.once("end", () => {
				resolve(new Response(status === 204 || status === 205 || status === 304 ? null : body, { status }));
			});
		});
		request.once("error", reject);
	});
}
