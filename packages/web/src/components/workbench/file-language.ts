export function languageForPath(path: string): string {
	const fileName = path.split(/[?#]/u)[0]?.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase() ?? "";
	if (fileName === "dockerfile") return "docker";
	if (fileName === "makefile") return "make";
	const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
	const languages: Record<string, string> = {
		bash: "shellscript",
		bat: "bat",
		c: "c",
		cc: "cpp",
		cpp: "cpp",
		cs: "csharp",
		css: "css",
		cxx: "cpp",
		dart: "dart",
		go: "go",
		gql: "graphql",
		graphql: "graphql",
		h: "c",
		hcl: "hcl",
		hpp: "cpp",
		htm: "html",
		html: "html",
		ini: "ini",
		java: "java",
		js: "javascript",
		json: "json",
		jsonc: "json",
		jsx: "jsx",
		kt: "kotlin",
		kts: "kotlin",
		less: "less",
		md: "markdown",
		markdown: "markdown",
		mdx: "mdx",
		mjs: "javascript",
		mts: "typescript",
		php: "php",
		pl: "perl",
		ps1: "powershell",
		py: "python",
		rb: "ruby",
		rs: "rust",
		sass: "scss",
		scss: "scss",
		sh: "shellscript",
		sql: "sql",
		swift: "swift",
		ts: "typescript",
		tsx: "tsx",
		toml: "toml",
		vue: "vue",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
		zsh: "shellscript",
	};
	return languages[extension] ?? "text";
}

export function monacoLanguageForPath(path: string): string {
	const language = languageForPath(path);
	switch (language) {
		case "c":
			return "cpp";
		case "docker":
			return "dockerfile";
		case "jsx":
			return "javascript";
		case "tsx":
			return "typescript";
		case "make":
		case "shellscript":
			return "shell";
		case "toml":
			return "ini";
		case "vue":
			return "html";
		default:
			return language;
	}
}
