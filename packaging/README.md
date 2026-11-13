# kya distribution channels

Source of truth for every package-manager channel of `@shield-agent/kya`. A release is not done
while any channel lags npm: the maintainers' daily release watchdog fails when an enabled channel
does not serve npm `latest`.

| Channel | Source here | Live location | State |
|---|---|---|---|
| npm | `package.json` | npmjs.com | automated on the `kya-v*` tag, only after the public repo sync merged |
| GitHub Release | none | `The-Pixel-Boys/shield-kya` Releases `vX.Y.Z` | automated after npm publish, with the `vX.Y.Z` tag |
| Homebrew | `homebrew/shield-kya.rb` (template) | `The-Pixel-Boys/homebrew-tap` `Formula/shield-kya.rb` | automated after each stable release: PR, tap checks, merge, byte check; container gate by hand when the template changes |
| Scoop | `scoop/shield-kya.json` (template) | `The-Pixel-Boys/scoop-bucket` `bucket/shield-kya.json` | automated after each stable release (PR, merge, byte check); **UNVERIFIED on Windows** |
| Docker / GHCR | `docker/Dockerfile` | `ghcr.io/the-pixel-boys/shield-kya` | published on each `kya-v*` tag by a GitHub Actions workflow with `GITHUB_TOKEN` (no owner token) |
| GitLab / CircleCI / Bitbucket | `ci/*` | none yet | drafts, install `@latest` at runtime, no per-release bump |
| WinGet | `winget/` | none | draft, blocked on a Windows installer artifact |
| Snap | none | none | not started (needs `classic` confinement, store review) |

Every channel, including marketplaces, plugin manifests and the planned ones, is registered in `channels.json` with how it is updated and a live check. A release is not done until every automatic channel serves it; manual and not-built channels are always reported as unresolved with what a human must do. A file in this package that carries a version must be registered there (or listed as not a channel), or CI fails. Homebrew and Scoop are bumped by the release pipeline; the other rows below are not wired yet.

## n8n community node (own version line)

`@shield-agent/n8n-nodes-kya` is not part of the kya release train. It has its own version line (starts at 0.1.0)
and its own public source repo, `The-Pixel-Boys/n8n-nodes-kya`, because n8n verifies a community node only when it
is published from a public GitHub Actions run with an npm provenance statement.

- The release pipeline copies the node source to the public repo `main` on each change. It also adds the tag
  `vX.Y.Z` when the version in the node's `package.json` changes. Existing tags are never moved.
- The public repo workflow `npm-publish.yml` runs on that tag. It builds, lints and tests the node. It refuses a tag that
  differs from `package.json`. It skips a version that npm already serves. Then it runs `npm publish --provenance
  --access public` with npm trusted publishing (OIDC, no token).
- The registry row is `n8n-community-node` in `channels.json`. It stays `manual-owner` until the first provenance
  publish worked. The owner steps are listed below. Only then does the row get a live probe.

Owner one-time steps (npm account with 2FA and the n8n Creator Portal need the owner):

1. Publish a placeholder once, so that the package exists. npm can set a trusted publisher only for an existing
   package (`npm trust` states: "The package you're configuring must already exist on the npm registry").
   Do not publish 0.1.0 by hand: a version is immutable, and a hand publish has no provenance, so n8n could not verify it.
   ```bash
   mkdir /tmp/n8n-placeholder && cd /tmp/n8n-placeholder
   printf '{"name":"@shield-agent/n8n-nodes-kya","version":"0.0.1","description":"Placeholder. Use 0.1.0 or later.","license":"MIT"}' > package.json
   npm publish --access public --tag bootstrap
   ```
2. On npmjs.com, open the package, then Settings, then Trusted publisher, then GitHub Actions. Set organization
   `The-Pixel-Boys`, repository `n8n-nodes-kya`, workflow filename `npm-publish.yml`, environment empty. Allow direct
   publish. The same in the CLI (npm 11.15 or later, 2FA on):
   `npm trust github @shield-agent/n8n-nodes-kya --repo The-Pixel-Boys/n8n-nodes-kya --file npm-publish.yml --allow-publish`.
   A new trusted publisher must complete its first publish within 2 days: do step 3 soon after.
