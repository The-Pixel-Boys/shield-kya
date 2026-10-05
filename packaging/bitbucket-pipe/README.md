# KYA Bitbucket pipe

Run [KYA](https://shield-agent.com/install) (Know Your Agent) commands in Bitbucket Pipelines.

This pipe installs the [`@shield-agent/kya`](https://www.npmjs.com/package/@shield-agent/kya) CLI inside a Node.js 24 Alpine container and runs the command you provide.

## Usage

Add the pipe to a step in your `bitbucket-pipelines.yml`:

```yaml
image: node:24

pipelines:
  default:
    - step:
        name: KYA certify
        script:
          - pipe: docker://shieldagent/kya-pipe:latest
            variables:
              KYA_COMMAND: "kya certify --window 30 --fail-on gap --json"
              KYA_ARTIFACTS: ".kya/certify"
        artifacts:
          - .kya/certify/**
```

## Variables

| Variable | Default | Description |
|---|---|---|
| `KYA_VERSION` | `latest` | npm version of `@shield-agent/kya` to install. |
| `KYA_COMMAND` | `kya certify --window 30 --fail-on gap --json` | The `kya` command to run. |
| `KYA_ARTIFACTS` | `.kya/certify` | Directory printed at the end for artifact collection. |

## Examples

### Certify

```yaml
script:
  - pipe: docker://shieldagent/kya-pipe:latest
    variables:
      KYA_COMMAND: "kya certify --window 30 --fail-on gap --json"
```

### ORR run

```yaml
script:
  - pipe: docker://shieldagent/kya-pipe:latest
    variables:
      KYA_COMMAND: "kya orr run --path . --out ./orr-report --skip-optional-producers"
      KYA_ARTIFACTS: "./orr-report"
```

### Policy evaluate (offline demo)

```yaml
script:
  - pipe: docker://shieldagent/kya-pipe:latest
    variables:
      KYA_COMMAND: "kya eval-tool --offline --tool-id org.sample.data.write --irreversible"
```

## Build the image locally

```bash
docker build -t shieldagent/kya-pipe:latest .
docker run --rm \
  -e KYA_VERSION=latest \
  -e KYA_COMMAND="kya certify --window 30 --fail-on never --json" \
  -v $(pwd):/workspace \
  -w /workspace \
  shieldagent/kya-pipe:latest
```

## Publishing to Bitbucket

To list this pipe in the Bitbucket Marketplace you need:

1. A Docker Hub (or other registry) repository under the `shieldagent` account.
2. A public Bitbucket repository for the pipe.
3. A published Docker image tagged with the release version.
4. A `pipe.yml` committed in the pipe repository root.
5. Submission through the Bitbucket Cloud workspace settings.

The Docker image is not pre-published by this repository; build and push it before listing.

## Links

- npm: https://www.npmjs.com/package/@shield-agent/kya
- GitHub Action: https://github.com/The-Pixel-Boys/kya-action
- Docs: https://shield-agent.com/install
