param(
    [string]$OutputDir = "packages\coding-agent\binaries",
    [string]$Repository = "",
    [string]$NativeHostsDir = ""
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
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $PlatformDir
New-Item -ItemType Directory -Force $BundleDir | Out-Null

try {
    Push-Location $Root
    $StageTimer = [Diagnostics.Stopwatch]::StartNew()
    # Windows CI 安装 baseline Bun；原生编译直接复用当前 runtime，避免再次下载 target executable。
    # 使用无源码路径别名的配置，避免 dist 入口再次导入 src 并产生两份运行时状态。
    Push-Location $PackageDir
    try {
        & bun "$Root\scripts\build-coding-agent-binary.mjs" current (Join-Path $BundleDir "lc.exe")
        if ($LASTEXITCODE -ne 0) { throw "lc.exe 构建失败。" }
    }
    finally {
        Pop-Location
    }
    Write-Host ("CI_TIMING bun-compile {0:N2}s" -f $StageTimer.Elapsed.TotalSeconds)
    $StageTimer.Restart()

    $BundleAlias = @'
@echo off
"%~dp0lc.exe" %*
'@
    [IO.File]::WriteAllText((Join-Path $BundleDir "lystar.cmd"), $BundleAlias, [Text.UTF8Encoding]::new($false))

    if ($NativeHostsDir) {
        Copy-Item (Join-Path $NativeHostsDir "lystar-terminal.exe"), (Join-Path $NativeHostsDir "lystar-web-service.exe") $BundleDir
        $WebViewLicense = Join-Path $NativeHostsDir "WebView2-LICENSE.txt"
        if (Test-Path $WebViewLicense) { Copy-Item $WebViewLicense $BundleDir }
    }
    else {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\build-windows-hosts.ps1") -OutputDir $BundleDir
        if ($LASTEXITCODE -ne 0) { throw "Windows 原生宿主构建失败。" }
    }
    $StageTimer.Restart()
    Copy-Item (Join-Path $PackageDir "package.json") $BundleDir
    & node (Join-Path $Root "scripts\prepare-release-package.mjs") (Join-Path $BundleDir "package.json") $Version $Repository
    Copy-Item (Join-Path $PackageDir "README.md"), (Join-Path $PackageDir "CHANGELOG.md"), (Join-Path $Root "LICENSE"), (Join-Path $Root "THIRD_PARTY_LICENSES.md") $BundleDir
    Copy-Item (Join-Path $Root "node_modules\@silvia-odwyer\photon-node\photon_rs_bg.wasm") $BundleDir
    Copy-Item -Recurse (Join-Path $PackageDir "docs"), (Join-Path $PackageDir "examples") $BundleDir

    New-Item -ItemType Directory -Force (Join-Path $BundleDir "theme"), (Join-Path $BundleDir "assets"), (Join-Path $BundleDir "terminal"), (Join-Path $BundleDir "web"), (Join-Path $BundleDir "native\win32\prebuilds\win32-x64") | Out-Null
    Copy-Item (Join-Path $PackageDir "dist\modes\interactive\theme\*.json") (Join-Path $BundleDir "theme")
    Copy-Item (Join-Path $PackageDir "dist\modes\interactive\assets\*") (Join-Path $BundleDir "assets")
    Copy-Item -Recurse (Join-Path $PackageDir "dist\core\export-html") $BundleDir
    Copy-Item -Recurse (Join-Path $PackageDir "dist\skills") $BundleDir
    Copy-Item (Join-Path $PackageDir "assets\lystar-windows-icon.png"), (Join-Path $PackageDir "assets\lystar-windows-icon.ico") (Join-Path $BundleDir "assets")
    Copy-Item -Recurse (Join-Path $Root "packages\web\dist\*") (Join-Path $BundleDir "web")

    $TerminalSource = Join-Path $PackageDir "src\windows-terminal-host\terminal"
    Copy-Item (Join-Path $TerminalSource "index.html"), (Join-Path $TerminalSource "terminal.css"), (Join-Path $TerminalSource "terminal.js"), (Join-Path $TerminalSource "NotoSansCJK-Regular.ttc"), (Join-Path $TerminalSource "NotoSansCJK-LICENSE.txt") (Join-Path $BundleDir "terminal")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\lib\xterm.js") (Join-Path $BundleDir "terminal\xterm.js")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\css\xterm.css") (Join-Path $BundleDir "terminal\xterm.css")
    Copy-Item (Join-Path $Root "node_modules\@xterm\addon-fit\lib\addon-fit.js") (Join-Path $BundleDir "terminal\addon-fit.js")
    Copy-Item (Join-Path $Root "node_modules\@xterm\xterm\LICENSE") (Join-Path $BundleDir "terminal\XTERM-LICENSE.txt")
    Copy-Item (Join-Path $Root "node_modules\@xterm\addon-fit\LICENSE") (Join-Path $BundleDir "terminal\XTERM-ADDON-FIT-LICENSE.txt")

    Copy-Item -Recurse (Join-Path $Root "packages\tui\native\win32\prebuilds\win32-x64\*") (Join-Path $BundleDir "native\win32\prebuilds\win32-x64")
    New-Item -ItemType Directory -Force (Join-Path $BundleDir "native\session-index") | Out-Null
    Copy-Item -Recurse (Join-Path $PackageDir "dist\native\session-index\win32-x64") (Join-Path $BundleDir "native\session-index")

    foreach ($RequiredFile in @("lc.exe", "lystar-web-service.exe", "package.json", "photon_rs_bg.wasm", "web\index.html", "web\version.json", "web\brand\lystar-mark-dark.webp", "web\brand\models\openai.svg", "web\brand\providers\openai.svg", "skills\imagegen\SKILL.md", "native\session-index\win32-x64\lystar-session-index.exe")) {
        if (!(Test-Path (Join-Path $BundleDir $RequiredFile))) { throw "Windows release bundle is missing $RequiredFile." }
    }
    foreach ($RequiredDirectory in @("web\assets", "web\brand", "web\brand\models", "web\brand\providers")) {
        $DirectoryPath = Join-Path $BundleDir $RequiredDirectory
        if (!(Test-Path -LiteralPath $DirectoryPath -PathType Container)) { throw "Windows release bundle is missing directory $RequiredDirectory." }
        if (!(Get-ChildItem -LiteralPath $DirectoryPath -File -Recurse | Select-Object -First 1)) { throw "Windows release bundle directory is empty: $RequiredDirectory." }
    }

    Write-Host ("CI_TIMING copy-assets {0:N2}s" -f $StageTimer.Elapsed.TotalSeconds)
    $StageTimer.Restart()
    $Archive = Join-Path $OutputDir "lystar-agent-v$Version-windows-x64.zip"
    Remove-Item -Force -ErrorAction SilentlyContinue $Archive
    Compress-Archive -Path $BundleDir -DestinationPath $Archive -CompressionLevel Optimal
    Write-Host ("CI_TIMING zip-compress {0:N2}s" -f $StageTimer.Elapsed.TotalSeconds)
    Write-Host "Windows release built: $Archive"
}
finally {
    Pop-Location
}