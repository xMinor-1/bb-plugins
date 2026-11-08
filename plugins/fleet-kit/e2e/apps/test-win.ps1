# Windows: a standard user (no administrator rights, a non-ASCII name with a space) installs the package with Fleet
# Kit's own code into their folder; then doc-review's own code converts Word and PowerPoint to PDF.
# This part runs as the Actions machine's administrator: it creates the user and runs test-win-user.ps1 as them.
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [Parameter(Mandatory = $true)][string]$Docs,
  [Parameter(Mandatory = $true)][string]$Plugins,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$Root = 'C:\lo-ci'
New-Item -ItemType Directory -Force -Path $Root, $Out | Out-Null
foreach ($item in @(
    @{ From = (Join-Path $Package 'libreoffice-win-x64.zip'); To = 'libreoffice-win-x64.zip' },
    @{ From = $Docs; To = 'docs' },
    @{ From = (Join-Path $Plugins 'fleet-kit\src\host\install-app.ts'); To = 'install-app.ts' },
    @{ From = (Join-Path $Plugins 'doc-review\src\libreoffice.ts'); To = 'libreoffice.ts' },
    @{ From = (Join-Path $PSScriptRoot 'try-install.mjs'); To = 'try-install.mjs' },
    @{ From = (Join-Path $PSScriptRoot 'convert.mjs'); To = 'convert.mjs' },
    @{ From = (Join-Path $PSScriptRoot 'test-win-user.ps1'); To = 'test-win-user.ps1' })) {
  Copy-Item -LiteralPath $item.From -Destination (Join-Path $Root $item.To) -Recurse -Force
}
$node = (Get-Command node.exe).Source
[void](& icacls.exe $Root /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q)
[void](& icacls.exe $Out /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q)
[void](& icacls.exe (Split-Path -Parent $node) /grant '*S-1-5-32-545:(OI)(CI)RX' /T /C /Q)

# 20 characters (the Windows limit) with Cyrillic letters and a space: the longest and least convenient profile path.
$UserName = 'Иван Тестовски Длин1'
$password = 'Aa1!' + [Guid]::NewGuid().ToString('N')
$secure = ConvertTo-SecureString $password -AsPlainText -Force
New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
Add-LocalGroupMember -Group ((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]) -Member $UserName

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\test-win-user.ps1`" -Root `"$Root`" -Node `"$node`" -Out `"$Out`""
$psi.UserName = $UserName
$psi.Domain = $env:COMPUTERNAME
$psi.Password = $secure
$psi.LoadUserProfile = $true
$psi.UseShellExecute = $false
$psi.WorkingDirectory = $Root
$user = [Diagnostics.Process]::Start($psi)
$deadline = (Get-Date).AddMinutes(30)
while (-not $user.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
if (-not $user.HasExited) { try { $user.Kill() } catch {} ; Write-Host 'FAIL  the user part did not finish in 30 minutes' }
$summary = Join-Path $Out 'summary.txt'
if (Test-Path -LiteralPath $summary) { Get-Content -LiteralPath $summary -Encoding UTF8 | Write-Host }

# Nothing on the system: no uninstall entry and no folder in Program Files.
$uninstall = @(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'LibreOffice*' })
$programFiles = Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'LibreOffice')
$clean = $uninstall.Count -eq 0 -and -not $programFiles
Write-Host ("{0}  no LibreOffice uninstall entry and no Program Files folder" -f $(if ($clean) { 'PASS' } else { 'FAIL' }))
if ($user.HasExited -and $user.ExitCode -eq 0 -and $clean) { exit 0 }
exit 1
