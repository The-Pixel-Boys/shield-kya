# kya distribution channels

Source of truth for every package-manager channel of `@shield-agent/kya`. A release is not done
while any channel lags npm: the maintainers' daily release watchdog fails when an enabled channel
does not serve npm `latest`.

| Channel | Source here | Live location | State |
|---|---|---|---|
| npm | `package.json` | npmjs.com | automated on the `kya-v*` tag, only after the public repo sync merged |
| GitHub Release | none | `The-Pixel-Boys/shield-kya` Releases `vX.Y.Z` | automated after npm publish, with the `vX.Y.Z` tag |
| Homebrew | `homebrew/shield-kya.rb` | `The-Pixel-Boys/homebrew-tap` `Formula/shield-kya.rb` | bump script + manual copy; tested in the `homebrew/brew` container |
| Scoop | `scoop/shield-kya.json` | `The-Pixel-Boys/scoop-bucket` `bucket/shield-kya.json` | bump script + manual copy; **UNVERIFIED on Windows** |
| Docker / GHCR | `docker/Dockerfile` | `ghcr.io/the-pixel-boys/shield-kya` (not published yet) | draft, no publish step |
| GitLab / CircleCI / Bitbucket | `ci/*` | none yet | drafts, install `@latest` at runtime, no per-release bump |
| WinGet | `winget/` | none | draft, blocked on a Windows installer artifact |
| Snap | none | none | not started (needs `classic` confinement, store review) |

Nothing in this tree is wired into a pipeline yet; the owner creates the secrets below first.

## Pin policy

The formula and the Scoop manifest pin the published npm tarball (version + sha256). The sha256
exists only after `npm publish`, so these files are bumped AFTER the release, never by
`pnpm sync:version`. `node scripts/check-version-pins.mjs` (run by `prepublishOnly` and the
release watchdog) therefore allows them to trail `package.json`, and fails when one of them:

- is ahead of `package.json`,
- disagrees with the other channel file (half-done bump), or
- has a malformed sha256 (placeholder, uppercase, wrong length).

Lag against the LIVE channels is the watchdog's job, not the pin check's.

## Bump scripts

No dependencies, Node 24. Both download `https://registry.npmjs.org/@shield-agent/kya/-/kya-<version>.tgz`,
hash it, and rewrite only the pinned fields. Idempotent: a second run reports `already at <version>`.

```bash
cd sdks/kya
node scripts/packaging/bump-homebrew.mjs 0.23.1     # url + sha256 in homebrew/shield-kya.rb
node scripts/packaging/bump-scoop.mjs 0.23.1        # version + url + hash in scoop/shield-kya.json
```

Options: `--file <path>` (bump a copy, for example a checkout of the tap), `--sha256 <hex>` (skip the
download), `--check` (write nothing, exit 1 if the file would change). Exit 2 means bad input or an
unpublished version. Both scripts refuse a file whose url/sha256 shape changed instead of guessing.

Tests: `test/packaging-bump.test.ts`, `test/version-pins-packaging.test.ts` (`pnpm test`).

## Homebrew

`depends_on "node"` (kya needs Node >= 24; `node` is the current line). The install pulls the optional
`fastembed` / `onnxruntime-node` dependency, about 260MB on disk, so offline semantic search works. Both
resolve to the script-free forks `@shield-agent/fastembed` / `@shield-agent/onnxruntime-node` (installed
under the upstream names via npm: aliases), so no install scripts run.
This size was accepted by the owner on 2026-10-10; `--omit=optional` would drop semantic search.

The formula test asserts the usage output, because `kya --version` does not exist yet (kya prints usage
and exits 0). Follow-up when the flag lands: replace the two assertions marked in the test block with
`assert_match version.to_s, shell_output("#{bin}/kya --version")`.

Gate before copying to the tap (path installs are refused by Homebrew 7, use a local tap):

```bash
podman run --rm -v "$PWD/packaging/homebrew/shield-kya.rb:/in/shield-kya.rb:ro" docker.io/homebrew/brew:latest bash -c '
  brew update && brew tap-new --no-git local/kya &&
  cp /in/shield-kya.rb "$(brew --repository local/kya)/Formula/" &&
  brew style local/kya/shield-kya && brew audit --strict --online local/kya/shield-kya &&
  brew install local/kya/shield-kya && brew test local/kya/shield-kya'
```

Homebrew 7 passes a 1 day release cooldown to npm: a dependency published within the last 24h can fail
a same-day bump. Retry the next day.

## Scoop (UNVERIFIED on Windows)

Written against the Scoop App Manifests wiki and the Scoop sources (`lib/install.ps1`, `lib/core.ps1`,
`lib/decompress.ps1`), not run on Windows. What the manifest relies on:

