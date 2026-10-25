[CmdletBinding()]
param(
  [string]$Model = 'qwen3.5:9b',
  [string]$OllamaHost = 'http://127.0.0.1:11434',
  [int]$CheckIntervalSeconds = 15,
  [int]$WarmupTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$OllamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'babynote-agent'
$LogsDir = Join-Path $RuntimeRoot 'logs'
$LogPath = Join-Path $LogsDir 'ollama-keepalive.log'
$ServerOutPath = Join-Path $LogsDir 'ollama-server.out.log'
$ServerErrPath = Join-Path $LogsDir 'ollama-server.err.log'

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Test-OllamaReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$OllamaHost/api/tags" -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-OllamaServerProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'ollama.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)(^|[\s\"])(serve)([\s\"]|$)' } |
    Select-Object -First 1
}

function Test-ModelLoaded {
  try {
    $state = Invoke-RestMethod -Uri "$OllamaHost/api/ps" -TimeoutSec 3
    return @($state.models | Where-Object { $_.name -eq $Model }).Count -gt 0
  } catch {
    return $false
  }
}

function Warm-Model {
  try {
    $body = @{
      model = $Model
      prompt = 'ping'
      stream = $false
      keep_alive = '24h'
      options = @{ num_predict = 1 }
    } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Method Post -Uri "$OllamaHost/api/generate" -ContentType 'application/json' -Body $body -TimeoutSec $WarmupTimeoutSeconds | Out-Null
    Write-Log "warmed model $Model with keep_alive=24h"
    return $true
  } catch {
    Write-Log "model warmup failed: $($_.Exception.Message)"
    return $false
  }
}

function Start-OllamaServer {
  if (-not (Test-Path -LiteralPath $OllamaExe)) {
    throw "Ollama executable was not found: $OllamaExe"
  }

  # Keep the local runtime deliberately conservative for a single RTX 3090
  # and one voice request at a time.
  $env:OLLAMA_HOST = $OllamaHost
  $env:OLLAMA_KEEP_ALIVE = '24h'
  $env:OLLAMA_NUM_PARALLEL = '1'
  $env:OLLAMA_MAX_LOADED_MODELS = '1'
  $env:OLLAMA_MAX_QUEUE = '128'

  $process = Start-Process -FilePath $OllamaExe -ArgumentList @('serve') `
    -WorkingDirectory (Split-Path -Parent $OllamaExe) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $ServerOutPath -RedirectStandardError $ServerErrPath
  Write-Log "started ollama serve pid=$($process.Id) model=$Model"
}

Write-Log "keepalive started model=$Model host=$OllamaHost"
$warmed = $false

while ($true) {
  if (Test-OllamaReady) {
    if (-not $warmed) {
      if (Test-ModelLoaded) {
        Write-Log "model $Model is already loaded"
        $warmed = $true
      } else {
        $warmed = Warm-Model
      }
    }
    Start-Sleep -Seconds $CheckIntervalSeconds
    continue
  }

  $warmed = $false
  $server = Get-OllamaServerProcess
  if (-not $server) {
    try {
      Start-OllamaServer
    } catch {
      Write-Log "server start failed: $($_.Exception.Message)"
    }
  } else {
    Write-Log "ollama serve pid=$($server.ProcessId) is running but API is not ready"
  }
  Start-Sleep -Seconds 3
}
