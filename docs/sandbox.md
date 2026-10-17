# Sandbox backends

`kya sandbox` is an opt-in execution wrap that lives beside the gate, not inside MCP. Spawned sandboxes are recorded in `.kya/sandboxes.json` and feed the `sandbox_inventory` check in `kya certify`. Select a backend with `KYA_SANDBOX=<backend>` or the `--sandbox` flag:

```bash
KYA_SANDBOX=<backend> kya sandbox spawn
KYA_SANDBOX=<backend> kya sandbox exec --sandbox-id <id> --cmd "true"
KYA_SANDBOX=<backend> kya sandbox kill --sandbox-id <id>
```

`org.sample.sandbox.exec` without `--sandbox-id` is **DENY** `MISSING_SANDBOX_ID`.

## mock

In-memory driver for tests and demos. Never talks to a real VMM. No binaries required.

## firecracker

Real Firecracker/jailer driver. Requires the `firecracker` and `jailer` binaries on PATH (or `KYA_SANDBOX_FIRECRACKER` / `KYA_SANDBOX_JAILER` absolute paths) plus kernel/rootfs env (`KYA_SANDBOX_KERNEL`, `KYA_SANDBOX_ROOTFS`, absolute paths). KYA does not ship those binaries. `exec` needs vsock wiring on the host; use `mock` in tests.

## openshell

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) driver (Apache 2.0, currently 0.1.x): kernel-isolated sandboxes driven through the `openshell` CLI (`openshell sandbox create/exec/delete`).

Preflight on `spawn` (fails with a UsageError naming the fix):

- `openshell` on PATH, or `KYA_SANDBOX_OPENSHELL` set to an absolute path (not shipped in the npm package).
- `docker` or `podman` on PATH (OpenShell requirement).
- CLI version at or above the pinned floor (`OPENSHELL_MIN_VERSION` in `src/sandbox/openshell-driver.ts`).

Policy: each spawn renders an OpenShell policy (`version: 1`, max 4 MiB, unknown fields rejected by OpenShell) to `.kya/openshell/policy-<sandboxId>.yaml` and passes it via `--policy`. The generated policy locks system paths (`/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc`) read-only, makes the sandbox workdir `/workspace` read-write, sets `process.run_as_user` to the non-root `nobody` user, and seeds `network_policies` as default-deny (allowlist seeds belong to the MCP server registry, `src/mcp-servers.ts`, once it exposes an egress shape). Filesystem rules lock at sandbox start; `network_policies` hot-reload.

Telemetry: KYA always sets `OPENSHELL_TELEMETRY_ENABLED=false` on the spawned environment.

Records keep the OpenShell-side sandbox name (`kya-<sandboxId>`) in the `externalName` field of `.kya/sandboxes.json`, so `kya sandbox status` and `kya certify` correlate KYA ids with backend names.

The live report (`kya receipt`, or `kya start` for the auto-refreshing dashboard) renders a dedicated OpenShell panel in the System tab once any OpenShell signal exists: policy activity (DENY vs ALLOW, `openshell.network` vs `openshell.http`, top destinations) rolled up from imported `openshell.*` trail events, openshell-backend sandbox rows with the on-disk `.kya/openshell/policy-<sandboxId>.yaml` status, and a runtime card probing the `openshell` CLI version (once per report build, cached), the container runtime, the pinned `OPENSHELL_MIN_VERSION` floor, and the `openshell-prover` binary, including the SAFE-06 certify outcome when the certify card already computed one. With no OpenShell data at all the panel is omitted; fresh installs never see it.

Real-binary end-to-end tests are opt-in: `KYA_E2E_OPENSHELL=1 pnpm test` (skipped by default, mirroring the real-gate e2e pattern).
