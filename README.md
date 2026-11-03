**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omo-dori-mode-experimental

Dori mode turns one coding-agent session into an always-on messenger agent. You talk to a single bot on Telegram or Discord. The Dori hands each job to its own agent session in a herdr tab or an aoe/tmux session, keeps track of every session it started, and only closes one after the work is actually done: the PR merged, the issue closed, the version published.

It ships as a skill (`skills/dori-mode/SKILL.md` plus references) and a small bun + TypeScript CLI called `dori`. Experimental: expect rough edges.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | bash
```

This clones the repo to `~/.dori/src`, links the skill into `~/.agents/skills/dori-mode`, puts `dori` on your PATH with `bun link`, and copies an example config to `~/.dori/config.json`. Set `SKILLS_DIR` if your agent loads skills from somewhere else.

The default backend is herdr. For aoe/tmux:

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | DORI_BACKEND=aoe bash
```

`DORI_BACKEND=aoe` copies a config with `backend: "aoe"` when no config exists; an existing config is kept, including its backend. Set `leadPane` to the lead's aoe/tmux session name. `DORI_REPO` overrides the clone URL. The installer warns when neither herdr nor aoe + tmux is on PATH; missing `gh` and `agent-messenger` are optional warnings. If an existing install's origin is not the fork (or your `DORI_REPO` override), it warns and shows the command to repoint it, without silently changing the remote or pulling from the old origin. When local changes or local commits in an existing checkout block `git pull --ff-only`, it stops (exit 1), names the checkout and lists that work, and gives both ways on: `DORI_NO_PULL=1` installs the checkout as it is without pulling, or drop the work with `git -C <checkout> fetch && git -C <checkout> reset --hard '@{u}'` and run it again. A branch that follows no upstream (or a detached HEAD) gets the command to follow `origin/main` again instead of the reset. `DORI_NO_PULL` takes `1`, `true`, `yes` or `on` to skip the pull and `0`, `false`, `no` or `off` to pull; any other value stops the install rather than pulling quietly.

Then open your agent inside herdr, or inside an aoe session for the aoe backend, and say "Dori mode". The complete Discord + aoe/tmux service setup is in [`setups/discord-aoe`](skills/dori-mode/setups/discord-aoe/README.md). Lessons from running a Dori day to day (a done claim closes the lane, pausing a lane that waits on the owner, applying script updates, swapping a listener through a shadow run) are in [`references/operating-lessons.md`](skills/dori-mode/references/operating-lessons.md).

## Requirements

For native Windows installation, skill registration and `dori serve`, follow the [Windows setup guide](skills/dori-mode/setups/windows/README.md).

