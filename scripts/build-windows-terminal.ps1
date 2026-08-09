param(
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [string]$WebView2Version = "1.0.4078.44",
    [string]$WebView2Sha256 = "dc4d1d9168df26b830398303e50210b6e1729f6ce5a7ac69d2c766852f489962"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$SourceDir = Join-Path $Root "packages\coding-agent\src\windows-terminal-host"
$Icon = Join-Path $Root "packages\coding-agent\assets\lystar-windows-icon.ico"
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("lystar-terminal-build-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $Temp, $OutputDir | Out-Null

try {
    $Package = Join-Path $Temp "Microsoft.Web.WebView2.nupkg"
    $PackageZip = Join-Path $Temp "Microsoft.Web.WebView2.zip"
    $PackageDir = Join-Path $Temp "webview2"
    $Uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$($WebView2Version.ToLowerInvariant())/microsoft.web.webview2.$($WebView2Version.ToLowerInvariant()).nupkg"
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Package
    $ActualSha256 = (Get-FileHash -Algorithm SHA256 $Package).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $WebView2Sha256) { throw "WebView2 SDK SHA-256 校验失败：$ActualSha256" }
    Copy-Item $Package $PackageZip
    Expand-Archive -Path $PackageZip -DestinationPath $PackageDir

    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (!(Test-Path $VsWhere)) { throw "找不到 Visual Studio Build Tools。" }
    $VsPath = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$VsPath) { throw "找不到 MSVC x64 工具链。" }
    $VcVars = Join-Path $VsPath "VC\Auxiliary\Build\vcvars64.bat"
    $Include = Join-Path $PackageDir "build\native\include"
    $Loader = Join-Path $PackageDir "build\native\x64\WebView2LoaderStatic.lib"
    $Resource = Join-Path $Temp "lystar-terminal.res"
    $Executable = Join-Path $OutputDir "lystar-terminal.exe"

    $ResourceScript = Join-Path $SourceDir "resource.rc"
    $HostSource = Join-Path $SourceDir "host.cpp"
    $Command = @"
@echo off
@chcp 65001 >nul
call "$VcVars" >nul
cd /d "$SourceDir"
rc.exe /nologo /fo "$Resource" "$ResourceScript"
cl.exe /nologo /std:c++20 /EHsc /utf-8 /O2 /GL /MT /DUNICODE /D_UNICODE /I "$Include" "$HostSource" "$Resource" /link /LTCG /SUBSYSTEM:WINDOWS /OUT:"$Executable" "$Loader" user32.lib gdi32.lib shell32.lib ole32.lib oleaut32.lib advapi32.lib version.lib runtimeobject.lib windowsapp.lib
"@
    $CommandPath = Join-Path $Temp "build-terminal.cmd"
    [IO.File]::WriteAllText($CommandPath, $Command, [Text.UTF8Encoding]::new($true))
    & cmd.exe /d /c $CommandPath
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $Executable)) { throw "lystar-terminal.exe 构建失败。" }
    $WebViewLicense = Get-ChildItem -Path $PackageDir -Filter "LICENSE*" -File | Select-Object -First 1
    if ($WebViewLicense) { Copy-Item $WebViewLicense.FullName (Join-Path $OutputDir "WebView2-LICENSE.txt") }
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}