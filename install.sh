#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI.
# Usage: curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | bash
#        curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | DORI_BACKEND=aoe bash
# Needs: git, bun 1.3+, and the lane backend: herdr, or aoe and tmux.
# Optional env: DORI_BACKEND (herdr or aoe, default herdr), DORI_REPO (clone URL), DORI_SRC (clone dir),
# SKILLS_DIR (where your agent loads skills), DORI_NO_PULL=1 (or true, yes: install an existing checkout as it is, without pulling).
set -euo pipefail

repo="${DORI_REPO:-https://github.com/orientpine/omo-dori-mode-experimental.git}"
backend="${DORI_BACKEND:-herdr}"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

case "$backend" in
  herdr) config_example="config.example.json" ;;
  aoe) config_example="config.aoe.example.json" ;;
  *) echo "DORI_BACKEND must be herdr or aoe, got: $backend" >&2; exit 1 ;;
esac

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

have() { command -v "$1" >/dev/null; }
if [ "$backend" = aoe ]; then
  for tool in aoe tmux; do have "$tool" || echo "warning: backend aoe needs $tool on PATH; lanes cannot open until it is installed" >&2; done
else
  have herdr || echo "warning: backend herdr needs herdr on PATH; lanes cannot open until it is installed (or rerun with DORI_BACKEND=aoe for aoe/tmux)" >&2
fi
have herdr || { have aoe && have tmux; } || echo "warning: no lane backend found: install herdr, or aoe and tmux" >&2
have gh || echo "note: gh not found; the done checks that read PRs and issues need it" >&2
have agent-messenger || echo "note: agent-messenger not found; it is optional for Slack, Telegram and Discord messaging" >&2

# A pull that local work blocks used to end with git's bare abort and no way to install the checkout as it is
# (dori-superagent issue #48 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/48).
# Now it names the checkout and its local work and gives both ways on; DORI_NO_PULL=1 installs it without pulling.
if [ -d "$src/.git" ]; then
  origin="$(git -C "$src" remote get-url origin 2>/dev/null || true)"
  # true and yes skip the pull too; before they pulled quietly (dori-superagent PR #85 (MIT):
  # https://github.com/sisyphuslabs/dori-superagent/pull/85).
  if [[ "${DORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
    echo "DORI_NO_PULL=$DORI_NO_PULL: installing $src as it is, without pulling." >&2
  elif [ "${origin%.git}" != "${repo%.git}" ]; then
    echo "warning: $src pulls from ${origin:-no origin}, not $repo; not updating it." >&2
    echo "  To follow $repo: git -C \"$src\" remote set-url origin \"$repo\" && git -C \"$src\" pull --ff-only" >&2
  elif ! git -C "$src" -c pull.autostash=false -c merge.autostash=false -c rebase.autostash=false -c pull.twohead=recursive pull --ff-only --quiet; then
    # git's message above says why the pull failed; this adds the local work git status sees and both ways on, given
    # whatever it shows: an edit can hide from status (update-index --assume-unchanged), and the failure need not be
    # that work (a lock file, a remote that cannot be reached). The -c overrides keep a local pull/merge/rebase.autostash
    # or pull.twohead=ours from turning the fast-forward into a stash pop or a merge (config, not --no-autostash, which git
    # before 2.27 refuses without --rebase).
    echo "error: could not update $src with git pull --ff-only; git's message above says why." >&2
    changes="$(git -C "$src" status --short --untracked-files=all)"
    ahead="$(git -C "$src" log --oneline '@{u}..HEAD' 2>/dev/null || true)"
    [ -z "$changes" ] || { echo "  Local changes in that checkout (git status --short):"; printf '%s\n' "$changes" | sed 's/^/    /'; } >&2
    [ -z "$ahead" ] || { echo "  Local commits upstream lacks:"; printf '%s\n' "$ahead" | sed 's/^/    /'; } >&2
    echo "  To install the checkout as it is, without pulling: run install.sh again with DORI_NO_PULL=1 (curl ... | DORI_NO_PULL=1 bash)." >&2
    # A branch with no upstream has no @{u} to reset to; git's message above says how to set one (dori-superagent PR #85 (MIT):
    # https://github.com/sisyphuslabs/dori-superagent/pull/85).
    if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null 2>&1; then
      echo "  If local work there is in the way and you want to drop it to update: git -C \"$src\" fetch && git -C \"$src\" reset --hard '@{u}', then run install.sh again." >&2
    fi
    exit 1
  fi
else
  git clone --quiet --depth 1 "$repo" "$src"
fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
if [ -f "$HOME/.dori/config.json" ]; then
  echo "Keeping the existing ~/.dori/config.json; its backend setting is left as it is"
else
  cp "$src/skills/dori-mode/references/$config_example" "$HOME/.dori/config.json"
fi

echo "Installed. Skill: $skills/dori-mode  CLI: dori  Config: ~/.dori/config.json  Backend: $backend"
if [ "$backend" = aoe ]; then
  echo "Next: set leadPane in ~/.dori/config.json to the tmux session name of the lead's aoe session, then open your agent inside that aoe session and tell it: Dori mode"
else
  echo "Next: set leadPane in ~/.dori/config.json to your herdr pane id (herdr pane current), then tell your agent: Dori mode"
fi
