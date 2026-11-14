# Contributing to KYA

Thanks for looking at KYA. This guide explains what we welcome, how a pull request gets from you into a release,
and the one-time agreement we ask contributors to sign.

## What we welcome

- **Guard rules and replays**: a new rule that stops one more destructive command, with its tests and replay file.
  Start with [Add a rule](#add-a-rule). Issues with the label `good first rule` are sized for a first pull request.
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

**A bot checks it, no person does.** We decided on 2026-11-14 to keep the CLA and to automate it with a small GitHub
Actions workflow (`cla`), not with a third-party app and not with a paid service. The check `cla` on your pull request
turns green when you, and every other author of a commit in it, posted the exact sentence on this pull request or on
an earlier pull request of yours here. If it does not, the bot leaves one comment that tells you what is missing and
how to fix it. It runs again when you comment, so you do not need to push anything.

Rules of the check:

- Post the sentence as its own comment, with no other text and no quote mark. Case and punctuation must match.
- A comment that you edited after posting does not count, even if the text is right. Post it again as a new comment.
- A comment from another person does not count for you. A commit author that is not linked to a GitHub account
  cannot sign: set the commit email to an address on your GitHub account.
- Members of the Shield Agent organisation and bot accounts do not need to sign.

You sign once. Your signature covers your later pull requests too.

If you contribute as part of your job, check with your employer first. If your employer owns your work, it may need
to sign the corporate section of the CLA. Write to it@shield-agent.com and we will send it.

**What the CLA means.** You keep the copyright in your work. Your contribution is licensed to the project under
the CLA, which gives the project broad rights to use and license it. The code published in this repository stays
under the license in [LICENSE](LICENSE). Please read the CLA itself before signing. This paragraph is only a
summary.

## How a pull request becomes part of a release

This repository is an automated mirror of the maintainers' source tree. Each release sync replaces the package files
here with the released version, so a change that exists only here is reverted by the next sync. An outside pull
request therefore reaches the source tree first, with your name on it. The flow in five lines:

1. You open a pull request here, against `main`. CI runs without secrets, on GitHub-hosted runners, and the `cla` check runs.
2. A maintainer reviews it and approves the pull request (first reply within 48 hours, see below).
3. A maintainer starts the workflow "kya inbound port" in the source tree with your pull request number. It checks the approval and the CLA, applies your diff to `sdks/kya`, and opens a pull request there. You are the git author of the commit. The bot is the committer.
4. That pull request is merged first. Then a maintainer merges your pull request here with a rebase or a merge commit, never a squash, so your commit stays in this repository's history.
5. The next release sync copies the source tree here. Your change is already in it, so the sync keeps it and your name stays in `git log`. The scoreboard shows your handle.

The port refuses a pull request that changes a binary file, a symlink, a submodule, a file mode, a path outside the
package, a tool or git config file (`.npmrc`, `.pnpmfile.cjs`, `.husky/`, `.claude/`, lockfiles, and similar), or a path that
only exists here (`.github/`, `.woodpecker/`, `.gitignore`). A maintainer will tell you which one. Your name on the ported
commit comes from your GitHub account, not from the commit text, and every commit author must have signed the CLA.

**For maintainers:** approving a pull request for the port runs its code in monorepo CI (package scripts and tests). Approve
only after you read the whole diff, and only with write rights; the port reads your rights from the repository. A pull request that only changes repository-only files (for example under `.github/`) can be
merged here directly, and it is not ported.

If a pull request cannot be ported (for example a maintainer prefers to rewrite it), we say so and close it with a
link to the change that ships. That is not a rejection of your idea.

**Credit.** Your commit keeps you as author in both repositories. For a rule or a replay file, put your GitHub handle
in the replay's `credit` field: the scoreboard (`docs/replays.md`, and the page at shield-agent.com/replays) shows it
in the row. We also credit contributors in the release notes of the release that ships their change, by name or
handle. We ask you first, and we leave you out if you prefer.

**Response time.** We aim to reply to a pull request that adds a rule or a replay within 48 hours of opening it. The
first reply says what happens next: approve, change requests, or a question. If you wait longer, comment on the pull
request and we will look at it.

**Pull requests from forks.** CI for pull requests from forks runs on GitHub-hosted runners. GitHub may hold the
first workflow run of a new contributor until a maintainer approves it. If your checks show as waiting for
approval, that is expected. A maintainer will start them.

Please do not:

- bump the package version or edit version pins (`package.json` version, `server.json`, `manifest.json`). The
  release process does that.
- edit generated output (`dist/`, `coverage/`).

## Add a rule

A guard rule stops one more destructive command. A rule pull request has three parts: the rule, its tests, and a
replay file. You can write one in about an hour.

1. Run `pnpm new-rule <id>` in this folder. The id is lower-case words joined by dashes, for example `helm-uninstall`.
   The command writes everything you need to edit, and it refuses an id that exists or a bad id. It changes nothing
   when it refuses. Add `--credit <your-github-handle>` to fill in the credit field.
2. **The rule.** In `src/guard-pack.ts`, replace the stub matcher the command added. Look at a neighbour such as
   `fly-destroy` for the style. Write the one-line hint that tells the agent what to do instead. Describe the rule in
   its row in `docs/guard-pack.md`.
3. **The tests.** In `test/guard-rule-<id>.test.ts`, list at least 2 commands the rule must stop and at least 3
   everyday commands that must pass (the false-positive bar, below).
4. **The replay file.** In `replays/class-<id>.yaml`, write the dangerous command and a title. Use placeholder tokens
   and hosts only. Put your GitHub handle in `credit`.
5. Run `pnpm test -- guard-rule-<id> replays`, then `pnpm sync:replays` and `pnpm build:guard`. Commit the files they
   change. Any `TODO` left in a file fails the run on purpose.

**The false-positive bar: three must-pass controls.** A rule that blocks normal work gets uninstalled. We merge a rule
only when at least three everyday commands that look like the dangerous one pass without a prompt, and the whole
replay run still passes. Good choices: the read-only twin (`helm list`), the same command against a local or
dry-run target, and the same words inside text (`echo helm uninstall`).

**Message format.** The commit and the pull request title read `feat(guard): add <id> rule`. The body has two lines:
what the rule stops, and which similar commands still pass. The hint in the deny line is one sentence in the
imperative, with no command and no path in it. Use plain, short sentences.

Pull requests that add a rule get the label `rule`, replay files get `replay`, and a first rule for a new
contributor is a `good first rule`. We do not need a prior issue for a rule.

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
- Use Conventional Commit messages, for example `fix(connect): handle missing config dir`.

## Names and logos

The code is MIT licensed, but the Shield Agent and KYA names and logos are not. If you fork or redistribute, read
[TRADEMARKS.md](TRADEMARKS.md).

## Reporting security issues

Please do not open a public issue for a security problem. Email it@shield-agent.com with a description and steps to
reproduce. We will reply and keep you informed while we work on a fix.

## Questions

Open a GitHub issue or email it@shield-agent.com.
