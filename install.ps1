# Installs a Dori on native Windows (no WSL): bun, herdr, omo, this repository and a `dori` command.
#   irm https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 | iex
# or, from a clone:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Repo URL] [-Branch NAME]
# What stays Linux-only (systemd units, the nft egress gate, dori heavy's scopes, per-account relays, voice setup) is not
# installed; `dori serve --install-task` keeps the Dori's loops running from the Task Scheduler instead of systemd.
param(
  [string]$Repo = $(if ($env:DORI_REPO) { $env:DORI_REPO } else { "https://github.com/orientpine/omo-dori-mode-experimental.git" }),
  [string]$Branch = $(if ($env:DORI_BRANCH) { $env:DORI_BRANCH } else { "main" }),
  [string]$DoriHome = $(Join-Path $env:USERPROFILE ".dori")
)
$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "== $m" }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Native($command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) { throw "$command $arguments failed (exit $LASTEXITCODE)" }
}
function AddUserPath($dir) {
  $p = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($p -split ";" | Where-Object { $_ -eq $dir })) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }
  if (-not ($env:Path -split ";" | Where-Object { $_ -eq $dir })) { $env:Path = "$env:Path;$dir" }
}

Step "bun"
if (-not (Have bun)) { Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression; AddUserPath (Join-Path $env:USERPROFILE ".bun\bin") }
Native "bun" @("--version")

Step "herdr"
if (-not (Have herdr)) { Invoke-RestMethod https://herdr.dev/install.ps1 | Invoke-Expression }
if (-not (Have herdr)) { foreach ($d in @("$env:LOCALAPPDATA\Programs\herdr", "$env:USERPROFILE\.herdr\bin", "$env:USERPROFILE\.local\bin")) { if (Test-Path "$d\herdr.exe") { AddUserPath $d } } }
Native "herdr" @("--version")

Step "omo"
if (-not (Have omo)) {
  $bin = Join-Path $env:USERPROFILE ".omo\bin"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  Invoke-WebRequest "https://github.com/code-yeongyu/oh-my-openagent/releases/latest/download/omo-windows-$arch.exe" -OutFile (Join-Path $bin "omo.exe")
  AddUserPath $bin
}
Native "omo" @("--version")

Step "git and the Dori repository ($Branch)"
if (-not (Have git)) { throw "git is needed: install Git for Windows (winget install Git.Git) and run this again" }
$src = Join-Path $DoriHome "src"
if (Test-Path (Join-Path $src ".git")) {
  Native "git" @("-C", $src, "fetch", "-q", "origin")
  Native "git" @("-C", $src, "checkout", "-q", $Branch)
  Native "git" @("-C", $src, "pull", "-q", "--ff-only")
} else {
  New-Item -ItemType Directory -Force -Path $DoriHome | Out-Null
  Native "git" @("clone", "-q", "--branch", $Branch, $Repo, $src)
}
Push-Location (Join-Path $src "skills\dori-mode\scripts")
try { Native "bun" @("install", "--silent") } finally { Pop-Location }

Step "dori-mode skill"
$skills = if ($env:SKILLS_DIR) { $env:SKILLS_DIR } else { Join-Path $env:USERPROFILE ".agents\skills" }
New-Item -ItemType Directory -Force -Path $skills | Out-Null
$skill = Join-Path $skills "dori-mode"
if (Test-Path -LiteralPath $skill) {
  Write-Host "Keeping existing skill $skill"
} else {
  New-Item -ItemType Junction -Path $skill -Target (Join-Path $src "skills\dori-mode") | Out-Null
}

Step "dori command"
$binDir = Join-Path $DoriHome "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$launcher = Join-Path $binDir "dori.cmd"
Set-Content -Encoding ASCII -Path $launcher -Value @'
@echo off
setlocal
if not defined DORI_CONFIG set "DORI_CONFIG=%~dp0..\config.json"
if not defined DORI_ENV_FILE set "DORI_ENV_FILE=%~dp0..\dori.env"
if not defined DORI_STATE_DIR set "DORI_STATE_DIR=%~dp0..\state"
bun "%~dp0..\src\skills\dori-mode\scripts\src\cli.ts" %*
exit /b %errorlevel%
'@
AddUserPath $binDir

Step "config"
$cfg = Join-Path $DoriHome "config.json"
if (-not (Test-Path $cfg)) {
  $c = Get-Content -Raw (Join-Path $src "skills\dori-mode\references\config.example.json") | ConvertFrom-Json
  $c | Add-Member -Force NoteProperty backend "herdr"
  $c | Add-Member -Force NoteProperty agentCommand @("omo", "--model", "{model}", "{prompt}")
  $c | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $cfg
}
$help = Native $launcher @()
$help | Select-Object -First 1

Write-Host ""
Write-Host "DORI_INSTALLED $src"
Write-Host "Next: put the Discord bot token and channel in $DoriHome\dori.env, open the lead in herdr (herdr, then omo in its first tab),"
Write-Host "set leadPane in $cfg to that pane (herdr pane current), and run: dori serve --install-task"
