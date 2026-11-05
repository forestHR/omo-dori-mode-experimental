# MooDori VPN keep

MooDori works inside the owner's company network through the owner's work PC (Windows, reached over ssh), which joins
it with the Secuway SSL VPN. This keeps that VPN logged in on weekdays 08:00-19:59 KST, so the owner finds it connected
without a UAC prompt, and a dropped VPN comes back by itself.

Only MooDori runs it: it does nothing unless its own config file says `"enabled": true`, and no other Dori installs the
unit. The other Doris' behavior does not change.

## What it does

Every minute inside the window (`days`, `hours`, `timeZone`):

1. Reads the VPN state on the PC: the last line of `%USERPROFILE%\AppData\LocalLow\SecuwaySSLU21\log\sslvpn.log` that
   is a tunnel start (`Initialization Sequence Completed`) or stop (`SIGTERM`), and the number of `SecuwaySSL`
   processes. Up only when that line is a start and the tunnel process runs; else `DOWN` (or `NOLOG` without a log).
2. When not up: starts the Secuway agent (`SecuwayUPort`) through the scheduled task `secuwayTask` if it is not
   running, starts MooDori's Edge through `edgeTask` if its debugging port does not answer, and opens the ssh tunnel
   `127.0.0.1:<cdpPort>` to that port.
3. Logs in on `vpnUrl` through Edge (CDP): the account from `credsCommand`, then the MOTP code (TOTP HMAC-SHA256,
   6 digits, 30 s) from the key in `motpFile`. A secret is typed only into its own field once that field is found,
   emptied and focused, and the field must then hold that many characters; a field that is missing or not focused, a
   page script that throws, a navigation error or a CDP error stops the login before anything else is typed or sent.
   When the login page never appears (the agent check page hangs), it restarts the agent once and tries again; any
   other failure is tried once more.
4. The portal's bookmark page is not yet a recovery: within 30 s (every 5 s) the VPN state from step 1 must read up,
   else the round failed (`RELOGIN OK portal, VPN still down after 30 s`). An up check ends a run of failed rounds.
5. Three failed rounds in a row (`maxFails`; a login that errors counts too) rest 15 minutes (`restMs`), so the
   account is not tried every minute.

`touch /tmp/moodori-vpn-keep.pause` (`pauseFile`) pauses it; remove the file to resume.

Log lines (`~/.dori/vpn-keep.log`): `VPN_KEEP_ON ...` at start, `DOWN` / `NOLOG`, `AGENT_RESTART`,
`RELOGIN OK|OK portal, VPN still down ...|FAIL ...|no cert ...|no otp field|ERR ...`, `GIVEUP after 3 fails, resting 15 min`, `ERR ...`. `VPN_KEEP_OFF` (exit 0)
when off, `VPN_KEEP_CONFIG_BAD` (exit 2) for an enabled config with a missing or wrong value. Neither the account nor
the MOTP key or code is ever printed.

## Config

`~/.dori/vpn-keep.json` (`DORI_VPN_KEEP_CONFIG`, in the environment or `dori.env`, names another file), mode 0600.
It is read again before every check, so a change or `"enabled": false` takes effect at the next check (after a
running 15 minute rest). See `config.example.json`. The company
VPN address, the PC's address and the account's source live only here, never in the repository.

| Key | Meaning | Default |
|---|---|---|
| `enabled` | must be `true`, else off | - |
| `pcSsh` | ssh destination of the owner's PC (key login, `BatchMode`) | required |
| `vpnUrl` | the VPN portal's login page | required |
| `credsCommand` | argv whose stdout is the VPN id, a newline, the password | required |
| `motpFile` | JSON `{"secret": "<hex>"}` with the MOTP key (`~/` allowed) | required |
| `secuwayTask`, `edgeTask` | scheduled task names on the PC | `moodori-secuway`, `moodori-edge` |
| `edgePort`, `cdpPort` | Edge's debugging port on the PC, local tunnel port | `9222`, `9224` |
| `days`, `hours`, `timeZone` | window: weekdays (0 = Sunday), `[from, to)` hours | `[1..5]`, `[8, 20]`, `Asia/Seoul` |
| `intervalMs`, `maxFails`, `restMs` | check interval, failed rounds before resting, rest | `60000`, `3`, `900000` |
| `pauseFile` | pause while this file exists | `/tmp/moodori-vpn-keep.pause` |

Secrets stay in their files: `motpFile` (mode 0600) and wherever `credsCommand` reads the account. Neither is copied
into the config, the log or the repository.

## Install on the owner's PC (once, as the owner, in an elevated PowerShell)

The agent must run elevated: started with normal rights it either exits (`0x800710E4`) or shows the owner a UAC
prompt. A scheduled task with the highest run level starts it elevated without a prompt. Both tasks run in the owner's
interactive session, so the VPN and the browser are the owner's.

```powershell
$user = "$env:USERDOMAIN\$env:USERNAME"
$agent = (Get-ChildItem 'C:\Program Files*' -Recurse -Filter SecuwayUPort.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName moodori-secuway -Action (New-ScheduledTaskAction -Execute $agent -Argument '"secuwizu21:1"') -Principal $p -Settings $s -Force

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$pl = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName moodori-edge -Action (New-ScheduledTaskAction -Execute $edge -Argument "--remote-debugging-port=9222 --user-data-dir=`"$env:LOCALAPPDATA\moodori-edge`"") -Principal $pl -Settings $s -Force
```

Check: `Start-ScheduledTask -TaskName moodori-secuway` brings up `SecuwayUPort` with no UAC prompt;
`(Get-ScheduledTask moodori-secuway).Principal.RunLevel` is `Highest`. Over ssh (`pcSsh`, the owner's account by key)
MooDori only starts these tasks (`Start-ScheduledTask`) and stops `SecuwayUPort`; the ssh session needs no elevation.

## Install on MooDori's host (as MooDori)

```sh
install -m 600 /dev/null ~/.dori/vpn-keep.json   # then fill it from config.example.json
bun ~/.dori/src/skills/dori-mode/setups/moodori-vpn-keep/keep.ts --once   # one check; prints VPN_KEEP_ON and what it did
systemctl --user stop moodori-vpn-keep 2>/dev/null   # a transient unit of the same name (systemd-run) must go first
cp ~/.dori/src/skills/dori-mode/setups/moodori-vpn-keep/systemd/moodori-vpn-keep.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now moodori-vpn-keep
tail -f ~/.dori/vpn-keep.log
```

Roll back: `systemctl --user disable --now moodori-vpn-keep` (or set `"enabled": false`: at its next check the
running keep prints `VPN_KEEP_OFF`, exits 0 and the unit stays stopped).

## Known limits

- The automatic path (relogin after a real drop, including the agent restart) has not yet run on a real disconnect.
  On 2026-11-05 12:15 KST a drop was recovered by hand the same way: the agent restarted through the elevated task,
  then the MOTP login.
- The company portal's own SSO login is not renewed; only the VPN is.
