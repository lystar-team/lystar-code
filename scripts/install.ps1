param(
    [string]$Version = "",
    [string]$MinGitArchive = "",
    [string]$WebView2Installer = "",
    [string]$ReleaseArchive = "",
    [string]$ReleaseManifest = "",
    [switch]$Offline,
    [switch]$Rollback,
    [switch]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
$ActivatedVersion = ""
Remove-Item Env:LYSTAR_WEB_SERVICE_VERSION -ErrorAction SilentlyContinue
$Repository = "__LYSTAR_RELEASE_REPOSITORY__"
$InstallRoot = Join-Path $env:LOCALAPPDATA "LYStarAgent"
$VersionsDir = Join-Path $InstallRoot "versions"
$BinDir = Join-Path $InstallRoot "bin"
$CurrentFile = Join-Path $InstallRoot "current"
$PreviousFile = Join-Path $InstallRoot "previous"
$WebAgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$CurrentVersion = "未安装"
if (Test-Path $CurrentFile) {
    $CurrentVersion = (Get-Content -Raw $CurrentFile).Trim()
    if (!$CurrentVersion) { $CurrentVersion = "未安装" }
}

function Write-InstallerBanner([string]$Title = "LYStar Code Windows 安装器") {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
}

function Write-InstallerStep([int]$Number, [int]$Total, [string]$Message) {
    Write-Host ""
    Write-Host "[$Number/$Total] $Message" -ForegroundColor Cyan
}

function Write-InstallerInfo([string]$Message) {
    Write-Host "  $Message"
}

function Write-InstallerSuccess([string]$Message) {
    Write-Host "  [完成] $Message" -ForegroundColor Green
}

function Write-InstallerWarning([string]$Message) {
    Write-Host "  [提示] $Message" -ForegroundColor Yellow
}

trap {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  操作没有完成" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  原因：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    if ($ActivatedVersion) {
        Write-InstallerWarning "当前应用版本为 ${ActivatedVersion}；操作未完成，请处理错误后重试。"
    }
    else {
        Write-InstallerWarning "当前版本没有切换，已有安装仍可使用。"
    }
    Write-InstallerInfo "可以根据上面的原因处理后重新运行安装器。"
    exit 1
}

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host ""
    Write-Host "[失败] 当前 Windows PowerShell 版本过低。" -ForegroundColor Red
    Write-Host "请安装 Windows PowerShell 5.1 或更高版本后重试。" -ForegroundColor Red
    exit 1
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Format-Megabytes([long]$Bytes) {
    return "{0:0.00} MB" -f ($Bytes / 1MB)
}

function Format-TransferRate([double]$BytesPerSecond) {
    if ($BytesPerSecond -lt 1KB) { return "{0:0} B/s" -f $BytesPerSecond }
    if ($BytesPerSecond -lt 1MB) { return "{0:0.00} KB/s" -f ($BytesPerSecond / 1KB) }
    return "{0:0.00} MB/s" -f ($BytesPerSecond / 1MB)
}

if ($Help) {
    Write-InstallerBanner "LYStar Code 安装器帮助"
    Write-Host "用法："
    Write-Host "  install.ps1                         安装最新版本"
    Write-Host "  install.ps1 -Version <版本号>        安装指定版本"
    Write-Host "  install.ps1 -Rollback               回退到上一个版本"
    Write-Host "  install.ps1 -Uninstall              卸载 LYStar Code"
    Write-Host "  install.ps1 -Offline ...            使用本地文件完成离线安装"
    Write-Host ""
    Write-Host "离线安装还需要提供 -ReleaseManifest、-ReleaseArchive 和 -MinGitArchive。"
    exit 0
}

