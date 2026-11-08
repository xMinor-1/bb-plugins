# The part of test-win.ps1 that runs as the standard user.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Out
)
# Node writes warnings to stderr, and with Stop Windows PowerShell 5.1 turns them into errors. Exit codes decide.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
$summary = Join-Path $Out 'summary.txt'
$script:Bad = 0
function Say([string]$Text) { [IO.File]::AppendAllText($summary, "$Text`r`n", (New-Object Text.UTF8Encoding $false)) }
function Result([bool]$Ok, [string]$Text) { if ($Ok) { Say "PASS  $Text" } else { $script:Bad++; Say "FAIL  $Text" } }

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Result (-not $isAdmin) "user $($identity.Name) has no administrator rights"

  # As deep as a real build's folder: <build>\runtime\apps\<id>.
  $apps = Join-Path $env:LOCALAPPDATA 'fleet-kit-ci\runtime\apps\libreoffice'
  $installJson = Join-Path $Out 'install.json'
  $installOut = & $Node --no-warnings --experimental-transform-types (Join-Path $Root 'try-install.mjs') (Join-Path $Root 'install-app.ts') (Join-Path $Root 'libreoffice-win-x64.zip') zip 'LibreOffice/program/soffice.exe' $apps $installJson 2>&1
  $code = $LASTEXITCODE
  $installed = $null
  if (Test-Path -LiteralPath $installJson) { $installed = [IO.File]::ReadAllText($installJson, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  Result ($code -eq 0 -and $null -ne $installed) "Fleet Kit installed LibreOffice: $(($installOut | Out-String).Trim())"
  if ($null -eq $installed) { throw 'no install result' }
  $soffice = $installed.path
  Result ($soffice -like "$env:LOCALAPPDATA\*") "in the user's folder: $soffice"

  $pdf = Join-Path $Out 'pdf'
  $convertOut = & $Node --no-warnings --experimental-transform-types (Join-Path $Root 'convert.mjs') (Join-Path $Root 'libreoffice.ts') $soffice (Join-Path $Root 'docs') $pdf 2>&1
  $code = $LASTEXITCODE
  Say (($convertOut | Out-String).Trim())
  Result ($code -eq 0) "doc-review found the program and converted Word and PowerPoint to PDF"
  $size = (Get-ChildItem -LiteralPath $apps -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Say ("on disk: {0:N0} bytes" -f $size)
} catch {
  Result $false "the user part failed: $($_.Exception.Message)"
}
Say "failures: $script:Bad"
if ($script:Bad -gt 0) { exit 1 }
exit 0
