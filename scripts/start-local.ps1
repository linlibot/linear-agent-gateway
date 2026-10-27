$ErrorActionPreference = 'Stop'
$linearProjectDir = Split-Path -Parent $PSScriptRoot
$linearRuntimeDir = Join-Path $linearProjectDir '.local-runtime'
$linearPort = if ($env:LINEAR_PORT) { [int]$env:LINEAR_PORT } else { 8089 }
$linearHealthUrl = 'http://127.0.0.1:{0}/health' -f $linearPort
try {
    $linearExisting = Invoke-RestMethod -Uri $linearHealthUrl -TimeoutSec 2
    if ($linearExisting.service -eq 'linear-agent-gateway') {
        Write-Output ('Already running: http://127.0.0.1:{0}/v1' -f $linearPort)
        exit 0
    }
    throw 'This port is occupied by another HTTP service.'
} catch {
    if ($_.Exception.Message -like '*occupied by another*') { throw }
}
New-Item -ItemType Directory -Path $linearRuntimeDir -Force | Out-Null
$linearNode = (Get-Command node -ErrorAction Stop).Source
$linearServerFile = Join-Path $linearProjectDir 'server.mjs'
$linearServerArg = '"{0}"' -f $linearServerFile
$linearProcess = Start-Process -FilePath $linearNode -ArgumentList @('--preserve-symlinks', '--preserve-symlinks-main', $linearServerArg) -WorkingDirectory $linearProjectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $linearRuntimeDir 'stdout.log') -RedirectStandardError (Join-Path $linearRuntimeDir 'stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $linearRuntimeDir 'gateway.pid') -Value $linearProcess.Id -Encoding ascii
for ($linearAttempt = 0; $linearAttempt -lt 20; $linearAttempt++) {
    Start-Sleep -Milliseconds 250
    if ($linearProcess.HasExited) { throw ('Gateway exited. See ' + (Join-Path $linearRuntimeDir 'stderr.log')) }
    try {
        $linearHealth = Invoke-RestMethod -Uri $linearHealthUrl -TimeoutSec 1
        if ($linearHealth.service -eq 'linear-agent-gateway') {
            Write-Output ('Running: http://127.0.0.1:{0}/v1' -f $linearPort)
            Write-Output ('API key file: ' + (Join-Path $linearRuntimeDir 'access.json'))
            exit 0
        }
    } catch { }
}
throw ('Gateway did not become ready. See ' + (Join-Path $linearRuntimeDir 'stderr.log'))