function Invoke-Download([string]$Uri, [string]$OutFile, [long]$ExpectedBytes = 0) {
    $Name = Split-Path -Leaf $OutFile
    $SizeHint = if ($ExpectedBytes -gt 0) { "（$(Format-Megabytes $ExpectedBytes)）" } else { "" }
    Write-InstallerInfo "正在下载 $Name$SizeHint（进度条包含实时速度）……"
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        $Client = $null
        $Response = $null
        $ResponseStream = $null
        $FileStream = $null
        $ReadTimeout = $null
        try {
            Remove-Item -Force -ErrorAction SilentlyContinue $OutFile
            Add-Type -AssemblyName System.Net.Http
            $Client = New-Object System.Net.Http.HttpClient
            $Client.Timeout = [TimeSpan]::FromSeconds(60)
            $Client.DefaultRequestHeaders.UserAgent.ParseAdd("LYStar-Code-Installer")
            $Response = $Client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            [void]$Response.EnsureSuccessStatusCode()
            $ResponseStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $FileStream = New-Object System.IO.FileStream($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 81920, $false)
            $Buffer = New-Object byte[] 81920
            $TotalBytes = 0L
            $ContentLength = if ($ExpectedBytes -gt 0) { $ExpectedBytes } elseif ($Response.Content.Headers.ContentLength) { [long]$Response.Content.Headers.ContentLength } else { 0L }
            $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
            $LastProgress = -1000L
            $ReadTimeout = New-Object System.Threading.CancellationTokenSource
            while ($true) {
                $ReadTimeout.CancelAfter(60000)
                $Read = $ResponseStream.ReadAsync($Buffer, 0, $Buffer.Length, $ReadTimeout.Token).GetAwaiter().GetResult()
                if ($Read -eq 0) { break }
                $FileStream.Write($Buffer, 0, $Read)
                $TotalBytes += $Read
                if ($Stopwatch.ElapsedMilliseconds -ge ($LastProgress + 100)) {
                    $ElapsedSeconds = [Math]::Max($Stopwatch.Elapsed.TotalSeconds, 0.001)
                    $Rate = $TotalBytes / $ElapsedSeconds
                    $Percent = if ($ContentLength -gt 0) { [Math]::Min(100, [Math]::Floor($TotalBytes * 100 / $ContentLength)) } else { 0 }
                    $Status = if ($ContentLength -gt 0) {
                        "{0:0.00} / {1:0.00} MB | {2}" -f ($TotalBytes / 1MB), ($ContentLength / 1MB), (Format-TransferRate $Rate)
                    }
                    else {
                        "{0:0.00} MB | {1}" -f ($TotalBytes / 1MB), (Format-TransferRate $Rate)
                    }
                    Write-Progress -Activity "下载 $Name" -Status $Status -PercentComplete $Percent
                    $LastProgress = $Stopwatch.ElapsedMilliseconds
                }
            }
            $FileStream.Flush()
            Write-Progress -Activity "下载 $Name" -Completed
            $ActualBytes = (Get-Item $OutFile).Length
            if ($ActualBytes -le 0) { throw "下载结果为空。" }
            if ($ContentLength -gt 0 -and $ActualBytes -ne $ContentLength) {
                throw "文件大小不符：预期 $(Format-Megabytes $ContentLength)，实际 $(Format-Megabytes $ActualBytes)。"
            }
            Write-InstallerSuccess "已下载 $Name（$(Format-Megabytes $ActualBytes)）。"
            return
        }
        catch {
            Write-Progress -Activity "下载 $Name" -Completed
            if ($FileStream) { $FileStream.Dispose(); $FileStream = $null }
            Remove-Item -Force -ErrorAction SilentlyContinue $OutFile
            if ($Attempt -eq 3) {
                throw "下载失败：$Uri`n$($_.Exception.Message)"
            }
            Write-InstallerWarning "下载未完成，正在重试（$($Attempt + 1)/3）……"
            Start-Sleep -Seconds $Attempt
        }
        finally {
            if ($FileStream) { $FileStream.Dispose() }
            if ($ResponseStream) { $ResponseStream.Dispose() }
            if ($Response) { $Response.Dispose() }
            if ($Client) { $Client.Dispose() }
            if ($ReadTimeout) { $ReadTimeout.Dispose() }
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
        $Backup = "$Path.backup"
        Remove-Item -Force -ErrorAction SilentlyContinue $Backup
        try {
            [IO.File]::Replace($Temp, $Path, $Backup)
        }
        finally {
            Remove-Item -Force -ErrorAction SilentlyContinue $Backup
        }
    }
    else {
        Move-Item $Temp $Path
    }
}

