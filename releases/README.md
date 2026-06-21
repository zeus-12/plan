# Releases

Releases are built automatically by GitHub Actions (`.github/workflows/release.yml`).

## Cut a release

```sh
pnpm release 0.1.1
```

That's it — the script bumps `package.json`, commits, tags `v0.1.1`, and pushes
the branch + tag. Pushing the `v*` tag triggers the workflow: it builds the Intel
+ Apple Silicon DMGs on macOS runners and publishes a GitHub Release with them
attached, under **Releases** on GitHub. No binaries are committed to the repo.

The git tag is the source of truth for the version — the CI build derives
everything from it.

## Build locally (optional)

```sh
cd apps/desktop && pnpm pack:dmg   # DMG lands in apps/desktop/dist
```

## Note on signing

Builds are currently **unsigned** — macOS Gatekeeper will warn on first launch
(right-click → Open, or System Settings → Privacy & Security → Open Anyway).
To remove that, an Apple Developer ID ($99/yr) + notarization is needed.
