# Third-party components

## kya gateway binary (`kya gate`)

`kya gate setup` installs a local MCP gateway binary that is a repackaged
build of the open-source **agentgateway** project
(<https://github.com/agentgateway/agentgateway>), licensed under the
**Apache License, Version 2.0** (<https://www.apache.org/licenses/LICENSE-2.0>).

- The binary is fetched only from the kya release repository's own `gate-v*`
  GitHub releases, repacked from the upstream release artifacts with sha256
  verification (see `.github/workflows/gate-binary.yml` in
  `The-Pixel-Boys/shield-kya`).
- The upstream `LICENSE` (and `NOTICE`, when published) is embedded in every
  repacked tarball, satisfying Apache-2.0 §4 redistribution requirements.
- The gateway runs locally on 127.0.0.1 under the user's own account; kya
  configures it via a generated standalone YAML file and receives its
  OpenTelemetry trace export.
