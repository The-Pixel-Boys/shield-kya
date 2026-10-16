// test/certify-openshell-prover.test.ts
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCatalog, type CatalogRequirement } from "../src/certify/catalog.js";
import {
  evaluateRequirement,
  type EvidenceContext,
} from "../src/certify/evaluate.js";
import {
  parseOpenshellProverOutput,
  resolveOpenshellProver,
  runOpenshellProver,
} from "../src/certify/openshell-prover.js";
import { writeOpenshellPolicy } from "../src/sandbox/openshell-policy.js";
import { runCertify, type CertifyOptions } from "../src/commands/certify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-certify-prover-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-09-18T12:00:00.000Z");
const LIVE_ID = "sbx-123e4567-e89b-42d3-a456-426614174000";
const FALLBACK_ID = "sbx-00000000-0000-0000-0000-000000000000";
const CLEAN_PATH = "/usr/bin:/bin";

/** Write an executable fake openshell-prover and return its path. */
function fakeProver(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, body, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

function proverEnv(bin: string): NodeJS.ProcessEnv {
  return { KYA_OPENSHELL_PROVER: bin, PATH: CLEAN_PATH };
}

function ctx(over: Partial<EvidenceContext>): EvidenceContext {
  return {
    now: NOW,
    events: [],
    gateMode: "observe",
    wiredHostCount: 0,
    orr: undefined,
    orrCategories: undefined,
    sandboxCount: 0,
    receiptCount: 0,
    showbackPresent: false,
    attestations: new Map(),
    ...over,
  };
}

const SAFE06: CatalogRequirement = {
  id: "SAFE-06",
  domain: "safety",
  title: "Sandbox boundary verified by openshell-prover",
  text: "x",
  severity: "medium",
  check: { kind: "openshell_prover" },
};

describe("resolveOpenshellProver", () => {
  it("prefers KYA_OPENSHELL_PROVER when it is an absolute executable path", () => {
    const dir = tmp();
    const bin = fakeProver(dir, "openshell-prover", "#!/bin/sh\necho ok\n");
    expect(resolveOpenshellProver(proverEnv(bin))).toBe(bin);
  });

  it("rejects env overrides that are relative, wrong-basename, or not executable", () => {
    const dir = tmp();
    const wrongName = fakeProver(dir, "not-the-prover", "#!/bin/sh\necho ok\n");
    const noExec = fakeProver(dir, "openshell-prover", "#!/bin/sh\necho ok\n");
    chmodSync(noExec, 0o644);
    expect(resolveOpenshellProver({ KYA_OPENSHELL_PROVER: wrongName })).toBeUndefined();
    expect(resolveOpenshellProver({ KYA_OPENSHELL_PROVER: noExec })).toBeUndefined();
    expect(resolveOpenshellProver({ KYA_OPENSHELL_PROVER: "relative/openshell-prover" })).toBeUndefined();
  });

  it("falls back to PATH lookup and yields undefined when absent", () => {
    const dir = tmp();
    const bin = fakeProver(dir, "openshell-prover", "#!/bin/sh\necho ok\n");
    expect(resolveOpenshellProver({ PATH: `${dir}:${CLEAN_PATH}` })).toBe(bin);
    expect(resolveOpenshellProver({ PATH: CLEAN_PATH })).toBeUndefined();
  });
});

describe("parseOpenshellProverOutput", () => {
  it("parses verified, violation, and unparseable output", () => {
    expect(
      parseOpenshellProverOutput({ exitCode: 0, stdout: "verified: no violations", stderr: "" })
        .status,
    ).toBe("verified");
    expect(
      parseOpenshellProverOutput({ exitCode: 1, stdout: "", stderr: "violation: egress" }).status,
    ).toBe("violation");
    expect(
      parseOpenshellProverOutput({ exitCode: 0, stdout: "wibble wobble", stderr: "" }).status,
    ).toBe("unparseable");
    // A nonzero exit alone is not a violation report: unknown output stays unparseable.
    expect(
      parseOpenshellProverOutput({ exitCode: 2, stdout: "usage: openshell-prover …", stderr: "" })
        .status,
    ).toBe("unparseable");
  });
});

describe("runOpenshellProver", () => {
  it("is unavailable when the binary is absent - never an error", () => {
    const cwd = tmp();
    const outcome = runOpenshellProver(cwd, { PATH: CLEAN_PATH });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.detail).toContain("openshell-prover");
  });

  it("passes a rendered fallback policy when no live openshell sandbox exists", () => {
    const cwd = tmp();
    const dir = tmp();
    // The policy file handed over must be the freshly rendered default-deny one.
    const bin = fakeProver(
      dir,
      "openshell-prover",
      `#!/bin/sh
if grep -q "${FALLBACK_ID}" "$3"; then
  echo "verified: no violations, policy holds"
else
  echo "violation: wrong policy"
fi
`,
    );
    const outcome = runOpenshellProver(cwd, proverEnv(bin));
    expect(outcome.status).toBe("verified");
    expect(outcome.detail).toContain("verified");
  });

  it("proves against the live sandbox policy when a running openshell sandbox exists", () => {
    const cwd = tmp();
    writeOpenshellPolicy(cwd, LIVE_ID);
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(
      join(cwd, ".kya", "sandboxes.json"),
      `${JSON.stringify([
        {
          sandboxId: LIVE_ID,
          backend: "openshell",
          createdAt: NOW.toISOString(),
          status: "running",
        },
      ])}\n`,
    );
    const dir = tmp();
    const bin = fakeProver(
      dir,
      "openshell-prover",
      `#!/bin/sh
if grep -q "${LIVE_ID}" "$3"; then
  echo "verified: no violations, policy holds"
else
  echo "violation: wrong policy"
fi
`,
    );
    expect(runOpenshellProver(cwd, proverEnv(bin)).status).toBe("verified");
  });

  it("reports a violation when the prover finds one", () => {
    const cwd = tmp();
    const dir = tmp();
    const bin = fakeProver(
      dir,
      "openshell-prover",
      '#!/bin/sh\necho "violation: network egress outside boundary" >&2\nexit 1\n',
    );
    const outcome = runOpenshellProver(cwd, proverEnv(bin));
    expect(outcome.status).toBe("violation");
  });

  it("reports unparseable output instead of crashing", () => {
    const cwd = tmp();
    const dir = tmp();
    const bin = fakeProver(dir, "openshell-prover", "#!/bin/sh\necho wibble wobble\n");
    expect(runOpenshellProver(cwd, proverEnv(bin)).status).toBe("unparseable");
  });

  it("is unavailable when the env override points at a non-executable file", () => {
    const cwd = tmp();
    const dir = tmp();
    const bin = fakeProver(dir, "openshell-prover", "#!/bin/sh\necho ok\n");
    chmodSync(bin, 0o644);
    expect(runOpenshellProver(cwd, proverEnv(bin)).status).toBe("unavailable");
  });
});

