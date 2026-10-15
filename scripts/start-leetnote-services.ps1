# Called only by the local launcher with its registered LeetNote directory.
# Let PostgreSQL finish startup/recovery before starting dependent services.
param([Parameter(Mandatory)][string]$LeetNotePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'leetnote-launcher-lib.ps1')

$projectRoot = Resolve-OpenLeetLeetNotePath -LeetNotePath $LeetNotePath
. (Join-Path $projectRoot 'scripts\postgres.ps1')

if (-not (Test-LeetNotePostgresReady)) {
    Write-Host 'Waiting up to 120 seconds for PostgreSQL startup/recovery...'
    $databaseReady = Start-LeetNotePostgres -TimeoutSeconds 120
    if (-not $databaseReady) {
        throw 'PostgreSQL did not become ready within 120 seconds. Remaining services were not started.'
    }
}

& (Join-Path $projectRoot 'start-all.ps1') -Quiet
