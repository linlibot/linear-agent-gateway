$ErrorActionPreference = 'Stop'
$linearProjectDir = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$linearPidFile = Join-Path $linearProjectDir '.local-runtime\gateway.pid'
if (-not (Test-Path -LiteralPath $linearPidFile)) { Write-Output 'No gateway PID file.'; exit 0 }
$linearProcessId = [int](Get-Content -LiteralPath $linearPidFile -Raw).Trim()
$linearProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $linearProcessId)
if (-not $linearProcess) { Write-Output 'Gateway is already stopped.'; exit 0 }
$linearExpectedEntry = Join-Path $linearProjectDir 'server.mjs'
if ($linearProcess.Name -ne 'node.exe' -or -not $linearProcess.CommandLine.Contains($linearExpectedEntry)) { throw 'PID does not belong to this Linear gateway; refusing to stop it.' }
Stop-Process -Id $linearProcessId
Remove-Item -LiteralPath $linearPidFile
Write-Output 'Linear gateway stopped.'
