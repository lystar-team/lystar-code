@echo off
setlocal EnableExtensions
chcp 65001 >nul
title LYStar Code 安装器

if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-?" goto :usage
if /i "%~1"=="--help" goto :usage

echo.
echo ============================================================
echo   LYStar Code Windows 安装器
echo ============================================================
echo.
echo 这个安装器会下载、校验并安装 LYStar Code Windows x64 版本。
echo 安装范围：当前用户，不需要管理员权限。
echo 安装失败时不会切换当前版本。
echo.

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [失败] 未找到 Windows PowerShell。
  echo 请启用 Windows PowerShell 后重新运行安装器。
  exit /b 1
)

echo [1/2] 正在下载安装向导……
set "LYSTAR_INSTALLER=%TEMP%\lystar-install-%RANDOM%%RANDOM%.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; for ($Attempt = 1; $Attempt -le 3; $Attempt++) { try { Remove-Item -Force -ErrorAction SilentlyContinue '%LYSTAR_INSTALLER%'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri 'https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1' -OutFile '%LYSTAR_INSTALLER%'; break } catch { if ($Attempt -eq 3) { Write-Host ('下载失败：' + $_.Exception.Message); exit 1 }; Write-Host ('下载未完成，正在重试（{0}/3）……' -f ($Attempt + 1)); Start-Sleep -Seconds $Attempt } }; $Size = (Get-Item '%LYSTAR_INSTALLER%').Length / 1MB; Write-Host ('安装向导已下载（{0:0.00} MB）。' -f $Size)"
if errorlevel 1 (
  echo.
  echo [失败] 安装向导下载失败。
  echo 请检查网络连接后重新运行；原有安装不会受到影响。
  del /q "%LYSTAR_INSTALLER%" >nul 2>nul
  exit /b 1
)

echo [2/2] 正在启动安装向导……
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LYSTAR_INSTALLER%" %*
set "LYSTAR_EXIT=%ERRORLEVEL%"
del /q "%LYSTAR_INSTALLER%" >nul 2>nul
if not "%LYSTAR_EXIT%"=="0" (
  echo.
  echo [失败] 安装没有完成。
  echo 上面显示了具体原因；当前版本仍然可以使用。
  exit /b %LYSTAR_EXIT%
)

echo.
echo ============================================================
echo   LYStar Code 安装完成
echo ============================================================
echo.
echo 请新开一个 PowerShell 或 CMD 窗口，让 PATH 设置生效。
echo 然后运行：lc --version
echo.
exit /b 0

:usage
echo.
echo 用法：
echo   install.cmd                 安装最新版本
echo   install.cmd -Version 版本号  安装指定版本
echo   install.cmd -Rollback       回退到上一个版本
echo   install.cmd -Uninstall      卸载 LYStar Code
echo.
echo 离线安装和本地安装包参数请直接运行 install.ps1 -Help 查看。
echo.
exit /b 0
