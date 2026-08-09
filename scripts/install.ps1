param(
    [string]$Version = "",
    [string]$MinGitArchive = "",
    [string]$WebView2Installer = "",
    [string]$ReleaseArchive = "",
    [string]$ReleaseManifest = "",
    [switch]$Offline,
    [switch]$Rollback,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repository = "__LYSTAR_RELEASE_REPOSITORY__"
$InstallRoot = Join-Path $env:LOCALAPPDATA "LYStarAgent"
$VersionsDir = Join-Path $InstallRoot "versions"
$BinDir = Join-Path $InstallRoot "bin"
$CurrentFile = Join-Path $InstallRoot "current"
$PreviousFile = Join-Path $InstallRoot "previous"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "LYStar Agent 安装器需要 PowerShell 5.1 或更高版本。"
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Format-Megabytes([long]$Bytes) {
    return "{0:0.00} MB" -f ($Bytes / 1MB)
}

function Invoke-Download([string]$Uri, [string]$OutFile, [long]$ExpectedBytes = 0) {
    $Name = Split-Path -Leaf $OutFile
    $SizeHint = if ($ExpectedBytes -gt 0) { "（$(Format-Megabytes $ExpectedBytes)）" } else { "" }
    Write-Host "正在下载 $Name$SizeHint..."
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        try {
            Remove-Item -Force -ErrorAction SilentlyContinue $OutFile
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $Uri -OutFile $OutFile
            $ActualBytes = (Get-Item $OutFile).Length
            if ($ActualBytes -le 0) { throw "下载结果为空。" }
            if ($ExpectedBytes -gt 0 -and $ActualBytes -ne $ExpectedBytes) {
                throw "文件大小不符：预期 $(Format-Megabytes $ExpectedBytes)，实际 $(Format-Megabytes $ActualBytes)。"
            }
            Write-Host "已下载 $Name（$(Format-Megabytes $ActualBytes)）。"
            return
        }
        catch {
            if ($Attempt -eq 3) {
                throw "下载失败：$Uri`n$($_.Exception.Message)"
            }
            Write-Host "下载中断，正在重试（$($Attempt + 1)/3）..."
            Start-Sleep -Seconds $Attempt
        }
    }
}

function Invoke-JsonRequest([string]$Uri, [hashtable]$Headers) {
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        try {
            $Result = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Headers $Headers -Uri $Uri
            return $Result
        }
        catch {
            if ($Attempt -eq 3) {
                throw "请求失败：$Uri`n$($_.Exception.Message)"
            }
            Start-Sleep -Seconds $Attempt
        }
    }
}

function Set-AtomicText([string]$Path, [string]$Value) {
    $Temp = "$Path.next"
    [IO.File]::WriteAllText($Temp, $Value, [Text.UTF8Encoding]::new($false))
    if (Test-Path $Path) {
        [IO.File]::Replace($Temp, $Path, $null)
    }
    else {
        Move-Item $Temp $Path
    }
}

function Send-EnvironmentChanged {
    try {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LYStarEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
        $Result = [UIntPtr]::Zero
        [void][LYStarEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$Result)
    }
    catch {
        Write-Verbose "无法广播 PATH 变化：$($_.Exception.Message)"
    }
}

function Test-WebView2Runtime([string]$TerminalHost) {
    & $TerminalHost --smoke-test
    return $LASTEXITCODE -eq 0
}

function Ensure-WebView2Runtime([string]$TerminalHost, [string]$TempDir) {
    if (Test-WebView2Runtime $TerminalHost) { return }

    $Installer = $WebView2Installer
    if ($Installer) {
        $Installer = [IO.Path]::GetFullPath($Installer)
        if (!(Test-Path $Installer)) { throw "WebView2 离线安装包不存在：$Installer" }
        Write-Host "正在使用 WebView2 离线安装包：$Installer"
    }
    elseif ($Offline) {
        throw "离线模式缺少 -WebView2Installer，且当前系统没有可用的 WebView2 Runtime。"
    }
    else {
        $Installer = Join-Path $TempDir "MicrosoftEdgeWebView2Setup.exe"
        Invoke-Download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" $Installer
    }

    $Process = Start-Process -FilePath $Installer -ArgumentList "/silent", "/install" -Wait -PassThru
    if ($Process.ExitCode -ne 0 -and $Process.ExitCode -ne 3010) {
        throw "WebView2 Runtime 安装失败，退出码：$($Process.ExitCode)。可使用 la --attached 临时运行。"
    }
    if (!(Test-WebView2Runtime $TerminalHost)) {
        throw "WebView2 Runtime 安装后仍不可用。可使用 la --attached 临时运行。"
    }
}

