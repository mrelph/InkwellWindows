<#
  Local equivalent of .github/workflows/release.yml.

    scripts/release.ps1 0.2.0            bump package.json, typecheck, test, package
                                         x64 + arm64 + portable, write checksums,
                                         commit + tag v0.2.0, push, gh release create
    scripts/release.ps1 0.2.0 -DryRun    everything local up to the checksums; no
                                         commit, tag, push or release (package.json
                                         is put back)

  NOTE: pushing the tag also triggers the CI workflow, which would try to create
  the same Release. Use this script for -DryRun checks or when CI is disabled.

  Needs: pnpm via corepack, and for a real release a logged-in `gh`, a clean
  `main`, and push access. Normally prefer pushing the tag and letting CI do it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$DryRun,
  [string]$Repo = 'mrelph/InkwellWindows'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'version must look like 1.2.3' }
$tag = "v$Version"

$package = Get-Content package.json -Raw
$previous = ($package | ConvertFrom-Json).version
if ([version]$Version -lt [version]$previous) { throw "$Version is older than $previous" }

if (-not $DryRun) {
  if ((git branch --show-current) -ne 'main') { throw 'release from main' }
  if (git status --porcelain) { throw 'working tree is not clean' }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh (GitHub CLI) is not installed' }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { throw 'gh is not logged in (gh auth login)' }
}

try {
  $updated = [regex]::Replace($package, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 1)
  [System.IO.File]::WriteAllText((Resolve-Path package.json), $updated, (New-Object System.Text.UTF8Encoding($false)))

  corepack pnpm typecheck; if ($LASTEXITCODE) { throw 'typecheck failed' }
  corepack pnpm test; if ($LASTEXITCODE) { throw 'tests failed' }
  Remove-Item release -Recurse -Force -ErrorAction SilentlyContinue
  corepack pnpm package:windows; if ($LASTEXITCODE) { throw 'x64 package failed' }
  corepack pnpm package:windows:arm64; if ($LASTEXITCODE) { throw 'arm64 package failed' }
  corepack pnpm package:windows:portable; if ($LASTEXITCODE) { throw 'portable package failed' }
  & "$PSScriptRoot\release-checksums.ps1" -Directory release

  $assets = Get-ChildItem release -File |
    Where-Object { $_.Name -match '^Inkwell-(Setup|Portable)-.*\.exe(\.sha256)?$' } |
    ForEach-Object { $_.FullName }

  if ($DryRun) {
    Write-Host "Dry run: would commit, tag $tag, push, and: gh release create $tag <$($assets.Count) assets>"
    return
  }

  git add package.json
  git commit -m "Release $tag"
  git tag $tag
  git push origin main $tag
  gh release create $tag @assets --repo $Repo --verify-tag --title "Inkwell $tag" --generate-notes --latest
  Write-Host "Released ${tag}: https://github.com/$Repo/releases/tag/$tag"
}
finally {
  if ($DryRun) { [System.IO.File]::WriteAllText((Resolve-Path package.json), $package, (New-Object System.Text.UTF8Encoding($false))) }
}
