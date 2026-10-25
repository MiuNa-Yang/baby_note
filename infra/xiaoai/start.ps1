param(
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$XiaoAiRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$EnvFile = Join-Path $XiaoAiRoot '.env.xiaoai.local'
$ComposeFile = Join-Path $XiaoAiRoot 'docker-compose.yml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or is not on PATH.'
}
if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Missing $EnvFile. Copy .env.xiaoai.example to .env.xiaoai.local and fill it in."
}
if (-not (Test-Path -LiteralPath (Join-Path $XiaoAiRoot 'mi-voice-agent\.git'))) {
  throw 'The mi-voice-agent source is missing. Run: git clone https://github.com/dz-sh/mi-voice-agent.git infra/xiaoai/mi-voice-agent'
}

$args = @('--env-file', $EnvFile, '-f', $ComposeFile, 'up', '-d')
if (-not $NoBuild) { $args += '--build' }
& docker compose @args
if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE." }

Write-Output 'BabyNote XiaoAI voice gateway is running.'
Write-Output 'Check: docker compose --env-file infra/xiaoai/.env.xiaoai.local -f infra/xiaoai/docker-compose.yml logs -f'