3. Ask the maintainers to run the `kya-n8n-mirror` pipeline by hand on `main` (Woodpecker, Run pipeline). It mirrors the
   source, tags `v0.1.0`, and the public workflow publishes 0.1.0 with provenance. Check with
   `npm view @shield-agent/n8n-nodes-kya dist.attestations --json`.
4. Deprecate the placeholder: `npm deprecate @shield-agent/n8n-nodes-kya@0.0.1 "Placeholder. Use 0.1.0 or later."`.
5. After the first provenance publish: submit the package in the n8n Creator Portal (n8n account, 2FA).

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

No dependencies, Node 22+. Both download `https://registry.npmjs.org/@shield-agent/kya/-/kya-<version>.tgz`,
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

`depends_on "node"` (kya needs Node >= 22; `node` is the current line). The install does not pull the
semantic-search runtime (`@shield-agent/fastembed`, about 230MB on disk). Semantic search is opt-in: see the
README section "Natural-language search". The owner accepted the old 260MB install on 2026-10-10; the
runtime moved out of the default install on 2026-10-29.

The formula test asserts the usage output, because `kya --version` does not exist yet (kya prints usage
and exits 0). Follow-up when the flag lands: replace the two assertions marked in the test block with
`assert_match version.to_s, shell_output("#{bin}/kya --version")`.

Container gate, run by hand in any PR that changes the formula beyond its pinned fields (path installs are refused by Homebrew 7, use a local tap):

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
  and throws on a non-zero exit. Same note as Homebrew: no semantic runtime in the default install.
- `checkver` / `autoupdate` read npm `latest`; `bump-scoop.mjs` leaves them alone.

Needs a Windows run before the next release claims support:
`scoop bucket add The-Pixel-Boys https://github.com/The-Pixel-Boys/scoop-bucket && scoop install shield-kya && kya --help`,
then `scoop uninstall shield-kya`.

## Docker / GHCR

`docker/Dockerfile` has no default for `KYA_VERSION` (the build fails without it), so an image cannot
silently ship a stale CLI. Build context is `packaging/docker`.

```bash
podman build --build-arg KYA_VERSION=0.33.6 -t ghcr.io/the-pixel-boys/shield-kya:0.33.6 packaging/docker
podman run --rm ghcr.io/the-pixel-boys/shield-kya:0.33.6 --version
```

On each `kya-v*` tag the maintainers' release pipeline publishes the image with a GitHub Actions
`GITHUB_TOKEN` that has `packages: write`. No secret is stored.

1. It waits until npm serves the version (60 min at most). It fails red on a timeout.
2. If `:X.Y.Z` already exists, it does nothing. It never overwrites a tag, so a rerun is safe.
3. It builds `linux/amd64` and `linux/arm64` with `--build-arg KYA_VERSION=X.Y.Z` and the OCI label
   `org.opencontainers.image.source`. It pushes `:X.Y.Z`, and `:latest` only for a stable version.
4. It checks that both platforms exist and that `kya --version` in the image prints `X.Y.Z`.

The maintainers run a self-test of the publish script and a real-stack e2e of the image build (happy path, and the
denied builds without or with a bad version).

## CI registries and WinGet

`ci/gitlab`, `ci/circleci-orb`, `ci/bitbucket-pipe` and `winget/` are drafts moved over unchanged
(paths in their READMEs adjusted). The three CI wrappers install `@latest` at runtime and need no bump
per release. WinGet needs a Windows installer (exe/msi/zip), which npm does not provide; its manifest
is still at 0.19.0 with a placeholder hash.

## Secrets

| Secret | What | Used by |
|---|---|---|
| `kya_pkg_pat` (exists) | fine-grained PAT on `The-Pixel-Boys/homebrew-tap` and `The-Pixel-Boys/scoop-bucket` only: Contents read/write, **Pull requests read/write** (needed to open the bump PR), Metadata read; CI events: tag only. Separate from the sync token, which also admin-merges | Homebrew and Scoop bump |
| `snapcraft_store_credentials` | output of `snapcraft export-login --snaps=shield-kya --acls package_access,package_push,package_update,package_release -`; owner registers the name and files the `classic` request | snap publish |
| winget PAT | classic PAT with `public_repo` from the account that owns the `winget-pkgs` fork (Komac cannot open the PR with a fine-grained token); owner signs the Microsoft CLA | WinGet submission |

Register each as a CI secret available to tag builds only.