function Test-WebUsage {
    return (Test-Path (Join-Path $WebAgentDir "web-config.json")) -or
        (Test-Path (Join-Path $WebAgentDir "web\service-state.json")) -or
        (Test-Path (Join-Path $WebAgentDir "web\gateway.json"))
}

function Invoke-WebServiceReconcile([string]$TargetVersion, [string]$PreviousVersion = "", [string]$Launcher = "") {
    if (!(Test-WebUsage)) { return }
    if (!$Launcher) { $Launcher = Join-Path $BinDir "lc.cmd" }
    if (!(Test-Path $Launcher)) { throw "Web 服务已使用，但没有找到可执行的 lc：$Launcher" }
    $HadTargetVersion = Test-Path Env:LYSTAR_WEB_SERVICE_TARGET_VERSION
    $SavedTargetVersion = $env:LYSTAR_WEB_SERVICE_TARGET_VERSION
    $HadPreviousVersion = Test-Path Env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION
    $SavedPreviousVersion = $env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION
    try {
        $env:LYSTAR_WEB_SERVICE_TARGET_VERSION = $TargetVersion
        if ($PreviousVersion) { $env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION = $PreviousVersion }
        else { Remove-Item Env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION -ErrorAction SilentlyContinue }
        Write-InstallerInfo "正在把 Web Gateway 和 Web Runtime 服务切换到 $TargetVersion……"
        & $Launcher web service reconcile --upgrade --non-interactive | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Web 服务 reconcile 失败，退出码：$LASTEXITCODE。" }
    }
    finally {
        if ($HadTargetVersion) { $env:LYSTAR_WEB_SERVICE_TARGET_VERSION = $SavedTargetVersion }
        else { Remove-Item Env:LYSTAR_WEB_SERVICE_TARGET_VERSION -ErrorAction SilentlyContinue }
        if ($HadPreviousVersion) { $env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION = $SavedPreviousVersion }
        else { Remove-Item Env:LYSTAR_WEB_PREVIOUS_SERVICE_VERSION -ErrorAction SilentlyContinue }
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
    try {
        $Process = Start-Process -FilePath $TerminalHost -ArgumentList "--smoke-test" -Wait -PassThru
        return $Process.ExitCode -eq 0
    }
    catch {
        return $false
    }
}

function Ensure-WebView2Runtime([string]$TerminalHost, [string]$TempDir) {
    Write-InstallerInfo "正在检查 WebView2 Runtime……"
    if (Test-WebView2Runtime $TerminalHost) {
        Write-InstallerSuccess "WebView2 Runtime 已可用。"
        return
    }

    Write-InstallerWarning "没有检测到可用的 WebView2 Runtime，安装器会继续准备它。"
    $Installer = $WebView2Installer
    if ($Installer) {
        $Installer = [IO.Path]::GetFullPath($Installer)
        if (!(Test-Path $Installer)) { throw "WebView2 离线安装包不存在：$Installer" }
        Write-InstallerInfo "使用离线安装包：$Installer"
    }
    elseif ($Offline) {
        throw "离线模式缺少 -WebView2Installer，且当前系统没有可用的 WebView2 Runtime。"
    }
    else {
        $Installer = Join-Path $TempDir "MicrosoftEdgeWebView2Setup.exe"
        Write-InstallerInfo "正在下载 WebView2 安装程序……"
        Invoke-Download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" $Installer
    }

    Write-InstallerInfo "正在安装 WebView2 Runtime，请等待安装程序完成……"
    $Process = Start-Process -FilePath $Installer -ArgumentList "/silent", "/install" -Wait -PassThru
    if ($Process.ExitCode -ne 0 -and $Process.ExitCode -ne 3010) {
        throw "WebView2 Runtime 安装失败，退出码：$($Process.ExitCode)。可使用 lc --attached 临时运行。"
    }
    if (!(Test-WebView2Runtime $TerminalHost)) {
        throw "WebView2 Runtime 安装后仍不可用。可使用 lc --attached 临时运行。"
    }
    Write-InstallerSuccess "WebView2 Runtime 已准备好。"
}

Write-InstallerBanner
$Operation = if ($Uninstall) { "卸载" } elseif ($Rollback) { "回退版本" } else { "安装或更新" }
Write-InstallerInfo "当前操作：$Operation"
Write-InstallerInfo "安装目录：$InstallRoot"
Write-InstallerInfo "安装范围：当前用户，不需要管理员权限。"
if ($Offline) {
    Write-InstallerInfo "网络模式：离线安装，只使用本地文件。"
}
else {
    Write-InstallerInfo "网络模式：在线安装，将从 GitHub Release 获取文件。"
}
Write-InstallerInfo "当前版本：$CurrentVersion"

if ($Uninstall) {
    Write-InstallerStep 1 1 "删除 LYStar Code 安装文件"
    Write-InstallerInfo "将删除安装目录：$InstallRoot"
    Write-InstallerInfo "用户数据目录 ~/.pi/agent 不会删除。"
    $CurrentLauncher = Join-Path $InstallRoot "bin\lc.cmd"
    if (Test-Path $CurrentLauncher) {
        & $CurrentLauncher web service uninstall --non-interactive | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Web 服务卸载失败，未删除安装目录。" }
    }
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ -and $_ -ne $BinDir })
    [Environment]::SetEnvironmentVariable("Path", ($Parts -join ";"), "User")
    Send-EnvironmentChanged
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Code.lnk")
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Agent.lnk")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallRoot
    Write-InstallerSuccess "LYStar Code 已卸载。用户数据仍保留在 ~/.pi/agent。"
    exit 0
}

