$ErrorActionPreference = 'Stop'
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'babynote-agent'
$PidFile = Join-Path $RuntimeRoot 'processes.json'
if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Output 'No managed BabyNote Agent processes were found.'
  exit 0
}

$Processes = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
$Targets = @(
  @{ Name = 'BabyNote web'; Pid = $Processes.node_pid; Managed = $Processes.node_managed },
  @{ Name = 'cc-connect'; Pid = $Processes.cc_connect_pid; Managed = $Processes.cc_connect_managed }
)

foreach ($Target in $Targets) {
  $Managed = if ($null -eq $Target.Managed) { $true } else { [bool]$Target.Managed }
  if (-not $Managed -or -not $Target.Pid) { continue }
  $Running = Get-Process -Id ([int]$Target.Pid) -ErrorAction SilentlyContinue
  if ($Running) {
    Stop-Process -Id ([int]$Target.Pid)
    Write-Output "Stopped $($Target.Name)."
  }
}

Write-Output 'BabyNote Agent stop completed. Externally managed services were left running.'
