import { getLystarConfigPath, loadLystarConfig, updateLystarConfig } from "./lystar-config.ts";

const DEFAULT_PRODUCT_NAME = "LYStar Code";
const MAX_PRODUCT_NAME_LENGTH = 64;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u;

export interface ProductBranding {
	name: string;
	logo?: string;
}

function defaultProductBranding(): ProductBranding {
	return { name: DEFAULT_PRODUCT_NAME };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function getProductBrandingPath(agentDir: string): string {
	return getLystarConfigPath(agentDir);
}

function validName(value: unknown): string {
	if (typeof value !== "string") throw new Error("系统名称必须是文本");
	const name = value.trim();
	if (!name) throw new Error("系统名称不能为空");
	if (name.length > MAX_PRODUCT_NAME_LENGTH) throw new Error(`系统名称不能超过 ${MAX_PRODUCT_NAME_LENGTH} 个字符`);
	return name;
}

function validLogo(value: unknown): string {
	if (typeof value !== "string") throw new Error("Logo 必须是图片数据");
	const match = LOGO_DATA_URL_PATTERN.exec(value);
	if (!match || match[2].length % 4 === 1) throw new Error("Logo 只支持 PNG、JPEG、GIF 或 WebP 图片");
	const bytes = Buffer.from(match[2], "base64");
	if (bytes.length === 0) throw new Error("Logo 图片不能为空");
	if (bytes.length > MAX_LOGO_BYTES) throw new Error("Logo 图片不能超过 1 MB");
	return value;
}

function readBranding(config: Record<string, unknown> | undefined): ProductBranding {
	const value = record(config?.branding);
	if (!value) return defaultProductBranding();
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const logo = typeof value.logo === "string" ? value.logo : undefined;
	const result: ProductBranding = {
		name: name && name.length <= MAX_PRODUCT_NAME_LENGTH ? name : DEFAULT_PRODUCT_NAME,
	};
	if (logo) {
		try {
			result.logo = validLogo(logo);
		} catch {
			// 无效的自定义 Logo 不影响 Web 启动，回退到内置 Logo。
		}
	}
	return result;
}

export async function loadProductBranding(agentDir: string): Promise<ProductBranding> {
	try {
		return readBranding(await loadLystarConfig(agentDir));
	} catch {
		return defaultProductBranding();
	}
}

export async function saveProductBranding(
	agentDir: string,
	input: { name: unknown; logo?: unknown },
): Promise<ProductBranding> {
	const config = await updateLystarConfig(agentDir, (currentConfig) => {
		const current = readBranding(currentConfig);
		const name = validName(input.name);
		const logo =
			input.logo === undefined
				? current.logo
				: input.logo === null || input.logo === ""
					? undefined
					: validLogo(input.logo);
		const branding: ProductBranding = { name, ...(logo ? { logo } : {}) };
		return { ...currentConfig, branding };
	});
	return readBranding(config);
}
