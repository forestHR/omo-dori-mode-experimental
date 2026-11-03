#!/usr/bin/env bash
set -euo pipefail
# dori lead must be installed (the lead-resolution PR supplies it).
lead=$(dori lead)
read -r AOE_ID PANE STATE <<< "$lead"
if [[ -z "$AOE_ID" ]]; then
  printf 'dori lead returned no session id\n' >&2
  exit 1
fi
systemctl --user start dori-inbound.service dori-google-watch.service
# aoe without any DORI_*: if it starts the tmux server, every pane inherits that server's environment
unset_dori=$(env | sed -n 's/^\(DORI_[A-Za-z0-9_]*\)=.*/-u \1/p')
# a herdr lead (dori lead prints "<omo session> <pane>[ stopped]"; only a herdr pane id holds ":"): a stopped one is started
# again in its recorded session, then this attaches herdr's client to the server
if [[ "${PANE:-}" == *:* ]]; then
  if [[ "${STATE:-}" == stopped ]]; then dori revive "$PANE" || true; fi
  # shellcheck disable=SC2086
  exec env $unset_dori herdr
fi
# shellcheck disable=SC2086
env $unset_dori aoe session start "$AOE_ID" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
exec env $unset_dori aoe session attach "$AOE_ID"
