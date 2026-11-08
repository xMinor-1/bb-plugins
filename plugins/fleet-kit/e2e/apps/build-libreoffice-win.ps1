# LibreOffice for Windows without an installer: the official MSI is unpacked with an administrative install
# (msiexec /a: it extracts files and writes nothing to the system) and zipped with its LibreOffice folder.
# Runs on a GitHub Actions Windows machine (.github/workflows/fleet-kit-apps.yml); the person's machine needs no msiexec.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$versions = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'versions.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$win = $versions.'win-x64'
$work = 'C:\lo-build'
New-Item -ItemType Directory -Force -Path $work, $Out | Out-Null
$report = Join-Path $Out 'build.txt'
function Say([string]$Text) { Write-Host $Text; [IO.File]::AppendAllText($report, "$Text`r`n", (New-Object Text.UTF8Encoding $false)) }

$msi = Join-Path $work 'LibreOffice.msi'
Invoke-WebRequest -UseBasicParsing -Uri $win.url -OutFile $msi
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
if ($hash -ne $win.sha256) { throw "the MSI does not match versions.json: $hash" }
Say "MSI $($versions.version): sha256 matches"

$admin = Join-Path $work 'admin'
$log = Join-Path $Out 'msiexec.log'
$msiexec = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$admin`"", '/L*v', "`"$log`"") -Wait -PassThru
if ($msiexec.ExitCode -ne 0) { throw "msiexec /a ended with code $($msiexec.ExitCode)" }

$soffice = Get-ChildItem -LiteralPath $admin -Recurse -Filter 'soffice.exe' | Select-Object -First 1
if ($null -eq $soffice) { throw 'no soffice.exe in the unpacked MSI' }
$root = $soffice.Directory.Parent.FullName
Say "program root in the MSI: $($root.Substring($admin.Length))"

$stage = Join-Path $work 'stage'
$dest = Join-Path $stage 'LibreOffice'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath $root -Destination $dest -Recurse
Get-ChildItem -LiteralPath $dest -Recurse -Filter '*.msi' | Remove-Item -Force

# The Visual C++ runtime: the MSI installs it to System32, so unpacked it lands in a folder of its own. Next to the
# program it lets LibreOffice start on a machine without the redistributable.
foreach ($name in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') {
  $target = Join-Path $dest "program\$name"
  if (Test-Path -LiteralPath $target) { Say "already in program: $name"; continue }
  $found = Get-ChildItem -LiteralPath $admin -Recurse -Filter $name | Where-Object { $_.FullName -notlike "$root*" } | Select-Object -First 1
  if ($null -ne $found) { Copy-Item -LiteralPath $found.FullName -Destination $target; Say "copied to program: $name (from $($found.FullName.Substring($admin.Length)))" }
  else { Say "WARNING: no $name in the MSI" }
}

$zip = Join-Path $Out 'libreoffice-win-x64.zip'
& (Join-Path $env:SystemRoot 'System32\tar.exe') -a -c -f $zip -C $stage 'LibreOffice'
if ($LASTEXITCODE -ne 0) { throw "tar ended with code $LASTEXITCODE" }
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $Out 'libreoffice-win-x64.zip.sha256'), "$zipHash  libreoffice-win-x64.zip`n", (New-Object Text.UTF8Encoding $false))
$files = @(Get-ChildItem -LiteralPath $dest -Recurse -File)
$size = ($files | Measure-Object -Property Length -Sum).Sum
Say ("zip: {0:N0} bytes, sha256 {1}; {2} files inside, {3:N0} bytes" -f (Get-Item -LiteralPath $zip).Length, $zipHash, $files.Count, $size)
Say ("longest path inside: {0} characters" -f (($files | ForEach-Object { $_.FullName.Length - $stage.Length } | Measure-Object -Maximum).Maximum))
