# Invoked by the registered openleet-leetnote protocol. No browser-supplied
# command or project path is accepted.
param([Parameter(Mandatory, Position = 0)][string]$LaunchUri)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'leetnote-launcher-lib.ps1')

try {
    # Parameter binding rejects extra arguments before the script executes.
    Invoke-OpenLeetLeetNoteLaunch -LaunchUri $LaunchUri | Out-Null
}
catch {
    try { Write-OpenLeetLauncherLog -Message "ERROR: $($_.Exception.Message)" } catch { }
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
