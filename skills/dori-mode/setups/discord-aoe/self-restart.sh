#!/usr/bin/env bash
# Restart an aoe agent session (default: the Dori itself) and type a first prompt into it.
# Schedule it detached so it outlives the session it restarts:
#   systemd-run --user --on-active=20 --unit=dori-self-restart-$(date +%s) \
#     ~/.dori/src/skills/dori-mode/setups/discord-aoe/self-restart.sh
# usage: self-restart.sh [--start] [aoe-id] [tmux-session] [prompt]     (prompt "" types nothing)
#
# systemd user units get a bare PATH without ~/.bun/bin, so a restarted pane can fail to find the agent
# and die at once. This script pins PATH, refuses to restart when the agent binary is broken, waits for
# the prompt before typing, retries three times, and reports a failure to the Dori's Discord channel.
# The prompt goes in through `dori type`, which counts it only when the input box is empty again and a turn
# runs: a long prompt folds into "[paste #1 +N lines]" and can sit unsent after a plain send-keys + Enter.
#
# Another Dori on the same host (its own config and dori.env): run this with its DORI_CONFIG, DORI_ENV_FILE and
# DORI_STATE_DIR set, so `dori lead`, `dori type` and the failure notice use that Dori's lead, token and channel.
# aoe and tmux run without any DORI_*, and the tmux server's global environment loses them first, except
# DORI_CONFIG, DORI_ENV_FILE and DORI_STATE_DIR, which the account's tmux unit puts there (tmux-server) so the session's
# bare `dori` acts as this Dori and reads its token from that dori.env. A server first started by a unit that loaded
# dori.env keeps that file's token, inbox and lead in its global environment and hands them to every pane it opens.
set -uo pipefail
CALLER_NODE=$(command -v node 2>/dev/null)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
# The session keeps this PATH, and omo runs memory reflection and other hooks with `#!/usr/bin/env node`: without node
# they fail ("/usr/bin/env: 'node': No such file or directory"). nvm is set up only in ~/.bashrc, so find node's bin dir
# here: nvm's default alias (followed through lts/* -> lts/<name> -> vX.Y.Z), else the newest nvm version, else the
# caller's node.
node_bin() {
  local nvm=${NVM_DIR:-$HOME/.nvm} v=default d _
  for _ in 1 2 3 4 5; do
    [ -f "$nvm/alias/$v" ] || break
    v=$(tr -d '[:space:]' <"$nvm/alias/$v")
  done
  # newest first within each group; the first bin dir whose node is executable wins (a broken newer one is skipped)
  { ls -d "$nvm/versions/node/v${v#v}"*/bin | sort -rV; ls -d "$nvm"/versions/node/v*/bin | sort -rV; echo "${CALLER_NODE%/node}"; } 2>/dev/null |
    while read -r d; do [ -x "$d/node" ] && { echo "$d"; break; }; done
}
NODE_BIN=$(node_bin)
[ -z "$NODE_BIN" ] || PATH="$HOME/.bun/bin:$HOME/.local/bin:$NODE_BIN:/usr/local/bin:/usr/bin:/bin"
# read, not exported: dori reads its env file itself, and nothing here may pass the values on to aoe or tmux
# shellcheck disable=SC1090
[ -f "${DORI_ENV_FILE:-$HOME/.dori/dori.env}" ] && . "${DORI_ENV_FILE:-$HOME/.dori/dori.env}"

# aoe and tmux without any DORI_* variable (exported ones from the caller or a unit included)
# shellcheck disable=SC2046
no_dori_env() { env $(env | sed -n 's/^\(DORI_[A-Za-z0-9_]*\)=.*/-u \1/p') "$@"; }
scrub_tmux_env() {
  no_dori_env tmux show-environment -g 2>/dev/null | sed -n 's/^\(DORI_[A-Za-z0-9_]*\)=.*/\1/p' |
    grep -vxE 'DORI_(CONFIG|ENV_FILE|STATE_DIR)' | while read -r v; do
    no_dori_env tmux set-environment -g -u "$v" && log "TMUX_ENV_DROPPED $v"
  done
}

