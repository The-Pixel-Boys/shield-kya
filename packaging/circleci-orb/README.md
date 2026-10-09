# KYA CircleCI orb

Run [KYA](https://shield-agent.com/install) (Know Your Agent) commands in CircleCI pipelines.

This orb installs the [`@shield-agent/kya`](https://www.npmjs.com/package/@shield-agent/kya) CLI and exposes reusable commands and jobs for the most common CI tasks.

## Usage

Reference the orb in your `.circleci/config.yml` and use the built-in jobs or commands:

```yaml
version: 2.1

orbs:
  kya: the-pixel-boys/kya@1.0.0

workflows:
  kya-check:
    jobs:
      - kya/certify
```

During development you can validate the local `orb.yml`:

```bash
circleci orb validate packaging/circleci-orb/orb.yml
```

## Jobs

### `kya/certify`

Run `kya certify` against the checked-out repository.

```yaml
version: 2.1

orbs:
  kya: the-pixel-boys/kya@1.0.0

workflows:
  kya-check:
    jobs:
      - kya/certify:
          fail_on: gap
          window_days: 30
```

Parameters:

| Parameter | Default | Description |
|---|---|---|
| `version` | `latest` | npm version of `@shield-agent/kya`. |
| `fail_on` | `gap` | `gap` or `never`. Maps to `kya certify --fail-on`. |
| `window_days` | `30` | Look-back window in days. |
| `artifacts` | `.kya/certify` | Path to store as artifacts. |
| `artifacts_destination` | `kya-certify` | Artifact destination prefix. |

### `kya/orr`

Run the read-only ORR reporting board.

```yaml
workflows:
  kya-check:
    jobs:
      - kya/orr:
          path: "."
          out: "./orr-report"
          skip_optional_producers: true
```

## Commands

Use the commands directly if you need a custom job layout.

### `kya/install`

```yaml
jobs:
  custom-kya:
    executor: kya/node
    steps:
      - checkout
      - kya/install
      - run: kya eval-tool --offline --tool-id org.sample.data.write --irreversible
```

### `kya/run`

```yaml
jobs:
  custom-kya:
    executor: kya/node
    steps:
      - checkout
      - kya/install
      - kya/run:
          command: "kya dash --once --offline"
          artifacts: ".kya"
          artifacts_destination: "kya-dash"
```

## Executor

The orb provides `kya/node`, based on `cimg/node:24.0`. Node.js 24+ is required by the KYA CLI.

## Publishing

1. Install the CircleCI CLI and authenticate (`circleci setup`).
2. Validate the orb: `circleci orb validate orb.yml`
3. Publish a development version: `circleci orb publish orb.yml the-pixel-boys/kya@dev:alpha`
4. Publish a production version: `circleci orb publish orb.yml the-pixel-boys/kya@1.0.0`

You must be a member of the `the-pixel-boys` CircleCI organization and have permission to publish orbs.

## Links

- npm: https://www.npmjs.com/package/@shield-agent/kya
- GitHub Action: https://github.com/The-Pixel-Boys/kya-action
- Docs: https://shield-agent.com/install