- `.tgz` is extracted with 7-Zip and `extract_dir: "package"` strips the npm `package/` level, so
  `package.json` and `dist/` land directly in `$dir`.
- `bin` must not be a `.js` file: for an unknown extension Scoop writes a bash shim. So `pre_install`
  writes `kya.cmd` (`@node "%~dp0dist\cli.js" %*`), which Scoop shims natively. `pre_install` runs after
  extraction and before shim creation. `["kya.cmd", "shield-kya"]` adds the second bin name.
- `post_install` runs `npm install --omit=dev` in `$dir` (runtime dependencies are not in the tarball)
  and throws on a non-zero exit. Same optional `fastembed` size note as Homebrew.
- `checkver` / `autoupdate` read npm `latest`; `bump-scoop.mjs` leaves them alone.

Needs a Windows run before the next release claims support:
`scoop bucket add The-Pixel-Boys https://github.com/The-Pixel-Boys/scoop-bucket && scoop install shield-kya && kya --help`,
then `scoop uninstall shield-kya`.

## Docker / GHCR (draft)

`docker/Dockerfile` has no default for `KYA_VERSION` (the build fails without it), so an image cannot
silently ship a stale CLI. Build context is `packaging/docker`.

```bash
podman build --build-arg KYA_VERSION=0.23.1 -t ghcr.io/the-pixel-boys/shield-kya:0.23.1 packaging/docker
podman run --rm ghcr.io/the-pixel-boys/shield-kya:0.23.1 --help
```

The image build was not run in this change (UNVERIFIED). arm64 needs qemu binfmt on the build host.
The earlier GitHub Actions workflow draft was not carried over: it triggers on a GitHub `release`
event, which the release process does not use. A tag-triggered image publish step is future work.

## CI registries and WinGet

`ci/gitlab`, `ci/circleci-orb`, `ci/bitbucket-pipe` and `winget/` are drafts moved over unchanged
(paths in their READMEs adjusted). The three CI wrappers install `@latest` at runtime and need no bump
per release. WinGet needs a Windows installer (exe/msi/zip), which npm does not provide; its manifest
is still at 0.19.0 with a placeholder hash.

## Secrets the owner must create (none exist yet; nothing here invents a value)

| Secret | What | Used by |
|---|---|---|
| `kya_pkg_pat` | fine-grained PAT, Contents: read/write on `The-Pixel-Boys/homebrew-tap` and `The-Pixel-Boys/scoop-bucket` only (separate from `KYA_SYNC_PAT`, which also admin-merges) | brew and scoop publish steps |
| GHCR token | classic PAT with `write:packages` (fine-grained PATs with GHCR: unverified); set the package public once | image push |
| `snapcraft_store_credentials` | output of `snapcraft export-login --snaps=shield-kya --acls package_access,package_push,package_update,package_release -`; owner registers the name and files the `classic` request | snap publish |
| winget PAT | classic PAT with `public_repo` from the account that owns the `winget-pkgs` fork (Komac cannot open the PR with a fine-grained token); owner signs the Microsoft CLA | WinGet submission |

Register each as a CI secret available to tag builds only.

## Release checklist (after `npm publish` of `kya-vX.Y.Z` succeeded)

1. `cd sdks/kya && node scripts/packaging/bump-homebrew.mjs X.Y.Z && node scripts/packaging/bump-scoop.mjs X.Y.Z`
2. `node scripts/check-version-pins.mjs` is green; open a PR with the two changed files (keeps this tree the source of truth).
3. Homebrew container gate (above) is green.
4. Copy `homebrew/shield-kya.rb` to `homebrew-tap` `Formula/shield-kya.rb` and `scoop/shield-kya.json` to
   `scoop-bucket` `bucket/shield-kya.json` (token: `kya_pkg_pat`).
5. Image: build and push `:X.Y.Z` and `:latest` (once the GHCR token and publish step exist).
6. Snap and WinGet: once those channels exist.
7. Confirm the release watchdog reports `OK` (it compares npm `latest` with the live tap formula, the Scoop
   bucket and this repo's latest GitHub Release, each with a grace period for a release that is only hours
   old). A new channel is enabled in the watchdog's `KYA_CHANNELS` list in the same change that adds its probe.

The release pipeline itself fails red unless npm `latest`, this repo's `main`, its `vX.Y.Z` tag and its latest
GitHub Release all agree. Homebrew and Scoop are bumped by the steps above after publish, so only the watchdog
checks them. Next step (not built yet): bump the tap and bucket from the pipeline with `kya_pkg_pat`.
