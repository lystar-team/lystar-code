import { statSync } from "node:fs";
import { win32 } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function candidateNames(executable: string, env: NodeJS.ProcessEnv): string[] {
	const extensions = (environmentValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean);
	if (extensions.some((extension) => executable.toLowerCase().endsWith(extension.toLowerCase()))) {
		return [executable];
	}
	return [executable, ...extensions.map((extension) => executable + extension)];
}

/**
 * Resolve an executable through PATH without parsing `where.exe` output.
 * `where.exe` writes the console code page, so decoding a pipe as UTF-8 mangles
 * every path that contains non-ASCII characters, such as a Chinese user
 * profile. The direct lookup keeps the original Windows characters intact.
 */
export function findExecutableOnWindowsPath(
	executable: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const pathValue = environmentValue(env, "PATH");
	if (!pathValue) return undefined;
	const candidates =
		executable.includes("\\") || executable.includes("/") || win32.isAbsolute(executable)
			? [executable]
			: candidateNames(executable, env);
	for (const entry of pathValue.split(win32.delimiter)) {
		const directory = entry.trim().replace(/^"|"$/gu, "");
		if (!directory) continue;
		for (const candidate of candidates) {
			const fullPath = win32.join(directory, candidate);
			if (isFile(fullPath)) return fullPath;
		}
	}
	return undefined;
}
