# Restart MeetPlay API server with env vars loaded from .env (Start-Process
# does NOT inherit .env — set each var in this shell first, then spawn).
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\jpout\.openclaw\workspace\meetplay'

# 1. Kill existing server on :3001
$existing = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $existing) {
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "Killed old server PID $($c.OwningProcess)"
}
Start-Sleep -Milliseconds 800

# 2. Load .env into this shell's env
Get-Content '.env' | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $idx = $line.IndexOf('=')
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) { $value = $value.Substring(1, $value.Length - 2) }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

# 3. Spawn server detached with the same command line pattern as before
$node = 'C:\nvm4w\nodejs\node.exe'
$args = @(
  '--require', 'C:\Users\jpout\.openclaw\workspace\meetplay\server\node_modules\tsx\dist\preflight.cjs',
  '--import', 'file:///C:/Users/jpout/.openclaw/workspace/meetplay/server/node_modules/tsx/dist/loader.mjs',
  'src/index.ts'
)
$stdout = 'C:\Users\jpout\.openclaw\workspace\meetplay\server\server.log'
Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory 'C:\Users\jpout\.openclaw\workspace\meetplay\server' -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError 'C:\Users\jpout\.openclaw\workspace\meetplay\server\server.err.log'
Write-Host 'Server spawning... (logs -> server.log)'

# 4. Wait for listener, report PID
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  $conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    Write-Host "Server UP on :3001 PID $($conn.OwningProcess)"
    exit 0
  }
}
Write-Host 'Server did NOT come up in 15s'
exit 1
