# Builds the PC-side agent: one self-contained exe, the installer around it,
# and the two files the board hands out.
#
#   PowerShell:  .\agent\build.ps1              (from the taskboard directory)
#                .\agent\build.ps1 -SkipInstaller
#
# Output:
#   agent\publish\DeckAgent.exe                 the program (self-contained, single file)
#   agent\publish\DeckAgentSetup.exe            the installer (Inno Setup)
#   public\download\DeckAgentSetup.exe          a copy, where the board serves it from
#   public\download\agent\version.json          {"version": "<csproj Version>", "file": "DeckAgentSetup.exe"}
#
# Needs the .NET 10 SDK. Inno Setup 6.3 or later is needed for the installer
# (%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe or on PATH); without it the
# script says so and stops after the exe. The version is read from
# DeckAgent.csproj and handed to the installer, so there is one place to bump.
param([switch]$SkipInstaller)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Push-Location $here
try {
    $csproj = Get-Content (Join-Path $here 'DeckAgent.csproj') -Raw
    if ($csproj -notmatch '<Version>([0-9]+\.[0-9]+\.[0-9]+)</Version>') { throw 'DeckAgent.csproj has no <Version>x.y.z</Version>' }
    $version = $Matches[1]
    Write-Host "== version $version (DeckAgent.csproj)"

    Write-Host '== dotnet publish (Release, win-x64, self-contained, single file)'
    dotnet publish DeckAgent.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o publish
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
    $exe = Join-Path $here 'publish\DeckAgent.exe'
    if (-not (Test-Path $exe)) { throw "publish finished but $exe is not there" }
    Write-Host ("   {0}  ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))

    if ($SkipInstaller) { Write-Host '== installer skipped (-SkipInstaller)'; return }

    $iscc = $null
    $found = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($found) { $iscc = $found.Source }
    if (-not $iscc) {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
        )
        foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $iscc = $c; break } }
    }
    if (-not $iscc) {
        Write-Host '== Inno Setup (ISCC.exe) was not found; the installer was NOT built.'
        Write-Host '   Install Inno Setup 6.3+ (https://jrsoftware.org/isinfo.php) and run this again,'
        Write-Host '   or hand publish\DeckAgent.exe over as it is - it runs on its own.'
        return
    }
    Write-Host "== ISCC: $iscc"
    # A stale installer must not be mistaken for the new one if ISCC fails.
    $setup = Join-Path $here 'publish\DeckAgentSetup.exe'
    if (Test-Path $setup) { Remove-Item $setup -Force }
    & $iscc "/DMyAppVersion=$version" (Join-Path $here 'installer\DeckAgent.iss')
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path $setup)) { throw "ISCC finished but $setup is not there" }
    Write-Host ("   {0}  ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))

    # Where the board serves them from (src/http.js serveStatic; the exe is in
    # .gitignore, version.json is not). deploy/PRODUCTION.md says when to run this.
    $download = Join-Path $root 'public\download'
    $agentDir = Join-Path $download 'agent'
    New-Item -ItemType Directory -Force $agentDir | Out-Null
    Copy-Item $setup (Join-Path $download 'DeckAgentSetup.exe') -Force
    $manifest = '{"version":"' + $version + '","file":"DeckAgentSetup.exe"}' + "`n"
    [System.IO.File]::WriteAllText((Join-Path $agentDir 'version.json'), $manifest, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("== copied to {0}" -f (Join-Path $download 'DeckAgentSetup.exe'))
    Write-Host ("== wrote  {0}: {1}" -f (Join-Path $agentDir 'version.json'), $manifest.Trim())
}
finally {
    Pop-Location
}
