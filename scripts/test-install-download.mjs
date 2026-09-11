import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const powershell = process.env.LYSTAR_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
const available = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;
const source = fileURLToPath(new URL("./install.ps1", import.meta.url));
const script = `
$ErrorActionPreference = 'Stop'
$Tokens = $null
$Errors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER_SOURCE, [ref]$Tokens, [ref]$Errors)
if ($Errors.Count -gt 0) { throw 'Installer parse failed' }
$Names = @('Format-Megabytes', 'Format-TransferRate', 'Write-InstallerInfo', 'Write-InstallerSuccess', 'Write-InstallerWarning', 'Invoke-Download')
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Names -contains $Node.Name }, $true)) {
    Invoke-Expression $Function.Extent.Text
}
Invoke-Download $env:TEST_DOWNLOAD_URL $env:TEST_DOWNLOAD_OUTPUT 4096
`;

for (const scenario of ["success", "retry", "bad-size"]) {
	test(`PowerShell installer streaming download: ${scenario}`, { skip: !available, timeout: 30_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "lystar-download-test-"));
		const path = join(root, "download.ps1");
		const output = join(root, "payload.bin");
		const payload = Buffer.alloc(4096, 42);
		let attempts = 0;
		const server = createServer((_request, response) => {
			attempts++;
			const body = scenario === "bad-size" || (scenario === "retry" && attempts === 1) ? payload.subarray(0, 1) : payload;
			response.writeHead(200, { "Content-Length": body.length });
			response.end(body);
		});
		try {
			await writeFile(path, `\uFEFF${script}`);
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			assert.ok(address && typeof address !== "string");
			const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], {
				env: { ...process.env, INSTALLER_SOURCE: source, TEST_DOWNLOAD_URL: `http://127.0.0.1:${address.port}/`, TEST_DOWNLOAD_OUTPUT: output },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let log = "";
			child.stdout.on("data", (data) => { log += data; });
			child.stderr.on("data", (data) => { log += data; });
			const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
			assert.equal(code, scenario === "bad-size" ? 1 : 0, log);
			assert.equal(attempts, scenario === "success" ? 1 : scenario === "retry" ? 2 : 3);
			if (scenario !== "bad-size") assert.deepEqual(await readFile(output), payload);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		}
	});
}
