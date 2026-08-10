param(
    [string]$OutputDir = "packages\coding-agent\binaries",
    [string]$Repository = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$OutputDir = if ([IO.Path]::IsPathRooted($OutputDir)) { [IO.Path]::GetFullPath($OutputDir) } else { [IO.Path]::GetFullPath((Join-Path $Root $OutputDir)) }
$PackageDir = Join-Path $Root "packages\coding-agent"
$PackageJson = Get-Content -Raw (Join-Path $PackageDir "package.json") | ConvertFrom-Json
$Version = if ($PackageJson.piConfig.productVersion) { [string]$PackageJson.piConfig.productVersion } else { [string]$PackageJson.version }
$ConfiguredRepository = [string]$PackageJson.piConfig.releaseRepository
if (!$Repository) { $Repository = $ConfiguredRepository }
if ($ConfiguredRepository -and $Repository -ne $ConfiguredRepository) { throw "Repository mismatch: configured $ConfiguredRepository, received $Repository" }

$PlatformDir = Join-Path $OutputDir "windows-x64"
$BundleDir = Join-Path $PlatformDir "lystar-agent"
$ClipboardVersion = [string]$PackageJson.optionalDependencies.'@mariozechner/clipboard'
$ReleaseDeps = Join-Path ([IO.Path]::GetTempPath()) ("lystar-release-deps-" + [Guid]::NewGuid())
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $PlatformDir
New-Item -ItemType Directory -Force $BundleDir, $ReleaseDeps | Out-Null

try {
    Push-Location $Root
    # Windows CI 安装 baseline Bun；原生编译直接复用当前 runtime，避免再次下载 target executable。
    & bun build --compile --no-compile-autoload-bunfig --windows-icon=packages/coding-agent/assets/lystar-windows-icon.ico packages/coding-agent/dist/bun/cli.js packages/coding-agent/src/utils/image-resize-worker.ts --outfile (Join-Path $BundleDir "lc.exe")
    if ($LASTEXITCODE -ne 0) { throw "lc.exe 构建失败。" }

    $BundleAlias = @'
@echo off
"%~dp0lc.exe" %*
'@
    [IO.File]::WriteAllText((Join-Path $BundleDir "lystar.cmd"), $BundleAlias, [Text.UTF8Encoding]::new($false))

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\build-windows-terminal.ps1") -OutputDir $BundleDir
    if ($LASTEXITCODE -ne 0) { throw "lystar-terminal.exe 构建失败。" }

    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $Npm install --prefix $ReleaseDeps --include=optional --no-save --package-lock=false --force --ignore-scripts "@mariozechner/clipboard@$ClipboardVersion" "@mariozechner/clipboard-win32-x64-msvc@$ClipboardVersion"
    if ($LASTEXITCODE -ne 0) { throw "Windows clipboard binding 准备失败。" }

    Copy-Item (Join-Path $PackageDir "package.json") $BundleDir
    & node (Join-Path $Root "scripts\prepare-release-package.mjs") (Join-Path $BundleDir "package.json") $Version $Repository
    Copy-Item (Join-Path $PackageDir "README.md"), (Join-Path $PackageDir "CHANGELOG.md"), (Join-Path $Root "LICENSE"), (Join-Path $Root "THIRD_PARTY_LICENSES.md") $BundleDir
    Copy-Item (Join-Path $Root "node_modules\@silvia-odwyer\photon-node\photon_rs_bg.wasm") $BundleDir
    Copy-Item -Recurse (Join-Path $PackageDir "docs"), (Join-Path $PackageDir "examples") $BundleDir

    New-Item -ItemType Directory -Force (Join-Path $BundleDir "theme"), (Join-Path $BundleDir "assets"), (Join-Path $BundleDir "terminal"), (Join-Path $BundleDir "node_modules\@mariozechner\clipboard"), (Join-Path $BundleDir "node_modules\@mariozechner\clipboard-win32-x64-msvc"), (Join-Path $BundleDir "native\win32\prebuilds\win32-x64") | Out-Null
    Copy-Item (Join-Path $PackageDir "dist\modes\interactive\theme\*.json") (Join-Path $BundleDir "theme")
    Copy-Item (Join-Path $PackageDir "dist\modes\interactive\assets\*") (Join-Path $BundleDir "assets")
    Copy-Item -Recurse (Join-Path $PackageDir "dist\core\export-html") $BundleDir
    Copy-Item -Recurse (Join-Path $PackageDir "dist\skills") $BundleDir
    Copy-Item (Join-Path $PackageDir "assets\lystar-windows-icon.png"), (Join-Path $PackageDir "assets\lystar-windows-icon.ico") (Join-Path $BundleDir "assets")

    $TerminalSource = Join-Path $PackageDir "src\windows-terminal-host\terminal"
    Copy-Item (Join-Path $TerminalSource "index.html"), (Join-Path $TerminalSource "terminal.css"), (Join-Path $TerminalSource "terminal.js"), (Join-Path $TerminalSource "NotoSansCJK-Regular.ttc"), (Join-Path $TerminalSource "NotoSansCJK-LICENSE.txt") (Join-Path $BundleDir "terminal")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\lib\xterm.js") (Join-Path $BundleDir "terminal\xterm.js")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\css\xterm.css") (Join-Path $BundleDir "terminal\xterm.css")
    Copy-Item (Join-Path $Root "node_modules\@xterm\addon-fit\lib\addon-fit.js") (Join-Path $BundleDir "terminal\addon-fit.js")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\LICENSE") (Join-Path $BundleDir "terminal\XTERM-LICENSE.txt")
    Copy-Item (Join-Path $Root "node_modules\@xterm\addon-fit\LICENSE") (Join-Path $BundleDir "terminal\XTERM-ADDON-FIT-LICENSE.txt")

    $ClipboardRoot = Join-Path $ReleaseDeps "node_modules\@mariozechner"
    Copy-Item -Recurse (Join-Path $ClipboardRoot "clipboard\*") (Join-Path $BundleDir "node_modules\@mariozechner\clipboard")
    Copy-Item -Recurse (Join-Path $ClipboardRoot "clipboard-win32-x64-msvc\*") (Join-Path $BundleDir "node_modules\@mariozechner\clipboard-win32-x64-msvc")
    Copy-Item (Join-Path $ClipboardRoot "clipboard-win32-x64-msvc\clipboard.win32-x64-msvc.node") (Join-Path $BundleDir "node_modules\@mariozechner\clipboard")
    Copy-Item (Join-Path $Root "packages\tui\native\win32\prebuilds\win32-x64\win32-console-mode.node") (Join-Path $BundleDir "native\win32\prebuilds\win32-x64")

    $Archive = Join-Path $OutputDir "lystar-agent-v$Version-windows-x64.zip"
    Remove-Item -Force -ErrorAction SilentlyContinue $Archive
    Compress-Archive -Path $BundleDir -DestinationPath $Archive -CompressionLevel Optimal
    Write-Host "Windows release built: $Archive"
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ReleaseDeps
}