if ($Rollback) {
    Write-InstallerStep 1 1 "切换到上一个 LYStar Code 版本"
    if (!(Test-Path $PreviousFile)) { throw "没有可回退的 LYStar Code 版本。" }
    $Previous = (Get-Content -Raw $PreviousFile).Trim()
    if ($Previous -notmatch '^\d+\.\d+\.\d+-lystar\.\d+$') { throw "previous 版本指针无效。" }
    $OldCurrent = if (Test-Path $CurrentFile) { (Get-Content -Raw $CurrentFile).Trim() } else { "" }
    $PreviousExecutable = Join-Path $InstallRoot "versions\$Previous\lc.exe"
    if (!(Test-Path $PreviousExecutable)) { $PreviousExecutable = Join-Path $InstallRoot "versions\$Previous\la.exe" }
    if (!(Test-Path $PreviousExecutable)) { throw "回退版本缺少可执行文件，未切换版本。" }
    $PreviousCheck = (& $PreviousExecutable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $PreviousCheck -ne $Previous) { throw "回退版本校验失败，未切换版本。" }
    Set-AtomicText $CurrentFile $Previous
    $ActivatedVersion = $Previous
    if ($OldCurrent) { Set-AtomicText $PreviousFile $OldCurrent }
    $RollbackLauncher = Join-Path $InstallRoot "versions\$OldCurrent\lc.exe"
    if (!(Test-Path $RollbackLauncher)) { $RollbackLauncher = "" }
    try {
        Invoke-WebServiceReconcile $Previous $OldCurrent $RollbackLauncher
    }
    catch {
        throw "LYStar Code 已回退到 $Previous，但 Web 服务切换失败。应用版本不会因 Web 服务错误回退。请运行 lc web service status 查看结果。$($_.Exception.Message)"
    }
    Write-InstallerSuccess "已回退到 $Previous。"
    exit 0
}

