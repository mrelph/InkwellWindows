<#
  Writes a `<file>.sha256` next to every Inkwell installer / portable build in
  a directory, in `sha256sum` format ("<lowercase hex>  <file name>", UTF-8, no
  BOM, LF). The updater (src-electron/updateRelease.ts parseSha256) reads
  exactly this and requires the file name to match the installer it verifies.

  usage: scripts/release-checksums.ps1 [-Directory release]
#>
param([string]$Directory = 'release')

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$files = Get-ChildItem -LiteralPath $Directory -File |
  Where-Object { $_.Name -match '^Inkwell-(Setup|Portable)-\d+\.\d+\.\d+-(x64|arm64)\.exe$' }
if (-not $files) { throw "No Inkwell-Setup-*/Inkwell-Portable-* executables found in $Directory" }

foreach ($file in $files) {
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText("$($file.FullName).sha256", "$hash  $($file.Name)`n", $utf8)
  Write-Host "$hash  $($file.Name)"
}
