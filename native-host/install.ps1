# Registers the Event Catalog native-messaging host with Chrome for the current
# user. Run via install.cmd (which sets an execution-policy bypass), or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 <extensionId>
#
# The extension ID is shown on chrome://extensions (Developer mode) under the
# Event Poster Catalog card. It's stable for an unpacked extension as long as
# you keep loading it from the same folder.

param([string]$ExtensionId)

$ErrorActionPreference = "Stop"
$hostName = "com.cameronwills.event_catalog"
$dir = $PSScriptRoot
$manifestPath = Join-Path $dir "$hostName.json"
$batPath = Join-Path $dir "event_catalog_host.bat"

if (-not $ExtensionId) {
  $ExtensionId = Read-Host "Extension ID (from chrome://extensions)"
}
$ExtensionId = $ExtensionId.Trim()
if (-not $ExtensionId) { Write-Error "No extension ID given."; exit 1 }

# Native-messaging host manifest. `path` points at the .bat; `allowed_origins`
# restricts which extension may talk to it.
$manifest = [ordered]@{
  name            = $hostName
  description     = "Starts the Event Catalog local server for the extension."
  path            = $batPath
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

# Write UTF-8 WITHOUT a BOM (Chrome's JSON parser rejects a leading BOM).
$json = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# Point Chrome at the manifest via the per-user registry key.
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath

Write-Host ""
Write-Host "Installed native messaging host:"
Write-Host "  manifest:  $manifestPath"
Write-Host "  host bat:  $batPath"
Write-Host "  extension: $ExtensionId"
Write-Host ""
Write-Host "Reload the extension at chrome://extensions so the nativeMessaging"
Write-Host "permission takes effect, then reopen the side panel."
