# Contributing to KYA

Thanks for looking at KYA. This guide explains what we welcome, how a pull request gets from you into a release,
and the one-time agreement we ask contributors to sign.

## What we welcome

- **Host recipes**: teach another coding agent, editor or CLI to use KYA. Follow
  [docs/host-recipe.md](docs/host-recipe.md) and open the pull request with the host recipe template (add
  `?template=host-recipe.md` to the new pull request URL).
- **Importers**: read another tool's logs or policy files into KYA.
- **Catalog entries**: new or corrected entries under [catalog/](catalog/).
- **Bug fixes**: with a test that fails before the fix and passes after it.
- **Docs**: corrections, clearer setup steps, troubleshooting for a host you use.

## Please open an issue first for

- new commands, flags or config keys;
- changes to the trail, receipt or certify output formats;
- anything touching signing, approvals, network calls or telemetry;
- new runtime dependencies;
- large refactors or renames.

A short issue saves you time if the change does not fit the project.

## Sign the CLA (once)

Before we can accept your first pull request, we ask you to sign our Contributor License Agreement (CLA). Read
[CLA.md](CLA.md), then post this exact sentence as a comment on your pull request:

> I have read the KYA Contributor License Agreement version 1.0 and I agree to its terms.

A maintainer records your agreement privately, and we port your change only after that. There is no bot and no
status check: a person does this by hand. You sign once. Your signature covers your later pull requests too.

If you contribute as part of your job, check with your employer first. If your employer owns your work, it may need
to sign the corporate section of the CLA. Write to it@shield-agent.com and we will send it.

**What the CLA means.** You keep the copyright in your work. Your contribution is licensed to the project under
the CLA, which gives the project broad rights to use and license it. The code published in this repository stays
under the license in [LICENSE](LICENSE). Please read the CLA itself before signing. This paragraph is only a
summary.

## How a pull request becomes part of a release

This repository is published from the maintainers' source tree at each release. Releases are synced into this
repository by an automated pull request, and that sync replaces the package files with the released version.

What this means for your pull request:

1. You open a pull request here, against `main`, as usual. CI runs and a maintainer reviews it. If you have not
   signed the CLA yet, post the sentence above.
2. When we accept a change to the package (source, tests, docs, catalog, host folders) and your agreement is
   recorded, a maintainer applies the same change to our source tree and comments on your pull request. Your
   change then reaches this repository with the next release sync.
3. When that release ships, we close your pull request with a link to the release that carries your change. If
   the released files are byte-identical to your pull request, we may merge it instead.
4. Changes to repository-only files (for example under `.github/`) can be merged here directly.

Your pull request may be closed instead of merged even when your change is accepted. That is a side effect of the
release sync, not a rejection.

**Credit.** We credit contributors in the release notes of the release that ships their change, by name or GitHub
handle. We ask you first, and we leave you out if you prefer.

**Pull requests from forks.** CI for pull requests from forks runs on GitHub-hosted runners. GitHub may hold the
first workflow run of a new contributor until a maintainer approves it. If your checks show as waiting for
approval, that is expected. A maintainer will start them.

Please do not:

- bump the package version or edit version pins (`package.json` version, `server.json`, `manifest.json`). The
  release process does that.
- edit generated output (`dist/`, `coverage/`).

## Build and test

You need Node.js 22 or newer (24 recommended) and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

Useful extras:

- `pnpm test:watch` runs the tests in watch mode.
- `pnpm test:coverage` runs them with coverage.
- `pnpm check:version` checks that version pins agree (CI runs it too).
- `node dist/cli.js --help` runs your local build of the CLI.

## Code style

- TypeScript, ES modules, compiled with `tsc` ([tsconfig.json](tsconfig.json)). There is no separate linter. The
  build must pass without type errors.
- Tests use Vitest and live under [test/](test/). Add or update a test for every behavior change.
- Match the style of the file you are editing. Keep changes focused: one fix or feature per pull request.
- Do not add a runtime dependency without discussing it in an issue first.
- Never commit secrets, real API keys or token-shaped test strings. When a maintainer ports your change, our
  release checks scan for them.
- Use clear commit messages, for example `fix(connect): handle missing config dir`.

## Names and logos

The code is MIT licensed, but the Shield Agent and KYA names and logos are not. If you fork or redistribute, read
[TRADEMARKS.md](TRADEMARKS.md).

## Reporting security issues

Please do not open a public issue for a security problem. Email it@shield-agent.com with a description and steps to
reproduce. We will reply and keep you informed while we work on a fix.

## Questions

Open a GitHub issue or email it@shield-agent.com.
