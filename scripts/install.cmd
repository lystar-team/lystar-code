@echo off
setlocal EnableExtensions
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo LYStar Agent installer requires Windows PowerShell 5.1 or later. 1>&2
  exit /b 1
)

set "LYSTAR_INSTALLER=%TEMP%\lystar-install-%RANDOM%%RANDOM%.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1' -OutFile '%LYSTAR_INSTALLER%'"
if errorlevel 1 (
  echo Failed to download the LYStar Agent installer. 1>&2
  del /q "%LYSTAR_INSTALLER%" >nul 2>nul
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LYSTAR_INSTALLER%" %*
set "LYSTAR_EXIT=%ERRORLEVEL%"
del /q "%LYSTAR_INSTALLER%" >nul 2>nul
exit /b %LYSTAR_EXIT%
