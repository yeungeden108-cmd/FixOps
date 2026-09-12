param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][string]$EnrollmentToken,
  [string]$InstallDir = "$env:ProgramData\FixOpsAgent"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Recurse -Force packages,apps,package.json,pnpm-workspace.yaml,tsconfig.base.json $InstallDir
Push-Location $InstallDir
corepack enable
pnpm install --ignore-scripts
pnpm --filter @fixops/agent... build
Pop-Location
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "$InstallDir\packages\agent\dist\cli.js" -WorkingDirectory $InstallDir
$launcher = Join-Path $InstallDir "run-agent.cmd"
Set-Content -Path $launcher -Value "@echo off`r`nset AGENT_HOST=127.0.0.1`r`nset AGENT_PORT=4318`r`nset AGENT_ENROLLMENT_TOKEN=$EnrollmentToken`r`nset FIXOPS_PROJECT_ROOT=$ProjectRoot`r`nset FIXOPS_DATA_DIR=$InstallDir\data`r`nnode $InstallDir\packages\agent\dist\cli.js" -Encoding ASCII
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcher`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "FixOps Agent" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "FixOps Agent installed. Docker Desktop must run in WSL2 Linux-container mode."
