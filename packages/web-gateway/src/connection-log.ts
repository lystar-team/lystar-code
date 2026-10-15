import { AsyncLocalStorage } from "node:async_hooks";
import { logWebServiceEvent, type ServiceEventFields, watchServiceEventLoop } from "@lystar/code-web-runtime";

const requestContext = new AsyncLocalStorage<string>();

export function withGatewayRequest<T>(requestId: string, run: () => T): T {
	return requestContext.run(requestId, run);
}

export function logGatewayConnection(event: string, fields: ServiceEventFields = {}): void {
	logWebServiceEvent("gateway", event, {
		...fields,
		...(requestContext.getStore() ? { parentRequestId: requestContext.getStore() } : {}),
	});
}

export function watchGatewayEventLoop(): () => void {
	return watchServiceEventLoop("gateway");
}
