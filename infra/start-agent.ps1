$ErrorActionPreference = 'Stop'
$InfraRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $InfraRoot '..')).Path
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'babynote-agent'
$Binary = Join-Path $InfraRoot 'cc-connect\bin\cc-connect.exe'
$CcConfig = Join-Path $RuntimeRoot 'cc-connect.toml'
$EnvFile = Join-Path $ProjectRoot '.env.agent.local'
$LogsDir = Join-Path $RuntimeRoot 'logs'
$PidFile = Join-Path $RuntimeRoot 'processes.json'

foreach ($required in @($Binary, $CcConfig, $EnvFile)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing runtime file: $required" }
}
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line.Split('=', 2)
  if ($parts.Count -eq 2) { [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process') }
}

$Previous = $null
if (Test-Path -LiteralPath $PidFile) {
  try { $Previous = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json } catch { $Previous = $null }
}

function Get-LivePid($Value) {
  if ($Value -and (Get-Process -Id ([int]$Value) -ErrorAction SilentlyContinue)) { return [int]$Value }
  return $null
}

function Test-WebApi {
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/agent-settings?baby_id=$env:BABYNOTE_AGENT_BABY_ID" -TimeoutSec 3
    return [string]$result.baby_id -eq [string]$env:BABYNOTE_AGENT_BABY_ID
  } catch { return $false }
}

function Test-CcApi {
  try {
    $headers = @{ Authorization = "Bearer $env:CC_CONNECT_MANAGEMENT_TOKEN" }
    $result = Invoke-RestMethod -Uri "$env:CC_CONNECT_MANAGEMENT_URL/api/v1/status" -Headers $headers -TimeoutSec 3
    return [bool]$result.ok
  } catch { return $false }
}

$NodePid = $null
$NodeManaged = $false
if (Test-WebApi) {
  if ($Previous) {
    $NodePid = Get-LivePid $Previous.node_pid
    if ($NodePid) {
      $NodeManaged = if ($null -eq $Previous.node_managed) { $true } else { [bool]$Previous.node_managed }
    }
  }
  Write-Output 'Using the existing BabyNote web service on port 3000.'
} else {
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 3000 is occupied by a process that is not responding as BabyNote.'
  }
  $NodeProcess = Start-Process -FilePath 'node' -ArgumentList @('server/index.js') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogsDir 'babynote.out.log') -RedirectStandardError (Join-Path $LogsDir 'babynote.err.log')
  for ($i = 0; $i -lt 30 -and -not (Test-WebApi); $i++) {
    if ($NodeProcess.HasExited) { throw "BabyNote web service exited. See $LogsDir\babynote.err.log" }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-WebApi)) { throw 'BabyNote web service did not become ready.' }
  $NodePid = $NodeProcess.Id
  $NodeManaged = $true
}

$CcPid = $null
$CcManaged = $false
if (Test-CcApi) {
  if ($Previous) {
    $CcPid = Get-LivePid $Previous.cc_connect_pid
    if ($CcPid) {
      $CcManaged = if ($null -eq $Previous.cc_connect_managed) { $true } else { [bool]$Previous.cc_connect_managed }
    }
  }
  Write-Output 'Using the existing cc-connect service on port 9820.'
} else {
  if (Get-NetTCPConnection -LocalPort 9820 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 9820 is occupied by a process that is not responding as cc-connect.'
  }
  $CcProcess = Start-Process -FilePath $Binary -ArgumentList @('-config', $CcConfig) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogsDir 'cc-connect.out.log') -RedirectStandardError (Join-Path $LogsDir 'cc-connect.err.log')
  for ($i = 0; $i -lt 60 -and -not (Test-CcApi); $i++) {
    if ($CcProcess.HasExited) { throw "cc-connect exited. See $LogsDir\cc-connect.err.log" }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-CcApi)) { throw 'cc-connect did not become ready.' }
  $CcPid = $CcProcess.Id
  $CcManaged = $true
}

@{
  node_pid = $NodePid
  node_managed = $NodeManaged
  cc_connect_pid = $CcPid
  cc_connect_managed = $CcManaged
  started_at = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding utf8

Write-Output 'BabyNote Agent is ready. Web: http://localhost:3000'