if ($Repository -eq "__LYSTAR_RELEASE_REPOSITORY__") {
    throw "安装器尚未写入 GitHub repository。请使用 release 构建生成的 install.ps1。"
}
if ($Offline -and (!$ReleaseManifest -or !$ReleaseArchive -or !$MinGitArchive)) {
    throw "离线安装必须同时提供 -ReleaseManifest、-ReleaseArchive 和 -MinGitArchive。"
}

Write-InstallerStep 1 6 "获取版本信息"
$Headers = @{ "User-Agent" = "LYStar-Code-Installer" }
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
Write-InstallerInfo "目标版本：$Version"
Write-InstallerInfo "下载仓库：$Repository"

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
    Write-InstallerStep 2 6 "下载并校验 Windows x64 发行包"
    Write-InstallerInfo "发行包：$Asset"
    $Archive = Join-Path $Temp $Asset
    $Sums = Join-Path $Temp "SHA256SUMS"
    if ($ReleaseArchive) {
        $ResolvedArchive = [IO.Path]::GetFullPath($ReleaseArchive)
        if (!(Test-Path $ResolvedArchive)) { throw "本地 Release archive 不存在：$ResolvedArchive" }
        Write-InstallerInfo "使用本地发行包：$ResolvedArchive"
        Copy-Item $ResolvedArchive $Archive
        if ($ExpectedAssetBytes -gt 0 -and (Get-Item $Archive).Length -ne $ExpectedAssetBytes) {
            throw "本地 Release archive 文件大小不符。"
        }
    }
    else {
        Invoke-Download "$BaseUrl/$Asset" $Archive $ExpectedAssetBytes
    }

    $Expected = [string]$AssetInfo.sha256
    Write-InstallerInfo "正在校验发行包完整性（SHA-256）……"
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
    Write-InstallerSuccess "发行包完整性校验通过。"

    $Extract = Join-Path $Temp "extract"
    Write-InstallerInfo "正在解压发行包……"
    Expand-Archive -Path $Archive -DestinationPath $Extract
    $Bundle = Join-Path $Extract "lystar-agent"
    $Executable = Join-Path $Bundle "lc.exe"
    $TerminalHost = Join-Path $Bundle "lystar-terminal.exe"
    $ServiceHost = Join-Path $Bundle "lystar-web-service.exe"
    if (!(Test-Path $Executable)) { throw "发行包缺少 lc.exe。" }
    if (!(Test-Path $TerminalHost)) { throw "发行包缺少 lystar-terminal.exe。" }
    if (!(Test-Path $ServiceHost)) { throw "发行包缺少 lystar-web-service.exe。" }
    Write-InstallerSuccess "发行包已解压，文件检查通过。"
    Write-InstallerStep 3 6 "准备桌面终端组件"
    Ensure-WebView2Runtime $TerminalHost $Temp
    $CandidateVersion = (& $Executable --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $CandidateVersion -ne $Version) {
        throw "候选 lc.exe 版本校验失败：预期 $Version，实际 $CandidateVersion。"
    }
    Write-InstallerSuccess "桌面终端组件检查通过，候选版本为 $CandidateVersion。"
    Write-InstallerStep 4 6 "准备 LYStar 托管的 MinGit Bash"
    Write-InstallerInfo "正在检查托管 Bash 环境……"
    $MinGitArgs = @("--ensure-windows-bash")
    if ($MinGitArchive) {
        $ResolvedMinGitArchive = [IO.Path]::GetFullPath($MinGitArchive)
        if (!(Test-Path $ResolvedMinGitArchive)) { throw "MinGit 离线安装包不存在：$ResolvedMinGitArchive" }
        $MinGitArgs += @("--archive", $ResolvedMinGitArchive, "--offline")
    }
    & $Executable @MinGitArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "MinGit Bash 自动安装失败，LYStar 版本未切换。" }
    Write-InstallerSuccess "MinGit Bash 已准备好。"

    Write-InstallerStep 5 6 "写入版本、命令和开始菜单快捷方式"
    New-Item -ItemType Directory -Force $VersionsDir, $BinDir | Out-Null
    $Target = Join-Path $VersionsDir $Version
    if (!(Test-Path $Target)) { Move-Item $Bundle $Target }
    else {
        $ExistingVersion = (& (Join-Path $Target "lc.exe") --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $ExistingVersion -ne $Version) { throw "已有版本目录校验失败：$Target" }
    }

    $Current = if (Test-Path $CurrentFile) { (Get-Content -Raw $CurrentFile).Trim() } else { "" }
    if ($Current -and $Current -ne $Version) { Set-AtomicText $PreviousFile $Current }
    Set-AtomicText $CurrentFile $Version
    $ActivatedVersion = $Version
    Write-InstallerSuccess "版本指针已切换到 $Version。"

    $Launcher = @'
