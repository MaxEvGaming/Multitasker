# Pulls the board's nightly copy off the server.
#
# The server keeps fourteen nights of its own, which covers a mistake made
# inside it. It does not cover losing the machine, and the machine is the one
# thing likely to go: it is a Spot instance, and the recovery notes for it say
# to create the database empty. This is the copy that makes that not true.
#
# Two files come across each night:
#   the dump  — the boards themselves
#   the env   — the notification keys. Replace those and every phone that ever
#               registered stops receiving, with nothing to say it has. This is
#               the smaller file and the more painful one to lose.
#
# It speaks HTTPS, not ssh. ssh would mean putting a private key on every
# machine that wants a copy — a key that opens a shell on a server that also
# runs something else — in order to fetch a file. This asks for the file.
#
# Nothing needs installing: Invoke-WebRequest is part of Windows PowerShell.
# Copy this file and backup.json beside each other and it runs.
#
# Register it with Task Scheduler, daily.

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 takes whatever TLS the .NET on that machine defaults
# to, and on an older install that can be a version this server refuses. It
# shows up as a connection that simply fails, which reads like the site being
# down — so it is said outright rather than diagnosed on someone else PC.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12


$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config  = Get-Content (Join-Path $Here 'backup.json') -Raw -Encoding utf8 | ConvertFrom-Json
$Url     = $Config.url
$Token   = $Config.token
$Local   = [Environment]::ExpandEnvironmentVariables($Config.into)
$Keep    = if ($Config.keep) { [int]$Config.keep } else { 30 }
$LogFile = Join-Path $Local 'pull.log'

if (-not (Test-Path $Local)) { New-Item -ItemType Directory -Path $Local -Force | Out-Null }

function Write-Line($text) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -Path $LogFile -Value "$stamp $text" -Encoding utf8
  Write-Output $text
}

# The server names the file it is handing over in a header, so what arrives is
# whatever was made last night rather than a name guessed from a clock here.
function Get-Copy($what) {
  $address = if ($what) { "${Url}?what=$what" } else { $Url }
  $temp = Join-Path $Local ('.partial-' + [guid]::NewGuid().ToString('N'))
  try {
    $response = Invoke-WebRequest -Uri $address -Headers @{ 'X-Backup-Token' = $Token } `
      -TimeoutSec 120 -UseBasicParsing -OutFile $temp -PassThru
    $name = $response.Headers['X-Backup-Name']
    if (-not $name) { throw 'the server did not say which file this is' }

    $to = Join-Path $Local $name
    if (Test-Path $to) {
      Remove-Item $temp -Force
      return $null                              # already have this one
    }
    Move-Item $temp $to
    return $to
  } finally {
    if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
  }
}

try {
  if (-not $Token) { throw 'backup.json has no token' }

  $pulled = 0
  foreach ($what in @($null, 'env')) {
    $file = Get-Copy $what
    if ($file) {
      $size = [math]::Round((Get-Item $file).Length / 1KB, 1)
      Write-Line ("pulled {0} ({1} KB)" -f (Split-Path $file -Leaf), $size)
      $pulled += 1
    }
  }
  if ($pulled -eq 0) { Write-Line 'nothing new tonight' }

  # A month here. These are small, and a fault that goes unnoticed for a couple
  # of weeks is exactly the fault this is for.
  foreach ($pattern in @('taskboard-*.dump', 'env-*')) {
    Get-ChildItem -Path $Local -Filter $pattern |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $Keep |
      ForEach-Object { Remove-Item $_.FullName -Force }
  }
} catch {
  # 404 is what a wrong token looks like, deliberately — the route does not
  # admit to existing. Worth saying so here, because "not found" on a URL that
  # is plainly right sends you looking in the wrong place.
  $hint = if ("$($_.Exception.Message)" -match '404') { ' (a 404 here usually means the token is wrong)' } else { '' }
  Write-Line "FAILED: $($_.Exception.Message)$hint"
  exit 1
}
