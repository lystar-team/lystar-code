param(
    [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force $OutputDir | Out-Null
$StageTimer = [Diagnostics.Stopwatch]::StartNew()
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\build-windows-terminal.ps1") -OutputDir $OutputDir
if ($LASTEXITCODE -ne 0) { throw "lystar-terminal.exe 构建失败。" }
Write-Host ("CI_TIMING terminal-total {0:N2}s" -f $StageTimer.Elapsed.TotalSeconds)
$StageTimer.Restart()

$ServiceSource = Join-Path $Root "packages\coding-agent\src\windows-service-host\service.cpp"
$ServiceExecutable = Join-Path $OutputDir "lystar-web-service.exe"
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (!(Test-Path $VsWhere)) { throw "找不到 Visual Studio Build Tools。" }
$VsPath = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$VsPath) { throw "找不到 MSVC x64 工具链。" }
$VcVars = Join-Path $VsPath "VC\Auxiliary\Build\vcvars64.bat"
$ServiceCommand = @"
@echo off
@chcp 65001 >nul
call "$VcVars" >nul
cl.exe /nologo /std:c++20 /EHsc /utf-8 /O2 /GL /MT /DUNICODE /D_UNICODE "$ServiceSource" /link /LTCG /SUBSYSTEM:CONSOLE /OUT:"$ServiceExecutable" advapi32.lib
"@
$ServiceCommandPath = Join-Path ([IO.Path]::GetTempPath()) ("lystar-web-service-build-" + [Guid]::NewGuid() + ".cmd")
[IO.File]::WriteAllText($ServiceCommandPath, $ServiceCommand, [Text.UTF8Encoding]::new($true))
try {
    & cmd.exe /d /c $ServiceCommandPath
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $ServiceExecutable)) { throw "lystar-web-service.exe 构建失败。" }
}
finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $ServiceCommandPath
}
Write-Host ("CI_TIMING service-compile {0:N2}s" -f $StageTimer.Elapsed.TotalSeconds)
