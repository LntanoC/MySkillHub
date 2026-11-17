$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'installers'))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'installers'))
if (-not $outputRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installer directory' }
if (Test-Path -LiteralPath $outputRoot) {
    $dir = Get-Item -LiteralPath $outputRoot -Force
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer directory must not be a link or junction' }
} else { New-Item -ItemType Directory -Path $outputRoot | Out-Null }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools are required.' }
$vsDir = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vsDir) { throw 'C++ build tools were not found.' }
$vcvars = Join-Path $vsDir 'VC\Auxiliary\Build\vcvars64.bat'
$environmentLines = cmd /c "`"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not load the Visual C++ build environment.' }
foreach ($line in $environmentLines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_INCREMENTAL = '0'
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if ($config.productName -ne 'MySkillHub' -or $config.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected app identity or version.' }
$expectedName = "MySkillHub_$($config.version)_x64-setup.exe"
$bundleDir = Join-Path $projectRoot 'src-tauri\target\debug\bundle\nsis'
$generated = Join-Path $bundleDir $expectedName
$started = [DateTime]::UtcNow
Push-Location $projectRoot
try {
    & npm.cmd run tauri -- build --debug --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE; previous installers were kept." }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $generated -PathType Leaf)) { throw "Expected installer was not produced: $generated" }
$file = Get-Item -LiteralPath $generated
if ($file.LastWriteTimeUtc -lt $started.AddSeconds(-2) -or $file.Length -lt 1MB) { throw 'Generated installer is stale or unexpectedly small; previous installers were kept.' }
$stream = [IO.File]::OpenRead($generated)
try { if ($stream.ReadByte() -ne 0x4d -or $stream.ReadByte() -ne 0x5a) { throw 'Generated file is not a Windows executable.' } } finally { $stream.Dispose() }
function Get-Sha256([string] $path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $inputStream = [IO.File]::OpenRead($path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($inputStream))).Replace('-', '') }
    finally { $inputStream.Dispose(); $sha.Dispose() }
}
$hash = Get-Sha256 $generated
$staged = Join-Path $outputRoot ('.myskillhub-staged-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$destination = Join-Path $outputRoot $expectedName
Copy-Item -LiteralPath $generated -Destination $staged
if ((Get-Sha256 $staged) -ne $hash) { throw "Copied installer hash mismatch; temporary file: $staged" }
if (Test-Path -LiteralPath $destination) {
    $previous = Join-Path $outputRoot ('.myskillhub-previous-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::Replace($staged, $destination, $previous)
    Remove-Item -LiteralPath $previous
} else {
    [IO.File]::Move($staged, $destination)
}
# Only this dedicated folder and exact generated installer name pattern are in scope.
Get-ChildItem -LiteralPath $outputRoot -File -Filter 'MySkillHub_*_x64-setup.exe' | Where-Object {
    $_.Name -match '^MySkillHub_\d+\.\d+\.\d+_x64-setup\.exe$' -and $_.FullName -ne $destination -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
} | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
Write-Output "Installer: $destination"
Write-Output "SHA256: $hash"
