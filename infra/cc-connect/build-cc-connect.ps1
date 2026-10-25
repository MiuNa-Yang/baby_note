param(
  [string]$OutputPath = "",
  [string]$SourceMirror = ""
)

$ErrorActionPreference = 'Stop'
$PinnedCommit = 'e3ea0cb50bad4e229fe11570f699be03428215c7'
$BuildTags = @(
  'no_acp', 'no_antigravity', 'no_claudecode', 'no_copilot', 'no_cursor', 'no_devin',
  'no_gemini', 'no_iflow', 'no_kimi', 'no_opencode', 'no_pi', 'no_qoder', 'no_reasonix', 'no_tmux',
  'no_cloud_web', 'no_dingtalk', 'no_discord', 'no_feishu', 'no_googlechat', 'no_line',
  'no_matrix', 'no_max', 'no_qq', 'no_qqbot', 'no_slack', 'no_telegram', 'no_tuitui',
  'no_webex', 'no_wecom', 'no_weibo', 'no_wps_agentspace', 'no_wps_xiezuo', 'no_yuanbao',
  'no_web'
) -join ' '
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchPath = Join-Path $ScriptRoot 'patches\babynote-weixin-agent.patch'
if (-not $OutputPath) {
  $OutputPath = Join-Path $ScriptRoot 'bin\cc-connect.exe'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git is required.'
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw 'Go 1.25 or newer is required to build the patched cc-connect.'
}

$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$SourceDir = Join-Path $TempRoot ("babynote-cc-connect-" + [guid]::NewGuid().ToString('N'))
$ResolvedSource = [System.IO.Path]::GetFullPath($SourceDir)
if (-not $ResolvedSource.StartsWith($TempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The source directory is outside the system temp directory.'
}

function Assert-NativeSuccess([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

try {
  if ($SourceMirror) {
    git clone --no-hardlinks $SourceMirror $SourceDir
    Assert-NativeSuccess 'git clone'
  } else {
    git clone --filter=blob:none https://github.com/chenhg5/cc-connect.git $SourceDir
    Assert-NativeSuccess 'git clone'
  }
  git -C $SourceDir checkout --detach $PinnedCommit
  Assert-NativeSuccess 'git checkout'
  $ActualCommit = (git -C $SourceDir rev-parse HEAD).Trim()
  if ($ActualCommit -ne $PinnedCommit) { throw "Unexpected cc-connect commit: $ActualCommit" }
  git -C $SourceDir apply --check $PatchPath
  Assert-NativeSuccess 'git apply check'
  git -C $SourceDir apply $PatchPath
  Assert-NativeSuccess 'git apply'
  git -C $SourceDir diff --check
  Assert-NativeSuccess 'git diff check'
  Push-Location $SourceDir
  try {
    go test .\agent\codex .\platform\weixin
    Assert-NativeSuccess 'go test'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    go build -tags $BuildTags -o $OutputPath .\cmd\cc-connect
    Assert-NativeSuccess 'go build'
  } finally {
    Pop-Location
  }
  Write-Output "Built pinned cc-connect: $OutputPath"
} finally {
  if (Test-Path -LiteralPath $ResolvedSource) {
    Remove-Item -LiteralPath $ResolvedSource -Recurse -Force
  }
}
