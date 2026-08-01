param(
    [switch]$Integration
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("lystar-installer-test-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $Temp | Out-Null

try {
    & node (Join-Path $Root "scripts/generate-release-metadata.mjs") $Temp "1.0.0-lystar.1" "octyean/lystar-agent"
    if ($LASTEXITCODE -ne 0) { throw "Failed to materialize release installer." }

    $Installers = @(
        (Join-Path $Root "scripts/install.ps1"),
        (Join-Path $Temp "install.ps1")
    )

    foreach ($Installer in $Installers) {
        $Bytes = [IO.File]::ReadAllBytes($Installer)
        if ($Bytes.Length -lt 3 -or $Bytes[0] -ne 0xEF -or $Bytes[1] -ne 0xBB -or $Bytes[2] -ne 0xBF) {
            throw "$Installer must start with a UTF-8 BOM for Windows PowerShell 5.1."
        }

        $Tokens = $null
        $Errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$Errors) | Out-Null
        if ($Errors.Count -gt 0) {
            throw (($Errors | ForEach-Object { $_.Message }) -join [Environment]::NewLine)
        }

        $Source = [IO.File]::ReadAllText($Installer)
        foreach ($Required in @(
            'Format-Megabytes',
            'Invoke-Download',
            'Invoke-JsonRequest',
            'release-manifest.json',
            'ExpectedAssetBytes',
            'Send-EnvironmentChanged',
            'set /p LYSTAR_VERSION=',
            'versions\%LYSTAR_VERSION%\la.exe',
            '$PSVersionTable.PSVersion.Major -lt 5',
            '[Net.SecurityProtocolType]::Tls12',
            '--ensure-windows-bash',
            'MinGit Bash 自动安装失败'
        )) {
            if (!$Source.Contains($Required)) { throw "$Installer is missing: $Required" }
        }
        foreach ($Forbidden in @(
            'Get-AuthenticodeSignature',
            'winget install --id Git.Git',
            '请先安装：https://git-scm.com/download/win',
            'Set-ExecutionPolicy'
        )) {
            if ($Source.Contains($Forbidden)) { throw "$Installer contains an unnecessary dependency: $Forbidden" }
        }
    }

    $SourceCmd = [IO.File]::ReadAllText((Join-Path $Root "scripts/install.cmd"))
    $ReleaseCmd = [IO.File]::ReadAllText((Join-Path $Temp "install.cmd"))
    foreach ($Required in @('powershell.exe', '-ExecutionPolicy Bypass', '-NoProfile', '%*', '$Attempt -le 3', '1MB')) {
        if (!$SourceCmd.Contains($Required)) { throw "install.cmd is missing: $Required" }
    }
    if (!$SourceCmd.Contains('https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1')) {
        throw "Source install.cmd must preserve the repository placeholder."
    }
    if (!$ReleaseCmd.Contains('https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1')) {
        throw "Release install.cmd was not materialized."
    }
    if ($SourceCmd.Contains('Set-ExecutionPolicy')) {
        throw "install.cmd must only use a process-scoped ExecutionPolicy argument."
    }

    if ($Integration) {
        $SavedLocalAppData = $env:LOCALAPPDATA
        $SavedAgentDir = $env:PI_CODING_AGENT_DIR
        $SavedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        try {
            $env:LOCALAPPDATA = Join-Path $Temp "local-app-data"
            $env:PI_CODING_AGENT_DIR = Join-Path $Temp "agent"
            $ReleaseInstaller = Join-Path $Temp "install.ps1"
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ReleaseInstaller
            if ($LASTEXITCODE -ne 0) { throw "Materialized installer exited with $LASTEXITCODE." }

            $InstallRoot = Join-Path $env:LOCALAPPDATA "LYStarAgent"
            $Current = (Get-Content -Raw (Join-Path $InstallRoot "current")).Trim()
            $Launcher = Join-Path $InstallRoot "bin\la.cmd"
            $InstalledVersion = (& $Launcher --version | Out-String).Trim()
            if ($InstalledVersion -ne $Current) {
                throw "Installed launcher reported '$InstalledVersion', expected '$Current'."
            }

            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ReleaseInstaller -Uninstall
            if ($LASTEXITCODE -ne 0 -or (Test-Path $InstallRoot)) { throw "Installer uninstall check failed." }
            Write-Host "Windows installer end-to-end install, launch, and uninstall passed."
        }
        finally {
            [Environment]::SetEnvironmentVariable("Path", $SavedUserPath, "User")
            $env:LOCALAPPDATA = $SavedLocalAppData
            $env:PI_CODING_AGENT_DIR = $SavedAgentDir
        }
    }

    Write-Host "Windows installer encoding, parser, manifest resolution, MB display, managed Bash bootstrap, and CMD retry checks passed."
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
