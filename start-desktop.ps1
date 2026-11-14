param([switch]$RegisterLogonTask, [string]$NodePath = (Get-Command node -ErrorAction Stop).Source, [string]$CredentialDirectory, [string]$TaskName)
$ErrorActionPreference = 'Stop'
if ($RegisterLogonTask) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $TaskName) { $TaskName = 'AgentBoat-Hands-' + $identity.User.Value }
    $arguments = "-NoProfile -WindowStyle Hidden -File `"$PSCommandPath`" -NodePath `"$NodePath`""
    if ($CredentialDirectory) { $arguments += " -CredentialDirectory `"$CredentialDirectory`"" }
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Registered and started $taskName (interactive logon only)."
} else {
    if ($CredentialDirectory) { $env:HANDS_DESKTOP_DIR = $CredentialDirectory }
    & $NodePath (Join-Path $PSScriptRoot 'desktop-agent.mjs')
    exit $LASTEXITCODE
}