## Release fan-out (after `npm publish` of `kya-vX.Y.Z` succeeded)

Automatic, in the maintainers' release pipeline, for a stable version (prereleases are not fanned out):

1. The npm tarball is downloaded and must match npm's `dist.integrity`; its sha256 is what gets pinned.
2. Homebrew and Scoop: the template in this directory, at the release tag, is bumped to X.Y.Z with the scripts
   above. The tap and bucket get a PR with exactly that file. The PR waits for the repo's checks (tap: CodeQL),
   is squash-merged with its head pinned, and `main` is then compared byte for byte. Re-running is safe: a
   channel already at the version is left alone and a newer version is never downgraded.
3. A final gate reads every automatic channel in `channels.json` (npm, the public repo main, its tag and latest
   Release, the MCP registry, the Claude Code and Codex plugins, the Gemini extension, the Cursor manifest, the
   tap, the bucket). It fails unless all serve X.Y.Z, and prints the manual and not-built channels as UNRESOLVED.
4. The maintainers' daily watchdog repeats that check with each channel's grace period.

Never edit the tap or bucket by hand: the next release overwrites the file, and the watchdog reports the
difference until then. Change the template here instead. If the change touches more than the pinned
url / sha256 / version, run the Homebrew container gate above in that PR (it is not run per release).

Snap and WinGet join the same flow once they exist: register them in `channels.json` first.

## Copy and screenshot parity

`channel-copy.json` (package root) is the single source of truth for how every channel describes kya:
`short` (the tagline), `long` (the description), `variants` for channels that are a different product
surface (`mcp` for `server.json` / `manifest.json`, `plugin` for the Claude marketplace, the Claude Code and Codex plugin manifests and the Gemini CLI extension (hooks only, advisory), `python`
for the Python shim's `pyproject.toml`, `vscode` for the VS Code extension's `package.json` (VS Code Marketplace and Open VSX), `webInstall` / `webHowKyaWorks` for the shield-agent.com page descriptions), and
`screenshots` (file, sha256, alt) for every image in `assets/` (png, jpg, jpeg, webp, svg, gif).
Every variant starts with the tagline. Keep it truthful: local OSS is advisory and fails open except
the never-list. The checker rejects copy and alt texts that claim enforcement, fail-closed behaviour,
"blocks every / all", a guarantee, production readiness, or GA / general availability.

To change copy: edit `channel-copy.json`, then

```bash
cd sdks/kya
pnpm sync:channel-copy     # rewrites every drifted description in place
pnpm check:channel-copy    # what CI runs (with --require-all in the monorepo)
```

To change a screenshot: replace the image in `assets/` (the source of truth), paste the sha256 the
check prints into `channel-copy.json`, and run `pnpm sync:channel-copy`, which copies it over the
same-named web copy where that tree exists. A new image also needs an `alt`. A web image with the same
name but another format (for example a `.jpg` re-encode of an `assets/` `.png`) or with no `assets/`
counterpart cannot be byte-compared: the check prints it as `not covered` and does not fail.

Checked in this repo: `package.json`, `manifest.json`, `server.json` (MCP registry limit: 100
chars), `.claude-plugin/marketplace.json` (top level and every plugin entry),
`plugins/kya/.claude-plugin/plugin.json`, `plugins/kya/.codex-plugin/plugin.json`, `gemini-extension.json`, `vscode/package.json`, `.cursor-plugin/plugin.json` (mirrored from this package
to the public repo, so the checked copy is the one Cursor reads), the monorepo copy of the Python
shim's `pyproject.toml` (`[project]` table only; it is the PyPI source, built by `pypi-publish.yml`), `homebrew/shield-kya.rb` `desc` (brew audit style: no trailing period, no leading
article, at most 80 chars), `scoop/shield-kya.json`, the newest `winget/` locale manifest, the
README lead paragraph, README image links (must stay inside the package, or they 404 in the public
mirror), and the shield-agent.com install / how-kya-works meta
descriptions. Comparison is exact (case and whitespace); a winget `Description` wrapped over several
lines counts as drift and `--write` unwraps it. A file that is absent (the public mirror has no Python shim or web tree) is skipped and
printed; a file that exists but lacks the field fails.

Not covered, by design: `.agents/plugins/marketplace.json` (the Codex marketplace format has no description field), `mcp.json` (a client config example) and the `ci/` templates (CircleCI orb,
Bitbucket pipe, GitLab) describe the CI integration, not the product. The Docker image has no
description `LABEL` yet.

