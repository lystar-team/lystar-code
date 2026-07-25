param(
    [string]$Version = "",
    [switch]$Rollback,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Repository = "__LYSTAR_RELEASE_REPOSITORY__"
$InstallRoot = Join-Path $env:LOCALAPPDATA "LYStarAgent"
$VersionsDir = Join-Path $InstallRoot "versions"
$BinDir = Join-Path $InstallRoot "bin"
$CurrentFile = Join-Path $InstallRoot "current"
$PreviousFile = Join-Path $InstallRoot "previous"

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

if ($Uninstall) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ -and $_ -ne $BinDir })
    [Environment]::SetEnvironmentVariable("Path", ($Parts -join ";"), "User")
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

if (!$Version) {
    $Headers = @{ "User-Agent" = "LYStar-Agent-Installer" }
    $Release = Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
    $Version = [string]$Release.tag_name -replace '^v', ''
}
if ($Version -notmatch '^\d+\.\d+\.\d+-lystar\.\d+$') { throw "无效版本：$Version" }

$Arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    "X64" { "x64" }
    "Arm64" { "arm64" }
    default { throw "当前 Windows 架构暂不支持：$_" }
}
if ($Arch -eq "arm64") { throw "首版暂未提供 Windows ARM64 发行包。" }

$Asset = "lystar-agent-v$Version-windows-x64.zip"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("lystar-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $Temp | Out-Null

try {
    $Archive = Join-Path $Temp $Asset
    $Sums = Join-Path $Temp "SHA256SUMS"
    Write-Host "正在下载 LYStar Agent $Version (windows-x64)..."
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $Archive
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $Sums

    $Pattern = "^([0-9a-fA-F]{64})\s+\*?" + [Regex]::Escape($Asset) + '$'
    $Match = Get-Content $Sums | Select-String -Pattern $Pattern | Select-Object -First 1
    if (!$Match) { throw "SHA256SUMS 中缺少 $Asset。" }
    $Expected = $Match.Matches[0].Groups[1].Value.ToLowerInvariant()
    $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw "SHA-256 校验失败。" }

    $Extract = Join-Path $Temp "extract"
    Expand-Archive -Path $Archive -DestinationPath $Extract
    $Bundle = Join-Path $Extract "lystar-agent"
    $Executable = Join-Path $Bundle "la.exe"
    if (!(Test-Path $Executable)) { throw "发行包缺少 la.exe。" }
    & $Executable --version | Out-Null

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

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @($UserPath -split ";" | Where-Object { $_ })
    if ($Parts -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable("Path", (($Parts + $BinDir) -join ";"), "User")
        Write-Host "已把 $BinDir 加入用户 PATH。请重新打开终端。"
    }

    $Bash = Get-Command bash.exe -ErrorAction SilentlyContinue
    if (!$Bash -and !(Test-Path "C:\Program Files\Git\bin\bash.exe")) {
        Write-Warning "LYStar Agent 需要 Bash。请安装 Git for Windows 后再运行 la。"
    }
    Write-Host "LYStar Agent $Version 已安装到 $Target。"
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