MODE=restart
if [ "${1:-}" = --start ]; then
  MODE=start
  shift
fi

if [ -z "${1:-}" ]; then
  LEAD=$(dori lead) || exit 1
  read -r ID T _ <<<"$LEAD"
  if [ "$MODE" = start ] && [[ "$LEAD" != *" stopped" ]]; then
    echo "LEAD_ALREADY_RUNNING $T"
    exit 0
  fi
else
  ID=$1
  T=${2:-${DORI_LEAD_TMUX:?set DORI_LEAD_TMUX or pass the tmux session}}
  # --start with an id (dori watch's lead revive): a session that came back meanwhile is left alone
  if [ "$MODE" = start ] && [[ "$T" != *:* ]] && tmux has-session -t "=$T" 2>/dev/null; then
    echo "LEAD_ALREADY_RUNNING $T"
    exit 0
  fi
fi
PROMPT=${3-Dori mode}
AGENT=${DORI_AGENT_BIN:-omo}
LOG=$HOME/.dori/self-restart.log
REASON=""

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }
if ! command -v node >/dev/null; then
  echo "SELF-RESTART-WARN no node (nvm or caller PATH): the restarted session's node hooks, memory reflection included, will fail" >&2
  log "SELF-RESTART-WARN no node on the session PATH ($PATH)"
fi
# A failed restart is for the other Dori (pair channel) to fix, not a code for the owner (owner 2026-10-18 21:43 KST,
# 2026-10-20 00:10 KST); the owner's channel only when no pair channel is set.
notify() { dori send discord --to "${DORI_DISCORD_PAIR_CHANNEL:-${DORI_DISCORD_CHANNEL:-}}" --text "$1" >>"$LOG" 2>&1 || log "SELF-RESTART-NOTIFY-FAIL"; }
ready() { tmux capture-pane -p -t "=$T:" 2>/dev/null | grep -q '^❯'; }
busy() { tmux capture-pane -p -t "=$T:" 2>/dev/null | grep -q 'esc to interrupt'; }

# A herdr lead (a pane id with ":", backend herdr): the account's herdr server runs in its own unit
# (setups/discord-aoe/systemd/dori-herdr.service, installed as dori-herdr.service or <user>-herdr.service), and dori revive
# starts the lead's recorded omo session again in its pane and types the prompt; a lead whose agent still runs is left
# alone (dori never ends a live herdr agent); aoe and tmux are not used.
# The unit: DORI_HERDR_UNIT (environment or dori.env), else dori-herdr.service, else the one installed *-herdr.service;
# several of those start none (HERDR_UNIT_AMBIGUOUS, set DORI_HERDR_UNIT), and none at all is logged (HERDR_UNIT_NONE).
herdr_unit() {
  local units
  if [ -n "${DORI_HERDR_UNIT:-}" ]; then
    systemctl --user cat "$DORI_HERDR_UNIT" >/dev/null 2>&1 && echo "$DORI_HERDR_UNIT" || log "HERDR_UNIT_MISSING $DORI_HERDR_UNIT (DORI_HERDR_UNIT)"
    return
  fi
  systemctl --user cat dori-herdr.service >/dev/null 2>&1 && { echo dori-herdr.service; return; }
  mapfile -t units < <(systemctl --user list-unit-files --no-legend --plain '*-herdr.service' 2>/dev/null | awk '{print $1}')
  case ${#units[@]} in
    1) echo "${units[0]}" ;;
    0) log "HERDR_UNIT_NONE no dori-herdr.service or *-herdr.service" ;;
    *) log "HERDR_UNIT_AMBIGUOUS ${units[*]}: set DORI_HERDR_UNIT" ;;
  esac
}
if [[ "$T" == *:* ]]; then
  HERDR_UNIT=$(herdr_unit)
  [ -z "$HERDR_UNIT" ] || systemctl --user start "$HERDR_UNIT" || log "HERDR_UNIT_START_FAIL $HERDR_UNIT"
  for _ in $(seq 50); do herdr pane list >/dev/null 2>&1 && break; sleep 0.2; done
  if OUT=$(dori revive "$T" --text "$PROMPT" 2>&1); then
    log "SELF-RESTART-OK herdr $OUT"
    echo "$OUT"
    exit 0
  fi
  log "SELF-RESTART-FAIL herdr $OUT"
  notify "restart of $T failed: $OUT. Log: ~/.dori/self-restart.log. Start it by hand: dori revive $T"
  exit 1
