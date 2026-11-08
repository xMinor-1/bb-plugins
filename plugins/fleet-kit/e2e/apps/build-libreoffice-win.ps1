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

# The Visual C++ runtime: the MSI leaves it to the system (an unpacked MSI has none), and a laptop without the
# redistributable would not start LibreOffice. Next to the program, app-local, as Microsoft's redist.txt allows:
# the newest Microsoft.VC14x.CRT of this machine's Visual Studio. Files LibreOffice ships itself stay.
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$crt = Get-ChildItem -Path (Join-Path $vs 'VC\Redist\MSVC\*\x64\Microsoft.VC14*.CRT') -Directory | Sort-Object FullName | Select-Object -Last 1
if ($null -eq $crt) { throw 'no Visual C++ runtime in Visual Studio' }
Say "Visual C++ runtime from: $($crt.FullName)"
foreach ($dll in Get-ChildItem -LiteralPath $crt.FullName -Filter '*.dll') {
  $target = Join-Path $dest "program\$($dll.Name)"
  if (Test-Path -LiteralPath $target) { Say "kept LibreOffice's own: $($dll.Name)"; continue }
  Copy-Item -LiteralPath $dll.FullName -Destination $target
  Say "copied to program: $($dll.Name)"
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
