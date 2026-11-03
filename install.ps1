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
if (-not (Have pwsh)) { throw "PowerShell 7.3 or newer (pwsh) is needed: install it (winget install Microsoft.PowerShell) and run this again" }
$binDir = Join-Path $DoriHome "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# A PowerShell launcher, not a .cmd: cmd.exe would read & | < > in the arguments as commands. It fills in this
# installation's config, env file and state only where the caller set none, and puts the caller's variables back after.
$launcher = Join-Path $binDir "dori.ps1"
Set-Content -Encoding UTF8 -Path $launcher -Value @'
#Requires -Version 7.3
$PSNativeCommandArgumentPassing = 'Standard'
$doriHome = Split-Path -Parent $PSScriptRoot
$filled = @()
foreach ($pair in @(@('DORI_CONFIG', 'config.json'), @('DORI_ENV_FILE', 'dori.env'), @('DORI_STATE_DIR', 'state'))) {
  if (-not [Environment]::GetEnvironmentVariable($pair[0])) {
    [Environment]::SetEnvironmentVariable($pair[0], (Join-Path $doriHome $pair[1]))
    $filled += $pair[0]
  }
}
try {
  & bun (Join-Path $doriHome 'src\skills\dori-mode\scripts\src\cli.ts') @args
  $code = $LASTEXITCODE
} finally {
  foreach ($name in $filled) { [Environment]::SetEnvironmentVariable($name, $null) }
}
exit $code
'@
Remove-Item -LiteralPath (Join-Path $binDir "dori.cmd") -ErrorAction SilentlyContinue
AddUserPath $binDir

# PowerShell runs dori.ps1 only when the account allows local scripts. A policy of RemoteSigned or looser is left alone;
# otherwise the installer says what it would change and why and asks, and changes nothing without a yes. A run that
# cannot ask (-NonInteractive) changes nothing either. Without the change Dori still runs through pwsh -File.
Step "script policy for the dori command"
$policies = Get-ExecutionPolicy -List
$policyOf = { param($scope) [string]($policies | Where-Object { $_.Scope -eq $scope }).ExecutionPolicy }
$locked = @("MachinePolicy", "UserPolicy") | Where-Object { (& $policyOf $_) -ne "Undefined" } | Select-Object -First 1
$current = @("MachinePolicy", "UserPolicy", "CurrentUser", "LocalMachine") | ForEach-Object { & $policyOf $_ } | Where-Object { $_ -ne "Undefined" } | Select-Object -First 1
if (-not $current) { $current = "Restricted" }
$fallback = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" <arguments>"
$setCommand = "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
if (@("RemoteSigned", "Unrestricted", "Bypass") -contains $current) {
  Write-Host "EXECUTION_POLICY_OK ${current}: the dori command runs as it is"
} else {
  $canAsk = -not $locked -and -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' })
  $answer = $null
  if ($canAsk) {
    Write-Host "The dori command is a PowerShell script, and this account's script policy is $current, which does not run it."
    Write-Host "Proposed change: $setCommand"
    Write-Host "RemoteSigned runs scripts made on this PC; scripts downloaded from the internet still need a signature. Only your account changes."
    Write-Host -NoNewline "Change it now? [y/N] "
    $answer = [Console]::In.ReadLine()
  }
  if ($answer -match '^\s*(y|yes)\s*$') {
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Write-Host "EXECUTION_POLICY_SET RemoteSigned for CurrentUser"
  } else {
    Write-Host "EXECUTION_POLICY_UNCHANGED $current$(if ($locked) { " (set by $locked; ask your administrator)" })"
    if (-not $locked) { Write-Host "To allow the dori command later: $setCommand" }
    Write-Host "Until then run Dori with: $fallback"
  }
}

Step "config"
$cfg = Join-Path $DoriHome "config.json"
if (-not (Test-Path $cfg)) {
  $c = Get-Content -Raw (Join-Path $src "skills\dori-mode\references\config.example.json") | ConvertFrom-Json
  $c | Add-Member -Force NoteProperty backend "herdr"
  $c | Add-Member -Force NoteProperty agentCommand @("omo", "--model", "{model}", "{prompt}")
  $c | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $cfg
}
$help = Native "pwsh" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher)
$help | Select-Object -First 1

Write-Host ""
Write-Host "DORI_INSTALLED $src"
Write-Host "Next: put the Discord bot token and channel in $DoriHome\dori.env, open the lead in herdr (herdr, then omo in its first tab),"
Write-Host "set leadPane in $cfg to that pane (herdr pane current), and run: dori serve --install-task"
