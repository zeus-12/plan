#!/usr/bin/env bash
# Point the Homebrew cask in zeus-12/homebrew-plan at a published release:
#   pnpm bump-cask 0.5.4
# Waits for CI to attach the DMG, so it's safe to run straight after pushing the tag.
# Uses your local `gh` login — no token lives in CI for this.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: pnpm bump-cask <version>   e.g. pnpm bump-cask 0.5.4" >&2
  exit 1
fi

v="${1#v}"
tag="v$v"
repo="zeus-12/plan"
tap="zeus-12/homebrew-plan"
cask="Casks/plan.rb"
asset="Plan-$v-arm64.dmg"
poll_seconds=20
timeout_seconds=$((40 * 60))

digest=""
waited=0
echo "waiting for $asset on $tag…"
while :; do
  digest="$(gh api "repos/$repo/releases/tags/$tag" \
    --jq ".assets[] | select(.name == \"$asset\") | .digest" 2>/dev/null || true)"
  [ -n "$digest" ] && break

  conclusion="$(gh run list --repo "$repo" --workflow release.yml --branch "$tag" \
    --json conclusion --jq '.[0].conclusion' 2>/dev/null || true)"
  if [ -n "$conclusion" ] && [ "$conclusion" != "success" ]; then
    echo "release build for $tag finished with '$conclusion' — cask not touched" >&2
    exit 1
  fi

  if [ "$waited" -ge "$timeout_seconds" ]; then
    echo "gave up after $((timeout_seconds / 60))m — rerun: pnpm bump-cask $v" >&2
    exit 1
  fi
  sleep "$poll_seconds"
  waited=$((waited + poll_seconds))
done

case "$digest" in
  sha256:*) sha="${digest#sha256:}" ;;
  *)
    echo "unexpected digest '$digest' on $asset" >&2
    exit 1
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh repo clone "$tap" "$work" -- --depth 1 --quiet

sed -i '' -E "s|^  version \".*\"$|  version \"$v\"|" "$work/$cask"
sed -i '' -E "s|^  sha256 \".*\"$|  sha256 \"$sha\"|" "$work/$cask"
# A sed that matches nothing is silent; without these the cask would keep the old DMG.
grep -q "^  version \"$v\"$" "$work/$cask"
grep -q "^  sha256 \"$sha\"$" "$work/$cask"

if git -C "$work" diff --quiet; then
  echo "cask already at $v"
  exit 0
fi

git -C "$work" commit -qam "plan $v"
git -C "$work" push -q
echo "cask now at $v — brew upgrade --cask zeus-12/plan/plan"
