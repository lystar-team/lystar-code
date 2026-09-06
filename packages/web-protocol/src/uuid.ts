function fillRandomBytes(bytes: Uint8Array): void {
	const webCrypto = globalThis.crypto;
	if (webCrypto && typeof webCrypto.getRandomValues === "function") {
		webCrypto.getRandomValues(bytes);
		return;
	}
	for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
}

/** 在安全上下文不可用或旧浏览器缺少 randomUUID 时，仍生成 UUID 格式的请求标识。 */
export function createUuid(): string {
	const webCrypto = globalThis.crypto;
	if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();

	const bytes = new Uint8Array(16);
	fillRandomBytes(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
