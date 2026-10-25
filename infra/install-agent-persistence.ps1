$ErrorActionPreference = 'Stop'
$Config = Join-Path $PSScriptRoot 'ecosystem.agent.config.cjs'
$Pm2 = (Get-Command pm2.cmd -ErrorAction Stop).Source
$Pm2Processes = (& $Pm2 jlist | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(p=>({name:p.name})))));" | ConvertFrom-Json)
$Managed = @($Pm2Processes | Where-Object { $_.name -eq 'babynote-agent' })
if (-not $Managed.Count) {
  $Binary = (Resolve-Path (Join-Path $PSScriptRoot 'cc-connect/bin/cc-connect.exe')).Path
  $Existing = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Binary }
  if ($Existing) { throw 'cc-connect is already running outside PM2. Stop that instance before installing.' }
}
& $Pm2 startOrReload $Config --only babynote-agent
if ($LASTEXITCODE -ne 0) { throw 'Failed to start Agent under PM2.' }
& $Pm2 save
if ($LASTEXITCODE -ne 0) { throw 'Failed to save PM2 process list.' }
$Startup = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name PM2 -ErrorAction SilentlyContinue
if (-not $Startup.PM2) { throw 'PM2 is saved, but its Windows login startup is missing. Install pm2-windows-startup first.' }
Write-Output 'Agent is managed by PM2 and will resume at Windows login, alongside BabyNote. Crashes restart after 5 seconds.'
