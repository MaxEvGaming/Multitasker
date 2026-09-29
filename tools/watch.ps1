# Watches the task board from outside it.
#
# The board's whole job is to break a silence — to tell you a session is waiting
# rather than leaving you to notice. Which means its own failure looks exactly
# like everything being fine: no notifications, because nothing is running to
# send them. Nothing inside the board can report that, so this sits outside.
#
# Runs on the PC: no hosting to pay for, and the only thing it sends anywhere is
# "the board is not answering". Note what that message does NOT contain — no
# task names, no session names, nothing from any board. Slack was ruled out for
# carrying those, and it still is; this carries none of them.
#
# Slack is the only place it speaks. If Slack itself cannot be reached, the log
# beside this script is the only record — which is the right order, since a
# network bad enough to hide Slack would hide the board too.
#
# The settings live in watch.json beside this file, so the Slack address is not
# written into a script that gets read over someone's shoulder.
#
# Register it with Task Scheduler, every 5 minutes.

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 takes whatever TLS the .NET on that machine defaults
# to, and on an older install that can be a version this server refuses. It
# shows up as a connection that simply fails, which reads like the site being
# down — so it is said outright rather than diagnosed on someone else PC.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12


$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
# -Encoding utf8 も同じ理由で要る: 既定は ANSI で、日本語が化ける。
$Config   = Get-Content (Join-Path $Here 'watch.json') -Raw -Encoding utf8 | ConvertFrom-Json
$Url      = $Config.url
$Slack    = $Config.slack
$StateDir = Join-Path $env:LOCALAPPDATA 'taskboard-watch'
$LogFile  = Join-Path $StateDir 'watch.log'
$FailFile = Join-Path $StateDir 'failures'

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }

function Write-Line($text) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -Path $LogFile -Value "$stamp $text" -Encoding utf8
}

function Send-Slack($text) {
  if (-not $Slack) { return }
  try {
    $body = @{ text = $text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $Slack -Method Post -ContentType 'application/json' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
  } catch {
    # If Slack is unreachable too, the log is the only place left to say so.
    Write-Line "slack refused: $($_.Exception.Message)"
  }
}

$previousFailures = 0
if (Test-Path $FailFile) { $previousFailures = [int](Get-Content $FailFile -Raw).Trim() }

$alive = $false
$why = ''
try {
  # Thirty rather than fifteen: the first web request in a fresh PowerShell
  # process pays for setting up TLS, and a healthy board was seen taking longer
  # than fifteen seconds to answer because of it. A slow answer is not a dead
  # board, and the two-in-a-row rule below is not there to paper over this.
  $response = Invoke-WebRequest -Uri $Url -TimeoutSec 30 -UseBasicParsing
  $alive = ($response.StatusCode -eq 200) -and ($response.Content -match '"ok"\s*:\s*true')
  if (-not $alive) { $why = "status $($response.StatusCode)" }
} catch {
  $why = $_.Exception.Message
}

if ($alive) {
  # Only worth saying when it is news. A message every five minutes forever is
  # a channel nobody reads.
  if ($previousFailures -ge 2) {
    Write-Line 'back up'
    Send-Slack ':white_check_mark: *タスクボードが復帰しました* — 通知は再び届きます。'
  }
  Set-Content -Path $FailFile -Value '0' -Encoding ascii
  exit 0
}

$failures = $previousFailures + 1
Set-Content -Path $FailFile -Value $failures -Encoding ascii
Write-Line "no answer ($failures): $why"

# Two in a row before saying anything: one missed check is a dropped packet or a
# deploy restarting, and crying wolf at those trains you to ignore it.
if ($failures -eq 2) {
  Send-Slack ":rotating_light: *タスクボードが応答しません* — 手を止めたセッションの通知が携帯に届きません。`n$Url"
}

# Then hourly, rather than every five minutes.
if ($failures -gt 2 -and ($failures % 12) -eq 0) {
  $hours = [int]($failures * 5 / 60)
  Send-Slack ":rotating_light: *タスクボードはまだ落ちています* — 約 $hours 時間、応答がありません。"
}

exit 1