describe("openshell_prover evaluation (SAFE-06)", () => {
  it("passes when the prover verifies the boundary", () => {
    const r = evaluateRequirement(
      SAFE06,
      ctx({ openshellProver: { status: "verified", detail: "openshell-prover verified" } }),
    );
    expect(r.status).toBe("pass");
  });

  it("gaps when the prover reports a violation", () => {
    const r = evaluateRequirement(
      SAFE06,
      ctx({ openshellProver: { status: "violation", detail: "openshell-prover reported a boundary violation" } }),
    );
    expect(r.status).toBe("gap");
  });

  it("is insufficient_evidence when the binary is absent - never a fail", () => {
    const r = evaluateRequirement(
      SAFE06,
      ctx({ openshellProver: { status: "unavailable", detail: "openshell-prover not found" } }),
    );
    expect(r.status).toBe("insufficient_evidence");
  });

  it("is insufficient_evidence on unparseable output and when never evaluated", () => {
    expect(
      evaluateRequirement(
        SAFE06,
        ctx({ openshellProver: { status: "unparseable", detail: "openshell-prover output unparseable (exit 0)" } }),
      ).status,
    ).toBe("insufficient_evidence");
    expect(evaluateRequirement(SAFE06, ctx({})).status).toBe("insufficient_evidence");
  });
});

describe("openshell_prover catalog schema", () => {
  it("validates a catalog with the new check kind", () => {
    const catalog = validateCatalog({
      id: "c",
      version: "1",
      updated: "d",
      domains: ["safety"],
      requirements: [
        {
          id: "SAFE-06",
          domain: "safety",
          title: "t",
          text: "x",
          severity: "medium",
          check: { kind: "openshell_prover" },
        },
      ],
    });
    expect(catalog.requirements[0]?.check).toEqual({ kind: "openshell_prover" });
  });
});

describe("runCertify with openshell-prover evidence", () => {
  function baseOptions(cwd: string, env: NodeJS.ProcessEnv): CertifyOptions {
    return {
      cwd,
      env,
      windowDays: 30,
      out: ".kya/certify",
      formats: ["json"],
      jsonStdout: false,
      open: false,
      quiet: true,
      failOn: "never",
      sign: false,
      now: NOW,
    };
  }

  it("SAFE-06 is insufficient_evidence without the prover, pass with a verifying prover", () => {
    const cwd = tmp();
    const home = tmp();
    const without = runCertify(baseOptions(cwd, { KYA_HOME: home, PATH: CLEAN_PATH }));
    const row = without.report.requirements.find((r) => r.id === "SAFE-06");
    expect(row?.status).toBe("insufficient_evidence");

    const dir = tmp();
    const bin = fakeProver(
      dir,
      "openshell-prover",
      '#!/bin/sh\necho "verified: no violations, policy holds"\n',
    );
    const withProver = runCertify(
      baseOptions(cwd, { KYA_HOME: home, KYA_OPENSHELL_PROVER: bin, PATH: CLEAN_PATH }),
    );
    expect(withProver.report.requirements.find((r) => r.id === "SAFE-06")?.status).toBe("pass");
  });

  it("SAFE-06 is a gap when the prover reports a violation", () => {
    const cwd = tmp();
    const home = tmp();
    const dir = tmp();
    const bin = fakeProver(
      dir,
      "openshell-prover",
      '#!/bin/sh\necho "violation: network egress outside boundary" >&2\nexit 1\n',
    );
    const result = runCertify(
      baseOptions(cwd, { KYA_HOME: home, KYA_OPENSHELL_PROVER: bin, PATH: CLEAN_PATH }),
    );
    expect(result.report.requirements.find((r) => r.id === "SAFE-06")?.status).toBe("gap");
  });
});
