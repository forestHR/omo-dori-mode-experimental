# Native Windows installation and supervision

This setup adds installation, skill discovery, `dori serve` and Task Scheduler to the native process/session support in the preceding Windows change. It does not install systemd units, Unix shell wrappers, nftables rules or Linux resource scopes.

Herdr panes must use **pwsh 7.3 or newer**, not Windows PowerShell 5.1. Point herdr's shell setting at the installed `pwsh.exe`. Dori checks the actual pane shell and version and refuses unsupported shells with `HERDR_SHELL_UNSUPPORTED`; standard native argument passing preserves empty arguments and embedded quotes.

Lead and lane handovers freeze the old agent on Windows too: `NtSuspendProcess` / `NtResumeProcess` through `bun:ffi`, the agent once and then its children, thawed children first. Process discovery reports an agent whose threads are all suspended as stopped (`Get-Process` thread states; `Win32_Process` shows no suspension), so a send during a handover types neither text nor Enter, also from another invocation before the replacement record exists. A handover that must run detached from the agent it freezes is refused on Windows for now (`HANDOVER_DETACH_UNSUPPORTED`): the lead's handover from its own pane, automatic rollovers, the resume after a lane marks ready, and the audit after a commit. Run `dori handover` or `dori handover --lane <key>` from another herdr pane instead.

## Install

From a checkout of the branch you want to install:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Branch (git branch --show-current)
```

The installer checks every native command's exit code. It installs missing bun, herdr and omo dependencies, clones or updates the selected branch, installs the CLI dependencies, and creates the PowerShell launcher `dori.ps1` under `%USERPROFILE%\.dori\bin` (it needs pwsh 7.3 or newer). A `.cmd` launcher is not used: cmd.exe reads `&`, `|`, `<` and `>` in arguments as commands.

PowerShell runs `dori.ps1` only when the account's script policy allows local scripts. If it is already RemoteSigned or looser, the installer leaves it alone. Otherwise it shows the change (`Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`) and why, and asks; it changes the policy only on a yes. On a no, or when it cannot ask (`-NonInteractive`), it changes nothing, prints that command, and finishes the install; until the policy allows it, run Dori with `pwsh -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.dori\bin\dori.ps1" <arguments>`.

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
dori serve --only watch --only dead-panes --log C:\dori-logs\serve.log
```

The log directory is prepared and checked before a child starts. Each loop's output is tagged, and a loop that exits is restarted with bounded backoff. Each loop starts with the environment of the instance `serve` selected. The host guard is not among the loops on Windows: its sampler reads load, memory and disk with Unix tools.

For logon startup:

```powershell
dori serve --install-task
```

This registers the limited-privilege task `Dori serve` with a logon trigger for the current user only (no elevation needed), `ExecutionTimeLimit=PT0S` (no execution timeout), and battery power allowed both to start it and to keep it running. Its generated entry point preserves the selected configuration, environment-file and state paths. Registering it again updates that task to the currently selected instance.

Lane checkpoints (`dori checkpoint`) are refused on native Windows for now: the journal's durability flushes need handles Windows cannot flush, so the step is refused before anything is written. The cost-record lock that closing a lane takes works natively.

Hooks in `config.json` that name `dori` (for example `threadReply`) run this CLI with Bun directly on Windows, since Bun cannot start `dori.ps1`; a close whose `threadReply` hook fails is logged as `CLOSE_SUMMARY_NOT_SENT` and the lane stays open. `dori serve --install-task` refuses `--only` and `--log`: the task always runs every loop with the default log.

## Manual Windows validation

There are no automatic push or PR checks. From this repository, run the workflow by hand:

```sh
gh workflow run windows.yml -R orientpine/omo-dori-mode-experimental --ref <branch>
```

The suite executes native PowerShell quoting, process/session discovery, handover freeze and thaw, installer and launcher behavior, real agent skill discovery from outside the checkout, and registered Task Scheduler settings. POSIX fixtures remain in the full Linux suite.
