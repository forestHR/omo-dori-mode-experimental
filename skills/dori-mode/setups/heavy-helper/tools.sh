#!/usr/bin/env bash
# Tools a dori heavy helper offers to `dori heavy --kind ...` runs, in the helper account's own space (no sudo, no system
# package): a static ffmpeg and ffprobe in ~/.local/share/dori-heavy/tools/bin, which the box mounts read-only at
# /run/dori-tools/tools and puts on PATH. Playwright browsers are not here: the helper installs the caller's playwright
# version on demand into its own ~/.cache/ms-playwright. bun is the helper's own.
#   tools.sh [tools dir]     prints TOOLS_OK <dir> <ffmpeg version line>
set -euo pipefail
dir=${1:-$HOME/.local/share/dori-heavy/tools}
case $(uname -m) in
  aarch64) arch=linuxarm64 ;;
  x86_64) arch=linux64 ;;
  *) echo "TOOLS_FAIL no static ffmpeg build for $(uname -m)" >&2; exit 2 ;;
esac
base=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
name=ffmpeg-n8.1-latest-$arch-gpl-8.1.tar.xz
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/$name" "$base/$name"
curl -fsSL --retry 3 -o "$tmp/sums" "$base/checksums.sha256"
grep " $name\$" "$tmp/sums" > "$tmp/want" || { echo "TOOLS_FAIL $name is not in checksums.sha256" >&2; exit 3; }
(cd "$tmp" && sha256sum -c want >/dev/null) || { echo "TOOLS_FAIL $name sha256 does not match" >&2; exit 3; }
tar -xJf "$tmp/$name" -C "$tmp"
mkdir --parents "$dir/bin"
install -m 755 "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$dir/bin/"
echo "TOOLS_OK $dir $("$dir/bin/ffmpeg" -hide_banner -version | head -1)"
