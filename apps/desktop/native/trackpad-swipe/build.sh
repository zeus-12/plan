#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/trackpad_swipe.mm"
out="$here/build/trackpad_swipe.node"
headers="$here/../../node_modules/node-api-headers/include"

if [ "$(uname)" != "Darwin" ]; then
  echo "trackpad-swipe: macOS only, skipping" >&2
  exit 0
fi

if [ -f "$out" ] && [ "$out" -nt "$src" ] && [ "$out" -nt "$0" ]; then
  exit 0
fi

mkdir -p "$here/build"
xcrun clang++ \
  -std=c++17 -fobjc-arc -O2 \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -DNODE_GYP_MODULE_NAME=trackpad_swipe \
  -DNAPI_VERSION=8 \
  -I "$headers" \
  -bundle -undefined dynamic_lookup \
  -framework AppKit \
  -o "$out" "$src"
echo "trackpad-swipe: built $out"
