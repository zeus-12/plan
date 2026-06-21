# Releases

Releases are built automatically by GitHub Actions (`.github/workflows/release.yml`).

## Cut a release

```sh
cd apps/desktop
npm version patch --no-git-tag-version   # or minor / major
cd ../..
git commit -am "release v0.1.1"
git tag v0.1.1
git push && git push origin v0.1.1
```

Pushing the `v*` tag triggers the workflow: it builds the Intel + Apple Silicon
DMGs on macOS runners and publishes a GitHub Release with them attached, under
**Releases** on GitHub. No binaries are committed to the repo.

## Build locally (optional)

```sh
cd apps/desktop && pnpm pack:dmg   # DMG lands in apps/desktop/dist
```

## Note on signing

Builds are currently **unsigned** — macOS Gatekeeper will warn on first launch
(right-click → Open, or System Settings → Privacy & Security → Open Anyway).
To remove that, an Apple Developer ID ($99/yr) + notarization is needed.
