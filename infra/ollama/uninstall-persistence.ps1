[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$TaskName = 'BabyNote-Ollama-KeepAlive'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "Scheduled task not found: $TaskName"
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed scheduled task: $TaskName"
