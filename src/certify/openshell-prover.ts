/**
 * openshell-prover evidence for `kya certify` (NVIDIA OpenShell,
 * github.com/NVIDIA/OpenShell). OpenShell ships `openshell-prover`, a
 * standalone SMT-based formal-verification binary (release artifacts for
 * linux amd64/arm64 and macOS arm64): deterministic, never LLM-as-judge.
 * KYA runs it against the Phase 2 boundary policy and reports the verdict as
 * optional certify evidence (SAFE-06).
 *
 * Defensive by contract: a missing binary or unparseable output yields
 * "unavailable" / "unparseable" and therefore insufficient_evidence - never
 * a crash, never a fabricated pass, and never a fail on machines without
 * OpenShell. KYA never ships the binary; it is operator-supplied on PATH or
 * via KYA_OPENSHELL_PROVER. Telemetry stays disabled on the spawned
 * environment, same as the sandbox driver.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  OPENSHELL_WORKDIR,
  openshellPolicyPath,
  renderOpenshellPolicy,
} from "../sandbox/openshell-policy.js";
import { loadSandboxState } from "../sandbox/runtime.js";

export type OpenshellProverStatus =
  | "verified"
  | "violation"
  | "unavailable"
  | "unparseable";

export interface OpenshellProverOutcome {
  readonly status: OpenshellProverStatus;
  /** One line, redacted, safe for reports and bundles. */
  readonly detail: string;
}

/** Rendered-policy sandbox id when no live openshell sandbox exists. */
const CERTIFY_SANDBOX_ID = "sbx-00000000-0000-0000-0000-000000000000";

function proverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, OPENSHELL_TELEMETRY_ENABLED: "false" };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the prover binary: KYA_OPENSHELL_PROVER (absolute path, basename
 * openshell-prover) wins, else PATH. Returns undefined when absent; the
 * certify row is optional evidence, so absence is never an error here.
 */
export function resolveOpenshellProver(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.KYA_OPENSHELL_PROVER?.trim();
  if (fromEnv) {
    // Same contract as the sandbox drivers: absolute path, expected basename.
    if (!fromEnv.startsWith("/") || basename(fromEnv) !== "openshell-prover") return undefined;
    if (!executable(fromEnv)) return undefined;
    return fromEnv;
  }
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir || dir === "." || dir.startsWith(".")) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/openshell-prover`;
    if (!candidate.startsWith("/")) continue;
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Policy to prove against: the on-disk policy of the newest running openshell
 * sandbox when one exists (the live boundary), else a freshly rendered
 * default-deny policy. `tempDir` is set only for the rendered fallback so
 * the caller can clean it up.
 */
function resolvePolicyPath(cwd: string): { path: string; tempDir?: string } | undefined {
  try {
    const rows = loadSandboxState(cwd);
    const live = [...rows]
      .reverse()
      .find((r) => r.backend === "openshell" && r.status === "running");
    if (live) {
      const path = openshellPolicyPath(cwd, live.sandboxId);
      if (existsSync(path)) return { path };
    }
    const tempDir = mkdtempSync(join(tmpdir(), "kya-openshell-prover-"));
    const path = join(tempDir, "policy.yaml");
    writeFileSync(
      path,
      renderOpenshellPolicy({ sandboxId: CERTIFY_SANDBOX_ID, workdir: OPENSHELL_WORKDIR }),
      "utf8",
    );
    return { path, tempDir };
  } catch {
    return undefined;
  }
}

/**
 * Parse the prover verdict out of stdout/stderr + exit code. Only a clear
 * violation report fails; only a clear verification with exit 0 passes;
 * anything else is unparseable (insufficient_evidence), never a crash.
 */
export function parseOpenshellProverOutput(input: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly status: "verified" | "violation" | "unparseable"; readonly detail: string } {
  const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
  // Strip negations before scanning for violation markers ("no violations"
  // would otherwise match the plain "violation" pattern).
  const withoutNegations = text.replace(/no violations?/g, " ");
  if (/violation|counterexample|falsified/.test(withoutNegations)) {
    return {
      status: "violation",
      detail: "openshell-prover reported a boundary violation",
    };
  }
  if (input.exitCode === 0 && /verified|no violations|holds/.test(text)) {
    return {
      status: "verified",
      detail: "openshell-prover verified the policy grants no more than the boundary",
    };
  }
  return {
    status: "unparseable",
    detail: `openshell-prover output unparseable (exit ${input.exitCode})`,
  };
}

/**
 * Run the prover against the boundary policy. Never throws: every failure
 * mode lands in the outcome and maps to insufficient_evidence.
 */
export function runOpenshellProver(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenshellProverOutcome {
  const bin = resolveOpenshellProver(env);
  if (!bin) {
    return {
      status: "unavailable",
      detail:
        "openshell-prover not found - install OpenShell (https://github.com/NVIDIA/OpenShell) or set KYA_OPENSHELL_PROVER",
    };
  }
  const policy = resolvePolicyPath(cwd);
  if (!policy) {
    return { status: "unavailable", detail: "openshell boundary policy could not be resolved" };
  }
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(bin, ["verify", "--policy", policy.path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: proverEnv(env),
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (typeof e.status !== "number") {
      return {
        status: "unavailable",
        detail: `openshell-prover could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    exitCode = e.status;
    stdout = typeof e.stdout === "string" ? e.stdout : "";
    stderr = typeof e.stderr === "string" ? e.stderr : "";
  } finally {
    // The temp dir only exists for the rendered-policy fallback; removing a
    // missing path is a no-op.
    if (policy.tempDir) {
      try {
        rmSync(policy.tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  return parseOpenshellProverOutput({ exitCode, stdout, stderr });
}
