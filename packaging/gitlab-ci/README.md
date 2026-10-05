# KYA GitLab CI/CD Catalog component

Run [KYA](https://shield-agent.com/install) (Know Your Agent) commands in GitLab CI/CD.

This component installs the [`@shield-agent/kya`](https://www.npmjs.com/package/@shield-agent/kya) CLI in a Node.js 24 image and runs the command you provide. It stores the KYA output directory as a pipeline artifact so you can review reports after the run.

## Usage

Add the component to your `.gitlab-ci.yml`:

```yaml
include:
  - component: gitlab.com/the-pixel-boys/shield-kya/packaging/gitlab-ci/kya@main
    inputs:
      command: "kya certify --window 30 --fail-on gap --json"
```

If you keep this repository as a project or include it locally from the same repo:

```yaml
include:
  - local: packaging/gitlab-ci/template.yml
    inputs:
      command: "kya certify --window 30 --fail-on gap --json"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `stage` | `test` | Pipeline stage for the job. |
| `kya_version` | `latest` | npm version of `@shield-agent/kya` to install. |
| `command` | `kya certify --window 30 --fail-on gap --json` | The `kya` command to run. |
| `artifacts_path` | `.kya/certify` | Directory to publish as a job artifact. |
| `artifacts_expiry` | `30 days` | Artifact expiry. |

## Examples

### Certify (Agent Trust Baseline gap report)

```yaml
include:
  - local: packaging/gitlab-ci/template.yml
    inputs:
      command: "kya certify --window 30 --fail-on gap --json"
      artifacts_path: ".kya/certify"
```

### ORR run (read-only reporting board)

```yaml
include:
  - local: packaging/gitlab-ci/template.yml
    inputs:
      command: "kya orr run --path . --out ./orr-report --skip-optional-producers"
      artifacts_path: "./orr-report"
```

### Policy evaluate (offline demo)

```yaml
include:
  - local: packaging/gitlab-ci/template.yml
    inputs:
      command: "kya eval-tool --offline --tool-id org.sample.data.write --irreversible"
      artifacts_path: ".kya"
```

### Custom command

```yaml
include:
  - local: packaging/gitlab-ci/template.yml
    inputs:
      command: "kya dash --once --offline"
      artifacts_path: ".kya"
```

## Notes

- The runner must have outbound access to the public npm registry.
- Node.js 24+ is required; the component pins the `node:24` Docker image.
- `kya certify` exits non-zero when gaps exist and `--fail-on gap` is set. Use `--fail-on never` to report gaps without failing the pipeline.
- For commands with subcommands (for example `orr run`), pass the full command string in `command`.

## Links

- npm: https://www.npmjs.com/package/@shield-agent/kya
- GitHub Action: https://github.com/The-Pixel-Boys/kya-action
- Docs: https://shield-agent.com/install
