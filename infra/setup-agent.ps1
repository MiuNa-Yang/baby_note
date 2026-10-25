param(
  [int]$BabyId = 0,
  [string]$LocalModel = 'qwen3.5:9b',
  [string]$LocalModelBaseUrl = 'http://127.0.0.1:11434',
  [string]$FallbackModel = 'gpt-5.6-luna'
)

$ErrorActionPreference = 'Stop'
$InfraRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path (Join-Path $InfraRoot '..')).Path
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'babynote-agent'
$CcDataDir = Join-Path $RuntimeRoot 'cc-data'
$CodexHome = Join-Path $RuntimeRoot 'codex-home'
$AgentWorkDir = Join-Path $ProjectRoot 'agent-workspace'
$CcConfigPath = Join-Path $RuntimeRoot 'cc-connect.toml'
$EnvPath = Join-Path $ProjectRoot '.env.agent.local'
$ModelRouterLog = Join-Path $RuntimeRoot 'logs\model-router.log'

if ($BabyId -le 0) {
  $DatabasePath = Join-Path $ProjectRoot 'data\babynote.db'
  $DetectBabyScript = Join-Path $ProjectRoot 'server\agent\detect-baby-id.js'
  $BabyIdText = & node $DetectBabyScript $DatabasePath
  if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($BabyIdText, [ref]$BabyId)) {
    throw 'Could not detect a baby ID from the existing SQLite database. Pass -BabyId explicitly.'
  }
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $CcDataDir, $CodexHome | Out-Null

$TokenSecure = Read-Host 'Weixin ilink token (press Enter if not available yet)' -AsSecureString
$TokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($TokenSecure)
try {
  $WeixinToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($TokenPtr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($TokenPtr)
}
$AllowFrom = Read-Host 'Allowed Weixin user or group ID (use * for initial setup)'
if (-not $AllowFrom) { $AllowFrom = '*' }
$ChatId = Read-Host 'Target Weixin group chat_id (press Enter if not available yet)'
$ManagementToken = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

function TomlPath([string]$Path) {
  return ([System.IO.Path]::GetFullPath($Path)).Replace('\', '/')
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}
function Write-Utf8([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

$CcTemplate = Read-Utf8 (Join-Path $InfraRoot 'cc-connect\config.example.toml')
$CcConfig = $CcTemplate.Replace('__CC_DATA_DIR__', (TomlPath $CcDataDir))
$CcConfig = $CcConfig.Replace('__MANAGEMENT_TOKEN__', $ManagementToken)
$CcConfig = $CcConfig.Replace('__AGENT_WORK_DIR__', (TomlPath $AgentWorkDir))
$CcConfig = $CcConfig.Replace('__CODEX_HOME__', (TomlPath $CodexHome))
$CcConfig = $CcConfig.Replace('__BABYNOTE_ROOT__', (TomlPath $ProjectRoot))
$CcConfig = $CcConfig.Replace('__WEIXIN_TOKEN__', $WeixinToken)
$CcConfig = $CcConfig.Replace('__WEIXIN_ALLOW_FROM__', $AllowFrom)
$CcConfig = $CcConfig.Replace('__WEIXIN_CHAT_ID__', $ChatId)
$CcConfig = $CcConfig.Replace('__LOCAL_MODEL__', $LocalModel)
$CcConfig = $CcConfig.Replace('__LOCAL_MODEL_BASE_URL__', $LocalModelBaseUrl)
$CcConfig = $CcConfig.Replace('__FALLBACK_MODEL__', $FallbackModel)
$CcConfig = $CcConfig.Replace('__MODEL_ROUTER_LOG__', (TomlPath $ModelRouterLog))
$CcConfig = $CcConfig.Replace('BABYNOTE_AGENT_BABY_ID = "3"', "BABYNOTE_AGENT_BABY_ID = `"$BabyId`"")
Write-Utf8 $CcConfigPath $CcConfig

$CodexTemplate = Read-Utf8 (Join-Path $InfraRoot 'codex\config.example.toml')
$CodexConfig = $CodexTemplate.Replace('__BABYNOTE_ROOT__', (TomlPath $ProjectRoot))
$CodexConfig = $CodexConfig.Replace('BABYNOTE_AGENT_BABY_ID = "3"', "BABYNOTE_AGENT_BABY_ID = `"$BabyId`"")
Write-Utf8 (Join-Path $CodexHome 'config.toml') $CodexConfig

$AuthSource = Join-Path $env:USERPROFILE '.codex\auth.json'
if (Test-Path -LiteralPath $AuthSource) {
  Copy-Item -LiteralPath $AuthSource -Destination (Join-Path $CodexHome 'auth.json') -Force
}

$EnvContent = @(
  'CC_CONNECT_MANAGEMENT_URL=http://127.0.0.1:9820'
  "CC_CONNECT_MANAGEMENT_TOKEN=$ManagementToken"
  'CC_CONNECT_PROJECT=babynote-agent'
  "BABYNOTE_AGENT_BABY_ID=$BabyId"
) -join "`r`n"
Set-Content -LiteralPath $EnvPath -Value $EnvContent -Encoding utf8

Write-Output "cc-connect config: $CcConfigPath"
Write-Output "Dedicated Codex home: $CodexHome"
Write-Output "Baby ID: $BabyId"
if ($LocalModel) {
  Write-Output "Model route: Ollama $LocalModel -> $FallbackModel fallback"
} else {
  Write-Output "Model route: $FallbackModel (no local model configured)"
}
if (-not $WeixinToken) {
  $Binary = Join-Path $InfraRoot 'cc-connect\bin\cc-connect.exe'
  Write-Output "Next: & `"$Binary`" weixin setup -config `"$CcConfigPath`" -project babynote-agent"
}
