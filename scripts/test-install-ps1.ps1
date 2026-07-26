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
            'Invoke-Download',
            'Invoke-JsonRequest',
            'winget install --id Git.Git -e --source winget',
            'https://git-scm.com/download/win',
            '$PSVersionTable.PSVersion.Major -lt 5'
        )) {
            if (!$Source.Contains($Required)) { throw "$Installer is missing: $Required" }
        }
        if ($Source.Contains('Write-Warning "LYStar Agent 需要 Bash')) {
            throw "$Installer must stop before installing an unusable binary when Bash is missing."
        }
    }

    Write-Host "Windows installer encoding, parser, preflight, and retry checks passed."
}
finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
