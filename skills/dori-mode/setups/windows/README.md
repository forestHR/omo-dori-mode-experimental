# Native Windows installation and supervision

This setup adds installation, skill discovery, `dori serve` and Task Scheduler to the native process/session support in the preceding Windows change. It does not install systemd units, Unix shell wrappers, nftables rules or Linux resource scopes.

Herdr panes must use **pwsh 7.3 or newer**, not Windows PowerShell 5.1. Point herdr's shell setting at the installed `pwsh.exe`. Dori checks the actual pane shell and version and refuses unsupported shells with `HERDR_SHELL_UNSUPPORTED`; standard native argument passing preserves empty arguments and embedded quotes.

Windows freeze, thaw and handover are not supported yet. They refuse without changing processes or records. Close the old lane and use `dori launch` to create a replacement instead. For a lead, open a new herdr pane, start `omo`, and update `leadPane` in the configuration.

## Install

From a checkout of the branch you want to install:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Branch (git branch --show-current)
```

The installer checks every native command's exit code. It installs missing bun, herdr and omo dependencies, clones or updates the selected branch, installs the CLI dependencies, and creates a Unicode-safe `dori.cmd` under `%USERPROFILE%\.dori\bin`.

The `dori-mode` skill is registered with a directory junction under `%USERPROFILE%\.agents\skills`, so agents discover it outside the checkout. An existing `dori-mode` directory or working link is kept. If your agent uses another skill search directory, set `SKILLS_DIR` to that configured directory before installing:

```powershell
$env:SKILLS_DIR = Join-Path $env:USERPROFILE "my-agent\skills"
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Branch (git branch --show-current)
```

`-Repo`, `-Branch` and `-DoriHome` select the repository, branch and installation root. Existing configuration is preserved. The launcher supplies its installation's `config.json`, `dori.env` and `state` only when `DORI_CONFIG`, `DORI_ENV_FILE` and `DORI_STATE_DIR`, respectively, are unset. Explicit instance overrides keep working:

```powershell
$env:DORI_CONFIG = "C:\dori-instances\work\config.json"
$env:DORI_ENV_FILE = "C:\dori-instances\work\dori.env"
$env:DORI_STATE_DIR = "C:\dori-instances\work\state"
dori lead
```

Configure the bot token and channel in the selected environment file, open the lead in herdr, and set `leadPane` in the selected configuration to its pane ID.

## Keep the loops running

```powershell
dori serve
dori serve --only guard --only dead-panes --log C:\dori-logs\serve.log
```

The log directory is prepared and checked before a child starts. Each loop's output is tagged, and a loop that exits is restarted with bounded backoff.

For logon startup:

```powershell
dori serve --install-task
```

This registers the limited-privilege task `Dori serve` with `ExecutionTimeLimit=PT0S` (no execution timeout). Its generated entry point preserves the selected configuration, environment-file and state paths. Registering it again updates that task to the currently selected instance.

## Manual Windows validation

There are no automatic push or PR checks. From this repository, run the workflow by hand:

```sh
gh workflow run windows.yml -R orientpine/omo-dori-mode-experimental --ref feat/herdr-windows-serve
```

The suite executes native PowerShell quoting, process/session discovery, handover refusals, installer and launcher behavior, real agent skill discovery from outside the checkout, and registered Task Scheduler settings. POSIX fixtures remain in the full Linux suite.