if ($Uninstall) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ -and $_ -ne $BinDir })
    [Environment]::SetEnvironmentVariable("Path", ($Parts -join ";"), "User")
    Send-EnvironmentChanged
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Agent.lnk")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallRoot
    Write-Host "LYStar Agent 已卸载。用户数据仍保留在 ~/.pi/agent。"
    exit 0
}

if ($Rollback) {
    if (!(Test-Path $PreviousFile)) { throw "没有可回退的 LYStar Agent 版本。" }
    $Previous = (Get-Content -Raw $PreviousFile).Trim()
    $Current = if (Test-Path $CurrentFile) { (Get-Content -Raw $CurrentFile).Trim() } else { "" }
    if ($Previous -notmatch '^\d+\.\d+\.\d+-lystar\.\d+$') { throw "previous 版本指针无效。" }
    Set-AtomicText $CurrentFile $Previous
    if ($Current) { Set-AtomicText $PreviousFile $Current }
    Write-Host "已回退到 $Previous。"
    exit 0
}

if ($Repository -eq "__LYSTAR_RELEASE_REPOSITORY__") {
    throw "安装器尚未写入 GitHub repository。请使用 release 构建生成的 install.ps1。"
}
if ($Offline -and (!$ReleaseManifest -or !$ReleaseArchive -or !$MinGitArchive)) {
    throw "离线安装必须同时提供 -ReleaseManifest、-ReleaseArchive 和 -MinGitArchive。"
}

$Headers = @{ "User-Agent" = "LYStar-Agent-Installer" }
$ManifestUrl = if ($Version) {
    "https://github.com/$Repository/releases/download/v$Version/release-manifest.json"
}
else {
    "https://github.com/$Repository/releases/latest/download/release-manifest.json"
}
$Manifest = if ($ReleaseManifest) {
    $ResolvedManifest = [IO.Path]::GetFullPath($ReleaseManifest)
    if (!(Test-Path $ResolvedManifest)) { throw "本地 Release manifest 不存在：$ResolvedManifest" }
    Get-Content -Raw $ResolvedManifest | ConvertFrom-Json
}
else {
    Invoke-JsonRequest $ManifestUrl $Headers
}
if (!$Version) { $Version = [string]$Manifest.version }
if ($Version -notmatch '^\d+\.\d+\.\d+-lystar\.\d+$') { throw "无效版本：$Version" }
if ([string]$Manifest.version -ne $Version) { throw "Release manifest 版本不一致。" }
if ($Manifest.repository -and [string]$Manifest.repository -ne $Repository) {
    throw "Release manifest 仓库不一致。"
}

$Arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    "X64" { "x64" }
    "Arm64" { "arm64" }
    default { throw "当前 Windows 架构暂不支持：$_" }
}
if ($Arch -eq "arm64") { throw "首版暂未提供 Windows ARM64 发行包。" }

