param(
    [switch]$Integration,
    [string]$MinGitArchive = "",
    [string]$WebView2Installer = ""
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
            'versions\%LYSTAR_VERSION%\lc.exe',
            'versions\%LYSTAR_VERSION%\la.exe',
            '$PSVersionTable.PSVersion.Major -lt 5',
            '[Net.SecurityProtocolType]::Tls12',
            '--ensure-windows-bash',
            'MinGit Bash 自动安装失败',
            'MinGitArchive',
            'WebView2Installer',
            'ReleaseArchive',
            'ReleaseManifest',
            '[switch]$Offline',
            'Ensure-WebView2Runtime',
            'lystar-terminal.exe',
            'LYStar Code.lnk',
            'lc --attached'
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
        if (!$MinGitArchive) { throw "Integration test requires -MinGitArchive for offline installation." }
        $MinGitArchive = [IO.Path]::GetFullPath($MinGitArchive)
        if (!(Test-Path $MinGitArchive)) { throw "MinGit archive does not exist: $MinGitArchive" }
        $SavedLocalAppData = $env:LOCALAPPDATA
        $SavedAppData = $env:APPDATA
        $SavedAgentDir = $env:PI_CODING_AGENT_DIR
        $SavedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        try {
            $env:LOCALAPPDATA = Join-Path $Temp "local-app-data"
            $env:APPDATA = Join-Path $Temp "app-data"
            $env:PI_CODING_AGENT_DIR = Join-Path $Temp "agent"
            $BuiltOutput = Join-Path $Root "packages\coding-agent\binaries"
            $BuiltArchive = Get-ChildItem -Path $BuiltOutput -Filter "lystar-agent-*-windows-x64.zip" | Select-Object -First 1
            if (!$BuiltArchive) { throw "Integration test requires a Windows release archive in $BuiltOutput." }
            $BuiltVersion = [Regex]::Match($BuiltArchive.Name, '^lystar-agent-v(.+)-windows-x64\.zip$').Groups[1].Value
            $InstallRoot = Join-Path $env:LOCALAPPDATA "LYStarAgent"
            $LegacyVersion = "0.84.1-lystar.8"
            $LegacyDir = Join-Path $InstallRoot "versions\$LegacyVersion"
            $LegacyExtract = Join-Path $Temp "legacy-extract"
            Expand-Archive -Path $BuiltArchive.FullName -DestinationPath $LegacyExtract -Force
            New-Item -ItemType Directory -Force $LegacyDir, (Join-Path $InstallRoot "bin") | Out-Null
            Copy-Item (Join-Path $LegacyExtract "lystar-agent\lc.exe") (Join-Path $LegacyDir "la.exe")
            [IO.File]::WriteAllText((Join-Path $InstallRoot "current"), $LegacyVersion, [Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText((Join-Path $InstallRoot "bin\la.cmd"), "@echo off`r`n", [Text.UTF8Encoding]::new($false))
            & node (Join-Path $Root "scripts/generate-release-metadata.mjs") $BuiltOutput $BuiltVersion "octyean/lystar-agent"
            if ($LASTEXITCODE -ne 0) { throw "Failed to generate local release metadata." }
            $ReleaseInstaller = Join-Path $BuiltOutput "install.ps1"
            $InstallArgs = @(
                "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ReleaseInstaller,
                "-ReleaseArchive", $BuiltArchive.FullName,
                "-ReleaseManifest", (Join-Path $BuiltOutput "release-manifest.json"),
                "-MinGitArchive", $MinGitArchive,
                "-Offline"
            )
            if ($WebView2Installer) { $InstallArgs += @("-WebView2Installer", [IO.Path]::GetFullPath($WebView2Installer)) }
            & powershell.exe @InstallArgs
            if ($LASTEXITCODE -ne 0) { throw "Materialized installer exited with $LASTEXITCODE." }

            $Current = (Get-Content -Raw (Join-Path $InstallRoot "current")).Trim()
            $Previous = (Get-Content -Raw (Join-Path $InstallRoot "previous")).Trim()
            if ($Current -ne $BuiltVersion -or $Previous -ne $LegacyVersion) {
                throw "Upgrade pointers are invalid: current=$Current previous=$Previous."
            }
            $Launcher = Join-Path $InstallRoot "bin\lc.cmd"
            $InstalledVersion = (& $Launcher --version | Out-String).Trim()
            if ($InstalledVersion -ne $Current) {
                throw "Installed launcher reported '$InstalledVersion', expected '$Current'."
            }
            $AliasVersion = (& (Join-Path $InstallRoot "bin\lystar.cmd") --version | Out-String).Trim()
            if ($AliasVersion -ne $Current) {
                throw "Installed alias reported '$AliasVersion', expected '$Current'."
            }
            if (Test-Path (Join-Path $InstallRoot "bin\la.cmd")) {
                throw "Legacy la.cmd launcher was not removed."
            }

            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ReleaseInstaller -Rollback
            if ($LASTEXITCODE -ne 0) { throw "Installer rollback to the legacy version failed." }
            if ((Get-Content -Raw (Join-Path $InstallRoot "current")).Trim() -ne $LegacyVersion) {
                throw "Rollback did not activate the legacy version."
            }
            $CurrentExecutable = Join-Path $InstallRoot "versions\$BuiltVersion\lc.exe"
            $DisabledExecutable = "$CurrentExecutable.disabled"
            Move-Item $CurrentExecutable $DisabledExecutable
            try {
                if ((& $Launcher --version | Out-String).Trim() -ne $BuiltVersion) {
                    throw "lc.cmd did not fall back to the legacy la.exe."
                }
                if ((& (Join-Path $InstallRoot "bin\lystar.cmd") --version | Out-String).Trim() -ne $BuiltVersion) {
                    throw "lystar.cmd did not fall back to the legacy la.exe."
                }
            }
            finally {
                Move-Item $DisabledExecutable $CurrentExecutable
            }
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ReleaseInstaller -Rollback
            if ($LASTEXITCODE -ne 0) { throw "Installer rollback to the current version failed." }

            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ReleaseInstaller -Uninstall
            if ($LASTEXITCODE -ne 0 -or (Test-Path $InstallRoot)) { throw "Installer uninstall check failed." }
            Write-Host "Windows installer end-to-end install, launch, and uninstall passed."
        }
        finally {
            [Environment]::SetEnvironmentVariable("Path", $SavedUserPath, "User")
            $env:LOCALAPPDATA = $SavedLocalAppData
            $env:APPDATA = $SavedAppData
            $env:PI_CODING_AGENT_DIR = $SavedAgentDir
        }
    }

    Write-Host "Windows installer encoding, parser, manifest resolution, MB display, managed Bash bootstrap, and CMD retry checks passed."
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
