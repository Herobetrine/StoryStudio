param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8123,
    [string]$DataRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 or newer is required.'
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
try {
    $nodeVersion = [version]$nodeVersionText
}
catch {
    throw "Unable to parse Node.js version '$nodeVersionText'."
}

if ($nodeVersion.Major -lt 20) {
    throw "Node.js 20 or newer is required. Current version: $nodeVersionText."
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'npm is required but npm.cmd was not found.'
}

$shrinkwrapPath = Join-Path $PSScriptRoot 'npm-shrinkwrap.json'
$lockfilePath = Join-Path $PSScriptRoot 'package-lock.json'
$packageJsonPath = Join-Path $PSScriptRoot 'package.json'
$dependencyManifestPath = if (Test-Path -LiteralPath $shrinkwrapPath) {
    $shrinkwrapPath
}
elseif (Test-Path -LiteralPath $lockfilePath) {
    $lockfilePath
}
else {
    $packageJsonPath
}
$dependencyFingerprint = (Get-FileHash -LiteralPath $dependencyManifestPath -Algorithm SHA256).Hash
$dependencyFingerprintPath = Join-Path $PSScriptRoot 'node_modules\.story-studio-dependencies.sha256'

$needsInstall = -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))
if (-not $needsInstall) {
    $installedFingerprint = if (Test-Path -LiteralPath $dependencyFingerprintPath) {
        (Get-Content -LiteralPath $dependencyFingerprintPath -Raw).Trim()
    }
    else {
        ''
    }
    $needsInstall = $installedFingerprint -ne $dependencyFingerprint
    if (-not $needsInstall) {
        & npm.cmd ls --omit=dev --all *> $null
        $needsInstall = $LASTEXITCODE -ne 0
    }
}

if ($needsInstall) {
    $hasLock = (Test-Path -LiteralPath $lockfilePath) -or
        (Test-Path -LiteralPath $shrinkwrapPath)
    if ($hasLock) {
        & npm.cmd ci --omit=dev
        $installLabel = 'npm ci --omit=dev'
    }
    else {
        & npm.cmd install --omit=dev --no-audit --no-fund --package-lock=false
        $installLabel = 'npm install --omit=dev --package-lock=false'
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$installLabel failed with exit code $LASTEXITCODE."
    }
    Set-Content -LiteralPath $dependencyFingerprintPath -Value $dependencyFingerprint -Encoding Ascii -NoNewline
}

$env:PORT = [string]$Port
if ($DataRoot) {
    $env:STORY_STUDIO_DATA_ROOT = [System.IO.Path]::GetFullPath($DataRoot)
}

& npm.cmd start
exit $LASTEXITCODE
