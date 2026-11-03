#!/bin/sh
set -eu
"$HOME/.bun/bin/bun" "$(dirname "$0")/terminal.ts"
exec herdr