$Asset = "lystar-agent-v$Version-windows-x64.zip"
$AssetInfo = $Manifest.assets."windows-x64"
if (!$AssetInfo -or [string]$AssetInfo.file -ne $Asset) { throw "Release manifest 中缺少 $Asset。" }
$ExpectedAssetBytes = [long]$AssetInfo.size
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("lystar-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $Temp | Out-Null

try {
    $Archive = Join-Path $Temp $Asset
    $Sums = Join-Path $Temp "SHA256SUMS"
    Write-Host "正在安装 LYStar Agent $Version (windows-x64)..."
    if ($ReleaseArchive) {
        $ResolvedArchive = [IO.Path]::GetFullPath($ReleaseArchive)
        if (!(Test-Path $ResolvedArchive)) { throw "本地 Release archive 不存在：$ResolvedArchive" }
        Copy-Item $ResolvedArchive $Archive
        if ($ExpectedAssetBytes -gt 0 -and (Get-Item $Archive).Length -ne $ExpectedAssetBytes) {
            throw "本地 Release archive 文件大小不符。"
        }
    }
    else {
        Invoke-Download "$BaseUrl/$Asset" $Archive $ExpectedAssetBytes
    }

    $Expected = [string]$AssetInfo.sha256
    if (!$Expected) {
        Invoke-Download "$BaseUrl/SHA256SUMS" $Sums
        $Pattern = "^([0-9a-fA-F]{64})\s+\*?" + [Regex]::Escape($Asset) + '$'
        $Match = Get-Content $Sums | Select-String -Pattern $Pattern | Select-Object -First 1
        if (!$Match) { throw "SHA256SUMS 中缺少 $Asset。" }
        $Expected = $Match.Matches[0].Groups[1].Value
    }
    $Expected = $Expected.ToLowerInvariant()
    $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw "SHA-256 校验失败。" }

    $Extract = Join-Path $Temp "extract"
    Expand-Archive -Path $Archive -DestinationPath $Extract
    $Bundle = Join-Path $Extract "lystar-agent"
    $Executable = Join-Path $Bundle "la.exe"
    $TerminalHost = Join-Path $Bundle "lystar-terminal.exe"
    if (!(Test-Path $Executable)) { throw "发行包缺少 la.exe。" }
    if (!(Test-Path $TerminalHost)) { throw "发行包缺少 lystar-terminal.exe。" }
    Ensure-WebView2Runtime $TerminalHost $Temp
    $CandidateVersion = (& $Executable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $CandidateVersion -ne $Version) {
        throw "候选 la.exe 版本校验失败：预期 $Version，实际 $CandidateVersion。"
    }
    Write-Host "正在检查 LYStar 托管的 MinGit Bash..."
    $MinGitArgs = @("--ensure-windows-bash")
    if ($MinGitArchive) {
        $ResolvedMinGitArchive = [IO.Path]::GetFullPath($MinGitArchive)
        if (!(Test-Path $ResolvedMinGitArchive)) { throw "MinGit 离线安装包不存在：$ResolvedMinGitArchive" }
        $MinGitArgs += @("--archive", $ResolvedMinGitArchive, "--offline")
    }
    & $Executable @MinGitArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "MinGit Bash 自动安装失败，LYStar 版本未切换。" }

    New-Item -ItemType Directory -Force $VersionsDir, $BinDir | Out-Null
    $Target = Join-Path $VersionsDir $Version
    if (!(Test-Path $Target)) { Move-Item $Bundle $Target }

    $Current = if (Test-Path $CurrentFile) { (Get-Content -Raw $CurrentFile).Trim() } else { "" }
    if ($Current -and $Current -ne $Version) { Set-AtomicText $PreviousFile $Current }
    Set-AtomicText $CurrentFile $Version

    $Launcher = @'
@echo off
set /p LYSTAR_VERSION=<"%~dp0..\current"
"%~dp0..\versions\%LYSTAR_VERSION%\la.exe" %*
'@
    [IO.File]::WriteAllText((Join-Path $BinDir "la.cmd"), $Launcher, [Text.UTF8Encoding]::new($false))

    $StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Agent.lnk"
    New-Item -ItemType Directory -Force (Split-Path -Parent $StartMenuShortcut) | Out-Null
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuShortcut)
    $Shortcut.TargetPath = Join-Path $BinDir "la.cmd"
    $Shortcut.WorkingDirectory = [Environment]::GetFolderPath("UserProfile")
    $Shortcut.IconLocation = "$(Join-Path $Target 'lystar-terminal.exe'),0"
    $Shortcut.Description = "LYStar Agent"
    $Shortcut.Save()

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ })
    if ($Parts -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable("Path", (($Parts + $BinDir) -join ";"), "User")
        Send-EnvironmentChanged
        Write-Host "已把 $BinDir 加入用户 PATH。"
    }
    $env:Path = "$BinDir;$env:Path"
    $InstalledVersion = (& (Join-Path $BinDir "la.cmd") --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne $Version) {
        throw "安装后的 la 版本校验失败：预期 $Version，实际 $InstalledVersion。"
    }

    Write-Host "LYStar Agent $Version 已安装到 $Target。"
    Write-Host "新开的终端可直接运行 la；首次使用请执行 /login。"
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