@echo off
setlocal
if defined LYSTAR_WEB_SERVICE_VERSION (
    set "LYSTAR_VERSION=%LYSTAR_WEB_SERVICE_VERSION%"
) else (
    set /p LYSTAR_VERSION=<"%~dp0..\current"
)
set "LYSTAR_EXECUTABLE=%~dp0..\versions\%LYSTAR_VERSION%\lc.exe"
if not exist "%LYSTAR_EXECUTABLE%" set "LYSTAR_EXECUTABLE=%~dp0..\versions\%LYSTAR_VERSION%\la.exe"
"%LYSTAR_EXECUTABLE%" %*
exit /b %errorlevel%
'@
    [IO.File]::WriteAllText((Join-Path $BinDir "lc.cmd"), $Launcher, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $BinDir "lystar.cmd"), $Launcher, [Text.UTF8Encoding]::new($false))
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $BinDir "la.cmd")

    $LegacyStartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Agent.lnk"
    Remove-Item -Force -ErrorAction SilentlyContinue $LegacyStartMenuShortcut
    $StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LYStar Code.lnk"
    New-Item -ItemType Directory -Force (Split-Path -Parent $StartMenuShortcut) | Out-Null
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuShortcut)
    $Shortcut.TargetPath = Join-Path $BinDir "lc.cmd"
    $Shortcut.WorkingDirectory = [Environment]::GetFolderPath("UserProfile")
    $Shortcut.IconLocation = "$(Join-Path $Target 'lystar-terminal.exe'),0"
    $Shortcut.Description = "LYStar Code"
    $Shortcut.Save()

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ })
    if ($Parts -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable("Path", (($Parts + $BinDir) -join ";"), "User")
        Send-EnvironmentChanged
        Write-InstallerSuccess "已把 $BinDir 加入用户 PATH。"
    }
    else {
        Write-InstallerInfo "用户 PATH 已包含 $BinDir。"
    }
    $env:Path = "$BinDir;$env:Path"
    Write-InstallerStep 6 6 "检查安装结果"
    $InstalledVersion = (& (Join-Path $BinDir "lc.cmd") --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne $Version) {
        throw "安装后的 lc 版本校验失败：预期 $Version，实际 $InstalledVersion。"
    }
    $AliasVersion = (& (Join-Path $BinDir "lystar.cmd") --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $AliasVersion -ne $Version) {
        throw "安装后的 lystar 版本校验失败：预期 $Version，实际 $AliasVersion。"
    }

    try {
        Invoke-WebServiceReconcile $Version $Current
    }
    catch {
        throw "LYStar Code $Version 已安装，但 Web 服务切换失败。应用版本不会因 Web 服务错误回退。请运行 lc web service status 查看结果。$($_.Exception.Message)"
    }

    Write-InstallerSuccess "LYStar Code $Version 已安装到 $Target。"
    Write-InstallerInfo "新开的 PowerShell 或 CMD 窗口可直接运行：lc、lystar"
    Write-InstallerInfo "首次使用请执行：/login"
    Write-InstallerInfo "用户数据目录 ~/.pi/agent 不会被安装器删除。"
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
exit 0
