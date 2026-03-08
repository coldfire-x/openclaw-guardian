param(
  [string]$ConfigPath = "config/config.yaml"
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StateDir = Join-Path $RootDir ".openclaw-guardian"
$EnvScript = Join-Path $StateDir "guardian.env.ps1"

if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath = Join-Path $RootDir $ConfigPath
}

if (Test-Path $EnvScript) {
  . $EnvScript
}

if ([string]::IsNullOrWhiteSpace($env:OPENCLAW_GUARDIAN_LLM_API_KEY)) {
  throw "OPENCLAW_GUARDIAN_LLM_API_KEY is empty. Set it in $EnvScript or environment."
}

Set-Location $RootDir
node dist/index.js --config $ConfigPath
