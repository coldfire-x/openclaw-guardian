param(
  [ValidateSet("foreground", "background")]
  [string]$Mode = "foreground",
  [string]$ConfigPath = "config/config.yaml"
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$HomeStateDir = Join-Path $env:USERPROFILE ".openclaw-guardian"
$EnvScript = Join-Path $HomeStateDir "guardian.env.ps1"
$LogPath = Join-Path $RootDir "service.log"
$ExampleConfig = Join-Path $RootDir "config/config.example.yaml"
$DefaultConfig = Join-Path $RootDir "config/config.yaml"
$Runner = Join-Path $RootDir "scripts/run-guardian.ps1"
$TaskName = "OpenClawGuardian"

if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath = Join-Path $RootDir $ConfigPath
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required"
}

Set-Location $RootDir

Write-Host "[openclaw-guardian] Installing dependencies"
npm install

Write-Host "[openclaw-guardian] Building"
npm run build

if (-not (Test-Path $ConfigPath) -and $ConfigPath -eq $DefaultConfig) {
  Copy-Item $ExampleConfig $ConfigPath
  Write-Host "[openclaw-guardian] Created config/config.yaml from example"
}

if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

New-Item -ItemType Directory -Path $HomeStateDir -Force | Out-Null
if (-not (Test-Path $LogPath)) {
  New-Item -ItemType File -Path $LogPath -Force | Out-Null
}

if (-not (Test-Path $EnvScript)) {
  if ([string]::IsNullOrWhiteSpace($env:OPENCLAW_GUARDIAN_LLM_API_KEY)) {
    @(
      '# openclaw-guardian runtime environment',
      '$env:OPENCLAW_GUARDIAN_LLM_API_KEY=""'
    ) | Set-Content -Path $EnvScript -Encoding UTF8
  } else {
    $escapedKey = $env:OPENCLAW_GUARDIAN_LLM_API_KEY.Replace("`", "``").Replace('"', '`"')
    @(
      '# openclaw-guardian runtime environment',
      ('$env:OPENCLAW_GUARDIAN_LLM_API_KEY="{0}"' -f $escapedKey)
    ) | Set-Content -Path $EnvScript -Encoding UTF8
  }
  Write-Host "[openclaw-guardian] Created $EnvScript"
}

if ($Mode -eq "foreground") {
  Write-Host "[openclaw-guardian] Starting in foreground mode"
  & $Runner -ConfigPath $ConfigPath
  exit $LASTEXITCODE
}

$runCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`" -ConfigPath `"$ConfigPath`""
& schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $runCommand /F | Out-Null
& schtasks.exe /Run /TN $TaskName | Out-Null

Write-Host "[openclaw-guardian] Background task installed and started"
Write-Host "Check status: schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "Set llm.api_key in $ConfigPath (or keep using $EnvScript for env fallback)."
Write-Host "Bind Telegram by sending /bind to your bot."
