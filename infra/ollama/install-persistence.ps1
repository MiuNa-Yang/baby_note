[CmdletBinding()]
param(
  [string]$Model = 'qwen3.5:9b',
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$ScriptPath = Join-Path $PSScriptRoot 'keep-ollama.ps1'
$OllamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$TaskName = 'BabyNote-Ollama-KeepAlive'
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $OllamaExe)) {
  throw "Ollama executable was not found: $OllamaExe"
}

$actionArgument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`" -Model `"$Model`""
$action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $actionArgument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Keeps the local BabyNote Ollama qwen model available and restarts it after a crash.'

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Output "Registered scheduled task: $TaskName"
Write-Output "Model: $Model"
Write-Output "User: $CurrentUser"

if (-not $SkipStart) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output 'Started the keepalive task for the current session.'
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName,State,Author
