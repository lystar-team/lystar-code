@echo off
setlocal EnableExtensions
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo LYStar Code installer requires Windows PowerShell 5.1 or later. 1>&2
  exit /b 1
)

set "LYSTAR_INSTALLER=%TEMP%\lystar-install-%RANDOM%%RANDOM%.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; for ($Attempt = 1; $Attempt -le 3; $Attempt++) { try { Remove-Item -Force -ErrorAction SilentlyContinue '%LYSTAR_INSTALLER%'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri 'https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1' -OutFile '%LYSTAR_INSTALLER%'; break } catch { if ($Attempt -eq 3) { throw }; Start-Sleep -Seconds $Attempt } }; $Size = (Get-Item '%LYSTAR_INSTALLER%').Length / 1MB; Write-Host ('Installer downloaded ({0:0.00} MB).' -f $Size)"
if errorlevel 1 (
  echo Failed to download the LYStar Code installer. 1>&2
  del /q "%LYSTAR_INSTALLER%" >nul 2>nul
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LYSTAR_INSTALLER%" %*
set "LYSTAR_EXIT=%ERRORLEVEL%"
del /q "%LYSTAR_INSTALLER%" >nul 2>nul
exit /b %LYSTAR_EXIT%
