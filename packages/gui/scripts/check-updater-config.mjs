import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(guiDir, "src-tauri");
const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const cargo = readFileSync(join(tauriDir, "Cargo.toml"), "utf8");
const capability = JSON.parse(readFileSync(join(tauriDir, "capabilities/default.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(guiDir, "package.json"), "utf8"));
const codingAgentPackage = JSON.parse(
	readFileSync(join(guiDir, "../coding-agent/package.json"), "utf8"),
);
const publicKeyPath = join(tauriDir, "updater.pub");
const updaterConfig = config.plugins?.updater;
const updaterPermissions = capability.permissions.filter(
	(permission) => typeof permission === "string" && permission.startsWith("updater:"),
);
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
const cargoRepository = cargo.match(/^repository = "([^"]+)"$/m)?.[1];
const expectedRepository = `https://github.com/${codingAgentPackage.piConfig.releaseRepository}`;

if (config.version !== packageJson.version) throw new Error("tauri.conf.json version 必须与 GUI package version 一致");
if (cargoVersion !== packageJson.version) throw new Error("Cargo.toml version 必须与 GUI package version 一致");
if (cargoRepository !== expectedRepository) throw new Error("Cargo.toml repository 必须与发行仓库一致");

if (!existsSync(publicKeyPath)) {
	if (config.bundle?.createUpdaterArtifacts !== false) throw new Error("缺少 updater.pub 时必须关闭 updater 产物");
	if (updaterConfig) throw new Error("缺少 updater.pub 时不得配置 updater endpoint 或公钥");
	if (cargo.includes("tauri-plugin-updater")) throw new Error("缺少 updater.pub 时不得注册 Rust updater 插件");
	if (updaterPermissions.length > 0) throw new Error("缺少 updater.pub 时不得授予 updater capability");
	console.log("Tauri updater disabled: src-tauri/updater.pub is not configured");
	process.exit(0);
}

const publicKey = readFileSync(publicKeyPath, "utf8").trim();
if (!publicKey) throw new Error("updater.pub 不能为空");
if (config.bundle?.createUpdaterArtifacts !== true) throw new Error("配置 updater.pub 后必须生成签名更新产物");
if (updaterConfig?.pubkey !== publicKey) throw new Error("tauri.conf.json updater.pubkey 必须与 updater.pub 一致");
if (!Array.isArray(updaterConfig.endpoints) || updaterConfig.endpoints.length === 0) {
	throw new Error("配置 updater.pub 后必须提供固定 updater endpoint");
}
for (const endpoint of updaterConfig.endpoints) {
	if (new URL(endpoint).protocol !== "https:") throw new Error(`updater endpoint 必须使用 HTTPS: ${endpoint}`);
}
if (!cargo.includes("tauri-plugin-updater")) throw new Error("配置 updater.pub 后必须注册 Rust updater 插件");
if (!packageJson.dependencies?.["@tauri-apps/plugin-updater"]) {
	throw new Error("配置 updater.pub 后必须安装前端 updater 插件");
}
if (!updaterPermissions.includes("updater:default")) throw new Error("配置 updater.pub 后必须授予 updater:default");
console.log("Tauri updater signature configuration is complete");