Channels CI cannot edit. Paste this text by hand when it drifts:

| Channel | Where | Text |
|---|---|---|
| GitHub repo description | `The-Pixel-Boys/shield-kya` settings, About | `long` |
| VS Code Marketplace / Open VSX | extension listing (built from the extension's own manifest) | `long` |
| Claude plugin directory / Cursor marketplace pages | listing forms | `variants.plugin` (Claude, hooks only) / `long` (Cursor) |
| PyPI `shield-kya` | published by `pypi-publish.yml` from `sdks/kya-python` on each stable `kya-v*` tag, after npm serves the version (version lockstep with `package.json`); the monorepo `pyproject.toml` description is checked here | `variants.python` |
| npm, MCP registry | update on the next kya release (from `package.json` / `server.json`) | `long` / `variants.mcp` |
| Homebrew tap, Scoop bucket | updated by the release pipeline at the next stable release (templates `homebrew/` and `scoop/`) | `short` without the period / `long` |

`long` today: "Audit trail and traceability for AI agents. See what every coding agent did, with opt-in
human approval and signed certify."
`variants.python` today: "Audit trail and traceability for AI agents. In-process kya shim for Python
agent frameworks (offline evaluate via the kya CLI)."
`variants.plugin` today: "Audit trail and traceability for AI agents. See what every coding agent did. Advisory:
records every tool call, blocks the never-list and the guard pack, fails open."

## VS Code Marketplace and Open VSX

The editor extension `shield-agent.shield-kya` (`sdks/kya/vscode`) has its own version line. The workflow
`.github/workflows/kya-vsix-publish.yml` runs on every `kya-v*` tag (and by hand from `main`). It builds the `.vsix`
once and publishes it to both stores with `.github/scripts/kya-vsix-publish.sh`:

- The script reads the live version of the store. It publishes only when the version in the `.vsix` is higher.
  When the versions are equal, it prints "already live" and passes. When the live version is higher, it fails.
- VS Code Marketplace: Trusted Publishing (OIDC). The job runs `vsce publish --oidc` and has `id-token: write`.
  There is no token and no PAT fallback. If the OIDC exchange fails, the job is red.
- Open VSX: the Actions secret `OVSX_PAT`. A missing secret fails the job. The message names the secret.
  The job never skips green.
- The Open VSX token goes to `ovsx` as an environment variable only. It is never in the command line.
- To ship new listing text, raise `version` in `sdks/kya/vscode/package.json` in the same PR as the text change.
  Without a higher version, the stores keep the old text and the release step `listing-pages` stays red.

Marketplace setup (the lead does it, no owner token): create a Trusted Publishing policy for the publisher
`shield-agent` on the Marketplace. Use these values:

| Field | Value |
|---|---|
| Owner | `The-Pixel-Boys` |
| Repository | `shield-agent` |
| Workflow file name | `kya-vsix-publish.yml` |
| Environment | empty (the job has no `environment:`) |

The repository is private. So run the workflow once by hand (Actions, kya-vsix-publish, `workflow_dispatch` on
`main`) within 48 hours after the policy is created. A later tag run then works without a new step.

Open VSX setup (owner, one time):

1. Create an Eclipse account and sign the Open VSX publisher agreement.
2. Create a token at open-vsx.org (user settings, Access Tokens).
3. Create the namespace once, with the token in the environment (never as `-p`):
   `OVSX_PAT=<token> npx ovsx create-namespace shield-agent`.
4. Add the token as the repository Actions secret `OVSX_PAT`. While the namespace does not exist, the Open VSX job
   fails with a message that names this step.
5. After the first publish, claim and verify the `shield-agent` namespace on Open VSX. The live check in
   `kya-channel-copy-live.sh` treats an unverified namespace as red.

## Claude Desktop extension (.mcpb)

Each release attaches `shield-kya-X.Y.Z.mcpb` to its GitHub Release. The release pipeline builds it from the published
npm package with `scripts/packaging/mcpb.mjs` (a zip with `manifest.json` at its root) and refuses a manifest whose
version is not the release version. Install: open the `.mcpb` file with Claude Desktop. The bundle has no
`node_modules`; the OpenTelemetry packages load only when telemetry is on.