fi

if ! command -v "$AGENT" >/dev/null || ! "$AGENT" --version >>"$LOG" 2>&1; then
  log "SELF-RESTART-ABORT $AGENT missing or broken; session left running"
  notify "restart of $T cancelled: $AGENT does not run. The old session is still up."
  exit 1
fi

# config launchEnv (e.g. the GPU hidden on a training node): a lane restarts with it, a --use-gpu lane, the lead and any
# other session without it, as dori opens them; aoe hands the session only what tmux update-environment names
if ! LAUNCH_ENV_OUT=$(dori launch-env "$T" 2>>"$LOG"); then
  log "SELF-RESTART-WARN dori launch-env $T failed; the session restarts without launchEnv"
  LAUNCH_ENV_OUT=""
fi
mapfile -t LAUNCH_ENV < <(printf '%s' "$LAUNCH_ENV_OUT" | sed '/^$/d')
[ ${#LAUNCH_ENV[@]} -eq 0 ] || log "launch env for $T: ${LAUNCH_ENV[*]}"

# A tmux server that aoe starts here lives in this script's unit (dori-lead, a watch revive, a systemd-run restart):
# start the account's own tmux unit first (DORI_TMUX_UNIT, default <user>-tmux.service, setups/discord-aoe/tmux-server)
# so the server lives there and a later restart of aoe-serve or a dori unit does not end every session.
TMUX_UNIT=${DORI_TMUX_UNIT:-$(id -un)-tmux.service}
if systemctl --user cat "$TMUX_UNIT" >/dev/null 2>&1; then
  systemctl --user start "$TMUX_UNIT" || log "TMUX_UNIT_START_FAIL $TMUX_UNIT"
  for _ in $(seq 50); do no_dori_env tmux display-message -p '#{pid}' >/dev/null 2>&1 && break; sleep 0.1; done
fi

for attempt in 1 2 3; do
  log "attempt $attempt: aoe session $MODE $ID"
  scrub_tmux_env
  no_dori_env env "${LAUNCH_ENV[@]}" aoe session "$MODE" "$ID" >>"$LOG" 2>&1 || log "aoe $MODE rc=$?"
  for _ in $(seq 90); do ready && break; sleep 2; done
  if ready; then
    sleep 10 # let aoe's own wake-up message land first
    if [ -n "$PROMPT" ]; then
      if dori type "$T" --text "$PROMPT" >>"$LOG" 2>&1; then
        log "SELF-RESTART-OK attempt $attempt (prompt submitted)"
        exit 0
      fi
      REASON="prompt not submitted (NOT_SUBMITTED in the watch log)"
    else
      sleep 30
      if tmux has-session -t "=$T" 2>/dev/null && { ready || busy; }; then
        log "SELF-RESTART-OK attempt $attempt"
        exit 0
      fi
    fi
  else
    REASON="no ❯ prompt after restart"
  fi
  log "attempt $attempt failed; pane tail: $(tmux capture-pane -p -t "=$T:" 2>/dev/null | tail -5 | tr '\n' '|')"
done

log "SELF-RESTART-FAIL after 3 attempts"
notify "restart of $T failed 3 times (last: ${REASON:-unknown}). Log: ~/.dori/self-restart.log. Start it by hand: aoe session start $ID"
exit 1
