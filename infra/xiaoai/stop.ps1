$ErrorActionPreference = 'Stop'
$XiaoAiRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$EnvFile = Join-Path $XiaoAiRoot '.env.xiaoai.local'
$ComposeFile = Join-Path $XiaoAiRoot 'docker-compose.yml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or is not on PATH.'
}
if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Missing $EnvFile."
}

& docker compose --env-file $EnvFile -f $ComposeFile down
if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE." }

