@echo off
setlocal EnableExtensions
chcp 65001 >nul
title LYStar Code 安装器

if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-?" goto :usage
if /i "%~1"=="--help" goto :usage

set "LYSTAR_BOOTSTRAP_MIRROR=%LYSTAR_GITHUB_MIRROR%"
:arguments
if "%~1"=="" goto :download
if /i "%~1"=="-Mirror" (
  set "LYSTAR_BOOTSTRAP_MIRROR=%~2"
  shift
)
shift
goto :arguments

:download
echo.
echo LYStar Code Windows 安装器
echo 安装范围：当前用户，不需要管理员权限。
echo.

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [失败] 未找到 Windows PowerShell。
  echo 请启用 Windows PowerShell 后重新运行安装器。
  exit /b 1
)

echo [1/2] 下载安装脚本
set "LYSTAR_INSTALLER=%TEMP%\lystar-install-%RANDOM%%RANDOM%.ps1"
set "LYSTAR_BOOTSTRAP_SOURCE=%~f0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$Source = [IO.File]::ReadAllText($env:LYSTAR_BOOTSTRAP_SOURCE); Invoke-Expression (($Source -split '(?m)^# LYSTAR_BOOTSTRAP\r?$', 2)[1])"
if errorlevel 1 (
  echo.
  echo [失败] 安装脚本下载失败。
  del /q "%LYSTAR_INSTALLER%" >nul 2>nul
  exit /b 1
)

echo [2/2] 启动安装脚本
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LYSTAR_INSTALLER%" %*
set "LYSTAR_EXIT=%ERRORLEVEL%"
del /q "%LYSTAR_INSTALLER%" >nul 2>nul
if not "%LYSTAR_EXIT%"=="0" (
  echo.
  echo [失败] 安装没有完成。
  exit /b %LYSTAR_EXIT%
)

exit /b 0

:usage
echo.
echo 用法：
echo   install.cmd                     安装最新版本
echo   install.cmd -Version 版本号      安装指定版本
echo   install.cmd -Mirror 地址或direct 设置 GitHub 镜像或直连
echo   install.cmd -Rollback            回退到上一个版本
echo   install.cmd -Uninstall           卸载 LYStar Code
echo.
echo 离线安装和本地安装包参数请直接运行 install.ps1 -Help 查看。
exit /b 0

# LYSTAR_BOOTSTRAP
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
$Uri = 'https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1'
$Mirror = if ($env:LYSTAR_BOOTSTRAP_MIRROR) { $env:LYSTAR_BOOTSTRAP_MIRROR } else { 'https://ghfast.top' }
if ($Mirror -ne 'direct' -and $Mirror -notmatch '^https?://\S+$') { throw '镜像地址需以 http:// 或 https:// 开头。' }
$RequestUri = if ($Mirror -eq 'direct') { $Uri } else { "$($Mirror.TrimEnd('/'))/$Uri" }
$Interactive = -not [Console]::IsOutputRedirected
$ProgressWidth = 0
$DrawProgress = {
    param([long]$Downloaded, [long]$Length, [bool]$Completed = $false)
    $Percent = if ($Length -gt 0) { [Math]::Min(99, [Math]::Floor($Downloaded * 100 / $Length)) } else { 0 }
    if ($Completed) { $Percent = 100; $Length = $Downloaded }
    $Filled = [int][Math]::Floor($Percent / 5)
    $Bar = ('=' * $Filled) + ('-' * (20 - $Filled))
    $Label = if ($Length -gt 0 -or $Downloaded -eq 0 -or $Completed) { '{0,3}%' -f $Percent } else { ' --%' }
    $Size = if ($Length -gt 0) { '{0:0.00} MB' -f ($Length / 1MB) } else { '? MB' }
    $Line = '  [{0}] {1} ({2:0.00} MB/{3})' -f $Bar, $Label, ($Downloaded / 1MB), $Size
    Write-Host -NoNewline ("`r" + $Line.PadRight([Math]::Max($ProgressWidth, $Line.Length)))
    $ProgressWidth = $Line.Length
}
for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    $Client = $null
    $Response = $null
    $Stream = $null
    $File = $null
    $ReadTimeout = $null
    $ProgressStarted = $false
    try {
        Remove-Item -Force -ErrorAction SilentlyContinue $env:LYSTAR_INSTALLER
        if ($Interactive) { . $DrawProgress 0 0; $ProgressStarted = $true }
        $Client = New-Object System.Net.Http.HttpClient
        $Client.Timeout = [TimeSpan]::FromSeconds(60)
        $Client.DefaultRequestHeaders.UserAgent.ParseAdd('LYStar-Code-Installer')
        $Response = $Client.GetAsync($RequestUri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$Response.EnsureSuccessStatusCode()
        $Stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $File = [IO.File]::Create($env:LYSTAR_INSTALLER)
        $Buffer = New-Object byte[] 81920
        $Downloaded = 0L
        $Length = if ($Response.Content.Headers.ContentLength) { [long]$Response.Content.Headers.ContentLength } else { 0L }
        $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $LastProgress = -1000L
        $ReadTimeout = New-Object System.Threading.CancellationTokenSource
        while ($true) {
            $ReadTimeout.CancelAfter(60000)
            $Read = $Stream.ReadAsync($Buffer, 0, $Buffer.Length, $ReadTimeout.Token).GetAwaiter().GetResult()
            if ($Read -eq 0) { break }
            $File.Write($Buffer, 0, $Read)
            $Downloaded += $Read
            if ($Interactive -and $Stopwatch.ElapsedMilliseconds -ge ($LastProgress + 100)) {
                . $DrawProgress $Downloaded $Length
                $LastProgress = $Stopwatch.ElapsedMilliseconds
            }
        }
        $File.Flush()
        if ($Downloaded -le 0) { throw '下载结果为空。' }
        if ($Length -gt 0 -and $Downloaded -ne $Length) { throw '文件大小不符。' }
        if ($Interactive) { . $DrawProgress $Downloaded $Downloaded $true; Write-Host ''; $ProgressStarted = $false }
        Write-Host '  [完成] 已下载安装脚本'
        break
    }
    catch {
        if ($ProgressStarted) { Write-Host '' }
        if ($File) { $File.Dispose(); $File = $null }
        Remove-Item -Force -ErrorAction SilentlyContinue $env:LYSTAR_INSTALLER
        if ($Attempt -eq 3) { throw }
        if ($RequestUri -ne $Uri) {
            $RequestUri = $Uri
            Write-Host '  镜像下载失败，改用 GitHub。'
        }
        else { Write-Host ('  下载失败，重试 {0}/3。' -f ($Attempt + 1)) }
        Start-Sleep -Seconds $Attempt
    }
    finally {
        if ($File) { $File.Dispose() }
        if ($Stream) { $Stream.Dispose() }
        if ($Response) { $Response.Dispose() }
        if ($Client) { $Client.Dispose() }
        if ($ReadTimeout) { $ReadTimeout.Dispose() }
    }
}