- [bun](https://bun.sh) 1.3 or newer, and git
- either [herdr](https://herdr.dev) for lane tabs, or [agent-of-empires (aoe)](https://github.com/njbrake/agent-of-empires) and `tmux` for lane sessions
- a coding agent that loads skills (built for [OmO](https://github.com/code-yeongyu/oh-my-openagent); the agent command is configurable)
- `gh` (the GitHub CLI) for checking merged PRs and closed issues; `npm` for published versions
- [agent-messenger](https://github.com/agent-messenger/agent-messenger) for the bot itself

macOS gets the full host guard. On Linux, load and disk work, and memory and swap read as unknown.

## Naming your Dori

The first thing a Dori does is ask you what it should be called. "Dori" is fine. So is a name that ends in Dori, like ShipDori or WorkDori, which helps when you run more than one. It uses that name for the bot, for how it signs off, and for the mode, so next time "ShipDori mode" is all you have to say.

## Using Slack

If you pick Slack, the Dori asks one more question and waits for your answer:

- **User token**: it acts as a real member of your workspace. That takes a paid seat, which you pay for. It reads everything that member can see and can keep a green online dot.
- **Bot token**: it's a Slack app. There's no seat cost, but it only sees channels it's invited to, within the scopes you gave the app.

## How the Dori writes

It talks the way you do. If you write short, casual and lowercase, it answers short, casual and lowercase. Messages use words, not emojis; Discord status marks can use emojis when `discord.statusStyle` is `"emoji"`, and the listener uses an eyes reaction as a read receipt, which it takes off again once the bot writes back in that channel or thread. When a reply has several parts, it sends a few short messages instead of one long block, each sent as soon as it's ready, with no artificial pauses. A single status that keeps changing is the exception: that stays one message, edited in place.

## Configuration

Everything lives in `~/.dori/config.json`, and every field is optional. The ones you will want to set:

| Field | What it is |
|---|---|
| `backend` | `"herdr"` (default) or `"aoe"` |
| `leadPane` | your Dori's own herdr pane (`herdr pane current`), or its tmux session name with aoe (`tmux display-message -p '#S'`). Lanes report here. |
| `laneWorkspace` | the herdr workspace new lane tabs open in; unused with aoe |
| `ignorePanes`, `workspaces` | panes to skip and workspace filters; with aoe use tmux session names and profile names (or leave `workspaces` empty) |
| `defaultCwd` | where lanes start, and the repo whose worktrees they own |
| `agentCommand` | how to start an agent, as an argv list with `{model}` and `{prompt}` |
| `hooks.threadReply`, `hooks.threadDone` | your messenger CLI, as argv lists with `{thread}` and `{text}`, so lanes can post progress and be marked done |
| `discord.statusStyle` | `"words"` (default) or `"emoji"` for Discord status marks |
| `discord.autoUnEye` | `true` (default): `dori inbound discord` removes its eyes reaction from the owner's earlier messages once the bot writes in that channel or thread; `false` leaves it on |
| `discord.callNames` | `[]` (default). The names the owner calls this Dori by, e.g. `["짱돌", "짱도리", "ZzangDori"]`. If the owner posts in the pair channel without one of these names, without mentioning this Dori's bot or role, and without replying to its post, this Dori loses its eyes on that message as soon as another Dori replies to it or links it. Empty: those eyes stay until this Dori writes there |
| `discord.quietText`, `discord.postRawReports` | what `freshness` posts in the owner's thread (`{min}` = minutes since the last report), in the owner's language; the lane's own report goes to the lead, not the thread. `postRawReports: true` (default `false`) posts it as it is. A close posts the lane's summary for the owner (`claim-done --summary`, else one a model writes) before it marks the thread done, and does not close without one |

The rest (timings, thresholds, heavy-slot count) has sensible defaults. The full table is in [`references/scripts.md`](skills/dori-mode/references/scripts.md). `DORI_CONFIG`, `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

### Opening an aoe/tmux lane

Run the lead inside aoe too, and configure, for example:

```json
{
  "backend": "aoe",
  "leadPane": "aoe_Dori_0a1b2c3d",
  "agentCommand": ["omo", "--model", "{model}", "{prompt}"],
  "workspaces": [],
  "discord": { "statusStyle": "emoji" }
}
```

The agent must be available as an aoe tool (`aoe agents` lists built-ins; custom tools go in aoe's settings). With herdr, `agentCommand` is the full argv template. With aoe, only `agentCommand[0]` selects the tool; the model is passed through `--extra-args`, and the remaining arguments are unused.

Prepare a brief, then open a lane with either backend:

```sh
dori launch fix-login --title "Fix login" --brief ~/.dori/briefs/fix-login.md \
  --done "merged acme/app#412" --thread discord:100000000000000001
```

herdr opens a tab. aoe runs `aoe add <cwd> -t <key> --tool <tool> -l --extra-args "--model <model>"`, waits up to three minutes for the agent's `❯` prompt, then types the lane prompt. Startup failures produce `STARTUP_ERROR`; with aoe a session that shows neither a running turn nor its `❯` prompt 20 seconds after the lane prompt is `STARTUP_UNCONFIRMED` (exit 3) with its last lines. The registry's pane is a tmux session name such as `aoe_fix-login_1a2b3c4d`; aoe refuses a title/path pair that already exists, even in its trash.

The footer tells lanes to send `[REPORT] <key> | <milestone|blocker|question|done> | <text>` to the lead. With aoe, send these as two argv arrays, not a shell string:

```json
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "-l", "--", "[REPORT] fix-login | milestone | tests passed"]
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "Enter"]
```

`dori freshness` reads reports from the lead first, then the lane screen. A new report resets the silence timer; by default it nudges after 15 minutes and after 20 posts a short status line in the owner's words (`discord.quietText`) through `hooks.threadReply`, once per silence. The lane's report itself goes to the lead pane for the lead to retell in plain words; `discord.postRawReports: true` posts the report as before.

With aoe, `dori watch` emits `LANE_BLOCKED <key> <waiting|error|question|idle> <pane>` when a working or not-done lane stops for a human. It combines `aoe ps --json` with the screen: no blocked event during a running turn; idle must last 45 seconds, and a monitor, wake source or active/scheduled goal is not idle, nor is a lane whose session still waits on a detached eval cell, background bash session or background task it started (a quiet `BG_WAITING` log line; `LANE_BLOCKED` after `blockedWaitMin`, 60 minutes). Closing stops the aoe session and moves it to trash, never purges it.

## Onboarding

On first setup, before it reads anything of yours, the Dori asks whether it may learn how you work: your tools, what you're working on and why, who you and your company are. Only if you say yes does it look at your tools, one at a time. For each one it says which integration it would use and what that reads, for example a CLI that reads Gmail and Calendar so it can watch your schedule, and asks before it touches it. Tools you decline are skipped and remembered.

Everything is read-only. It writes what it learns to memory as it goes and ends with a short summary of what it knows and what's still missing. The full process is in [`references/onboarding.md`](skills/dori-mode/references/onboarding.md).

## Routing a request

The Dori decides on its own how to handle each message.

- Questions, status checks and lookups get answered directly, with no new session. Every change, even a one-line edit or a config value, goes to a lane, so you see it with its own thread and Done check.
- Code that ends in a PR, multi-step work, and anything long or parallel gets a lane. If an idle lane already owns that repo, the work goes there instead.
- When the host is short on memory, disk or panes (`dori can-launch` says HOLD), nothing new opens. The work is queued and the Dori tells you why.
- New work gets a new thread. A follow-up goes back to its original thread, reopening the old session if its lane was closed. A quick question is answered where you asked it.

## The session registry

Every lane gets one JSON file under `~/.dori/state/lanes/`. It maps the messenger thread to the herdr pane or aoe tmux session name, the pane to the agent's own session id, and records a status: `working`, `done-claimed`, `verified-done`, `not-done`, `paused` or `closed`. Each change is kept in a history.

`dori sync` compares that against the panes that are actually running and tells you what drifted: a pane that went away, a session id that changed, a lane with no way to prove it's finished. It never deletes anything. Add `--write` and it saves the session ids it found.

## The 5-minute done flow

A lane says it's finished:

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

The Dori sees `LANE_DONE_CLAIMED`, and the lane is told it closes in five minutes. You can push back in that window:

```sh
dori object-done fix-login --reason "the changelog entry is missing"
```

The reason goes straight to the lane, which keeps working and claims again later. If nobody objects, `dori watch` closes the lane once the window is up. Before it does, it reads every `Done =` signal live again, and it refuses if a worktree still has commits that never reached a remote or uncommitted tracked changes. Either one turns the claim back into not-done, with the reason. Restarting the watcher doesn't reset the clock. New work in the window takes the claim back instead: when you `dori type` into the lane (or its turn runs again after it went quiet), the watch log says `LANE_CLAIM_REOPENED`, the lane keeps working and claims again later. Typing into a lane that is already closed says `LANE_IS_CLOSED` with when and who closed it.

### What counts as done

A lane's `Done =` line lists signals the watcher can check for itself:
- a PR merged;
- an issue closed;
- a package version published;
- for work that never ends in a PR (a local setup, a QA pass, a running service): a command that exits 0, a file with the expected hash or JSON field, or a URL that answers with the expected status and body.

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

The watcher runs each check itself when it closes the lane, with no shell, and never takes the lane's word for it. A signal it can't parse is refused when the lane is launched. The full syntax is in [`references/sessions.md`](skills/dori-mode/references/sessions.md).

## Commands

| Command | What it does |
|---|---|
| `dori launch <key> ...` | write the lane footer into the brief, open a herdr tab or aoe session, start the agent, check for startup errors; warns `LAUNCH_DONE_WEAK` (and still launches) when every `Done =` signal only checks files or text, `--done-weak-ok` silences it; adds a "Past signals" section from earlier lanes in the same repo or topic (`--tag`, and the key's first word) so a new lane doesn't repeat a failed fix; `--ui` puts the owner's seven UI steps ([ui-work.md](skills/dori-mode/references/ui-work.md)) at the top of the brief, and a brief that reads like UI work without it gets `LAUNCH_UI_HINT` (still launches); a brief with none of the owner's eight steps ([sessions.md](skills/dori-mode/references/sessions.md)) gets them after its four fields (`LAUNCH_STEPS_ADDED`), one with only some gets `LAUNCH_STEPS_PARTIAL` and nothing added; the owner's directive ledger ([directives.json](skills/dori-mode/references/directives.json) plus a host-local file) adds the directives in scope that the brief lacks (`LAUNCH_DIRECTIVE_ADDED`) and stops on a missing required one (`LAUNCH_DIRECTIVE_MISSING`, exit 4) unless `--waive <id> "<reason>"`; `dori directive-audit` checks the last day's lanes against it every morning |
| `dori adopt <key> --pane ID ...` | register a lane that's already running |
| `dori set-thread <key> <adapter>:<id>` | point a lane at another work thread; `launch`, `adopt` and `set-thread` refuse an empty or malformed ref such as `discord:` |
| `dori sync [--write]` | registry against live panes, plus drift and a `SIGNALS` line per open lane with a record |
| `dori claim-done` / `object-done` / `close` | the done flow; a close with no usable thread prints `THREAD_MISSING <key>` instead of skipping the thread hook silently; with `DORI_DISCORD_TOKEN` set, a close also marks a `discord:` work thread done and archives it, unless another open lane or an open question card still uses it: then it only posts the lane's result there |
| `dori pause <key> <reason>` / `dori resume <key>` | park a lane that waits on you: no freshness nudge or post, `LANE_BLOCKED` or `DEAD_PANE` for it, and a done claim doesn't close it; with aoe it also pauses the omo goal of the lane's session (`/goal pause`, read back; `PAUSE_UNVERIFIED`, exit 3, if not confirmed); `resume` puts back the status it had and the goal it paused |
| `dori watch` | the auto-close watcher, plus aoe `LANE_BLOCKED` events; run it as a persistent monitor |
| `dori freshness [--loop MIN]` | nudge lanes that went quiet, then post a short status line to their thread and hand the last report to the lead |
| `dori dead-panes [--loop MIN]` | report agent panes that stopped |
| `dori guard [--loop MIN]` | alert on load, memory, disk and pane count |
| `dori fix-attempt <key> --metric M --hypothesis H` | count a fix you asked a lane for; lanes tag such reports `(fix: M / H)`, and from the third attempt on one metric with one hypothesis `SAME_FIX_3` tells you to switch the lane to a root-cause hunt; it first prints the hypotheses already tried on that metric (`PRIOR_FIX`) |
| `dori signals [--lane K \| --cwd DIR \| --tag T]` | what earlier lanes in one area tried and how it went: numbered fix attempts and the switch to a root-cause hunt (also read back from `[REPORT]` lines and your re-instructions), tagged fixes by metric, rejected done claims with reasons, re-sends, nudges, outcome, the area's rejection rate and rework, warnings. Read it before you re-instruct a lane |
| `dori scorecard [--date D] [--post]` | the day's token scorecard from records, no model call: cost per verified completion beside the claim rejection rate, the lanes with most rework, first-reply median/p90, the lead's context tax; saved to `<stateDir>/scorecard/<date>.json` and `latest.md` for the lead to read, `--post` also sends it to Discord (off by default; a daily systemd timer that saves it is in the Discord + aoe setup) |
| `dori heavy <label> [--mem 70G] -- <cmd>` | run a build, test suite or GPU job when load is low, in its own memory-capped scope (over it only the job dies, never the lane); beside running ones only when GPU, memory and CPU each keep 10% free with it |
| `dori heavy <label> --kind browser\|cpu --sync DIR -- <cmd>` | the same on the less busy PC: a helper host runs it in a no-network box with the `--sync` folders and copies changed files back |

Text sent to a pane always goes as one argument, never through a shell string, and the CLI checks that Enter actually landed.

## Utilities

The CLI also carries the messenger pieces a Dori needs. You can import them as typed modules from `scripts/src/messenger/`.

| Command | What it does |
|---|---|
| `dori send slack\|telegram\|discord --to T --text X [--thread ID] [--edit ID]` | post or edit a message; rate limits are retried, and text containing `$(` is refused |
| `dori send slack --to C --file PATH [--file PATH ...] [--text X] [--thread TS]` | upload up to 10 files (1 GB each) and share them as one Slack message with the text; a missing, empty or too big file is refused before anything is sent |
| `dori presence slack\|discord` | keep the account shown online (a Discord bot on the gateway, or a Slack user account through a web-client socket tickled every minute) |
| `dori transcribe <file>` | turn a voice note into text through your `hooks.transcribe` command |
| `dori can-launch` | tell whether there's room for another lane |
| `dori inbound slack [--loop MIN]` | catch everything addressed to the Dori on Slack: unread replies from the Threads view, new replies in any thread it posted in (even untagged ones), and DMs or channels with unread mentions |
| `dori inbound discord` | gateway listener for owner messages, voice transcription and question-card answers |
| `dori ask` / `questions [--open]` / `reopen <Qn>` / `resolve <Qn>` | post, list, reopen and resolve Discord question cards |
| `dori thread reply\|wait\|done discord:<id> <text>` | post in a work thread and mark working, waiting or done; done archives it |

The modules also cover a few things that have no command:
- Telegram: `sendMessageDraft` streaming that starts at "Thinking…", forum topics, and HTML tables.
- Discord: threads you can start, rename and archive.
- Slack: file uploads.
- `typingWhile`, which shows the typing indicator while a piece of work runs.

Every message the Dori posts on Slack records its thread, whichever helper sent it. A reply under a root it posted with a raw API call still reaches it, which is the case a plain message-event listener misses.

Tokens come from `DORI_SLACK_TOKEN` (with `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` and `DORI_DISCORD_TOKEN`.

### Discord question cards and thread status

Set `DORI_DISCORD_TOKEN`, `DORI_DISCORD_GUILD`, `DORI_DISCORD_CHANNEL` and `DORI_DISCORD_OWNER` in the environment or `~/.dori/dori.env` (already-set variables win). Enable the bot's Message Content intent and keep `dori inbound discord` running to receive button and text-box answers. Optional: `DORI_DISCORD_PAIR_CHANNEL` names a channel shared with other Doris; `DORI_DISCORD_PAIR_BOT` takes one or more of their bot ids, comma or whitespace separated (e.g. three Doris sharing one pair channel, each listing the other two bots). The owner's messages there land as `scope:"pair"` rows and the listed bots' as `scope:"pair-bot"` rows (information, never requests). `DORI_DISCORD_STATE_DIR` moves the question-card store (default `<stateDir>/discord`). `DORI_DISCORD_SHADOW_INBOX=<file>` runs a second listener that only writes inbox rows and never writes to Discord, so you can compare it with a live one before switching.

```sh
dori ask --text "Ship the login fix?" --option "Ship now" --option "Wait for QA" \
  --thread discord:100000000000000001 --tmux aoe_fix-login_1a2b3c4d
dori questions --open
dori reopen Q1
dori resolve Q1
```

Each of 1–9 options appears in full beside a short `Pick N` button; put the recommendation first for the highlighted button. A write-my-own button opens a text box. Only the owner can answer, and only the owner is pinged. Answers fold the card into a record and are written to `answers.jsonl` and the listener's inbox under `~/.dori/state/discord/`; `--session` and `--tmux` metadata identify where to relay them.

With `--thread`, the card is posted inside that work thread and marks it waiting. The answer folds into the record right there, with no separate record line; the thread returns to working once no other question in it is open. `dori reopen` restores the buttons and marks the thread waiting again. Without `--thread`, new cards go to the configured channel. Older channel cards associated with a thread still leave a silent answer record in that thread. `dori resolve` removes the tracked question after its follow-up is done; the folded card remains in chat. Resolving a card that was never answered also returns its thread to working once no other question in it is open, so a dropped question never leaves the thread waiting.

`discord.statusStyle: "emoji"` uses 🔄 working, ⏸️ waiting and ✅ done at the start of thread names, and 📌 for a thread kept open on purpose (`dori thread set <ref> standing`; `unstanding` releases it), whatever its status; the default `"words"` uses `[working]`, `[waiting]`, `[done]`. Only threads get a mark: a text channel, forum or category given as a thread (for example the channel id in `dori ask --thread`) keeps its name, and that status is dropped with `THREAD_STATUS_DROPPED <id> ... is not a thread`. `dori thread reply` / `wait` / `done` set these states; done archives, and reply/wait unarchive. An owner message in a done thread makes the listener reopen it as working. See the [Discord + aoe setup](skills/dori-mode/setups/discord-aoe/README.md) for services and localized card wording.

### Voice requests from an iPhone Shortcut

The Discord iOS app can't be driven by Shortcuts, so a one-button voice request takes a detour: an iOS Shortcut records audio and posts it to a Discord webhook in the Dori's channel. Set `DORI_DISCORD_OWNER_WEBHOOK` to that webhook's id and `dori inbound discord` treats its posts as the owner's own voice notes. They get the eyes reaction, are transcribed, and land in the inbox with `"via":"owner-webhook"`. Until the id is set, webhook posts are only logged (`DISCORD_WEBHOOK_UNKNOWN id=...`). Step-by-step guide covering the webhook, the Shortcut actions, the Action Button, Back Tap and Siri, and security: [iOS Shortcut voice requests](skills/dori-mode/setups/discord-aoe/ios-shortcut-voice.md).

## Tests

There are no automatic GitHub checks: the fork's review/merge gate requires PRs without CI. Run the full suite locally:

```sh
cd skills/dori-mode/scripts
bun install
bun test           # behaviour tests against fake herdr, aoe, tmux, git, gh and Discord HTTP/gateway
bunx tsc --noEmit  # typecheck
```

The tests cover both backends, launch/report delivery, freshness, blocked lanes, done flow and Discord cards/status. External tools and Discord HTTP/gateway are faked; no real pane, repo, GitHub or Discord account is touched.

The Windows subset in `.github/workflows/windows.yml` is run by hand, not on pushes or pull requests:

```sh
gh workflow run windows.yml -R orientpine/omo-dori-mode-experimental --ref feat/herdr-windows-serve
```

Replace `feat/herdr-windows-serve` with the branch to validate. The workflow runs the native process/session, refusal and PowerShell-literal tests plus the supervisor, installer, launcher, skill-discovery and registered-task tests. Windows freeze, thaw and handover refuse without changing processes or records; that implementation is deferred to `feat/herdr-windows-freeze`. Suites built on POSIX shell, process-table and launch-world fixtures stay in the Linux suite.

## License

MIT

## Migrate from Dori

If you set up the older Dori mode from the gist, your bot keeps working. Four changes turn it into a Dori.

1. **Pick a Dori name.** "Dori" on its own, or one that ends in Dori, like ShipDori or WorkDori. Tell your agent: "From now on your name is ShipDori and this is ShipDori mode." From then on, "ShipDori mode" is the keyword that turns it on, in place of "Dori mode".
2. **Rename the bot and change its picture.**
   - Telegram: open @BotFather, send `/setname`, pick the bot and send the new name. Then send `/setuserpic`, pick the bot and send the new image. The default Dori picture is [`skills/dori-mode/assets/dori-avatar.png`](skills/dori-mode/assets/dori-avatar.png); use any image you like. A bot's name and picture can only be changed through BotFather.
   - Discord: in the Developer Portal, open your application. On the **Bot** page change the username and the icon, and on **General Information** change the app name and icon as well (the same default picture works), then save.
3. **Install this repo** with the one-line install above, and tell your agent "ShipDori mode". It picks up the skill and the `dori` CLI in place of the old pasted prompt.
4. **Run onboarding** if your Dori never did. Just say "run onboarding".

Your existing threads, topics and memory stay as they are.
