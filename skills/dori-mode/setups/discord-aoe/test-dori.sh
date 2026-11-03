#!/usr/bin/env bash
# A scripted check with fakes on PATH; never talks to real systemd or aoe.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export CHECK_LOG="$T/log"
export PATH="$T:$PATH"
cat >"$T/dori" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == revive ]]; then printf 'dori %s\n' "$*" >>"$CHECK_LOG"; exit 0; fi
[[ "$*" == lead ]] || exit 3
[[ ${LEAD_FAIL:-0} == 0 ]] || exit 1
printf '%s\n' "${LEAD_LINE:-fresh-lead-id aoe_fresh}"
EOF
cat >"$T/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$CHECK_LOG"
EOF
cat >"$T/aoe" <<'EOF'
#!/usr/bin/env bash
printf 'aoe %s\n' "$*" >>"$CHECK_LOG"
if [[ "$2" == start ]]; then exit 1; fi
EOF
cat >"$T/herdr" <<'EOF'
#!/usr/bin/env bash
printf 'herdr %s\n' "$*" >>"$CHECK_LOG"
EOF
chmod +x "$T/dori" "$T/systemctl" "$T/aoe" "$T/herdr"
bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\naoe session start fresh-lead-id\naoe session attach fresh-lead-id'
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'launcher command mismatch\n' >&2; exit 1; }
rm "$CHECK_LOG"
if LEAD_FAIL=1 bash "$S/dori.sh"; then printf 'missing lead succeeded\n' >&2; exit 1; fi
[[ ! -e "$CHECK_LOG" ]] || { printf 'missing lead touched services\n' >&2; exit 1; }
# a herdr lead: a stopped one is revived in its pane, then herdr's client attaches; aoe is not used
LEAD_LINE="11111111-2222-4333-8444-555555555555 w1:p2 stopped" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\ndori revive w1:p2\nherdr '
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'herdr launcher command mismatch\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
rm "$CHECK_LOG"
LEAD_LINE="11111111-2222-4333-8444-555555555555 w1:p2" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\nherdr '
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'live herdr lead was revived\n' >&2; exit 1; }
printf 'DORI_SHELL_CHECK_PASS\n'
