import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCertifyMarkdown, renderCertifyHtml } from "../src/certify/render.js";
import { runCertify } from "../src/commands/certify.js";
import type { CertifyReport } from "../src/certify/evaluate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reportWith(over: Partial<CertifyReport>): CertifyReport {
  return {
    format: "shield-kya-certify-report",
    version: 1,
    generatedAt: "2026-09-18T12:00:00.000Z",
    catalog: { id: "agent-trust-baseline", version: "0.1.0", updated: "2026-09-18" },
    window: { days: 30, since: "2026-08-19T12:00:00.000Z", until: "2026-09-18T12:00:00.000Z" },
    trail: {
      eventCount: 2,
      verdictMix: { ALLOW: 1, DENY: 1, REQUIRE_APPROVE: 0 },
      modes: { observe: 1, hold: 1, offline: 0 },
    },
    requirements: [
      {
        id: "DP-01",
        domain: "data-privacy",
        title: "Agent tool calls are intercepted",
        severity: "high",
        status: "gap",
        evidence: "0 wired host(s), need 1 — kya connect <host> --hooks",
      },
      {
        id: "SOC-01",
        domain: "society",
        title: "Acceptable-use policy",
        severity: "high",
        status: "attested",
        evidence: "attested 2026-09-01T00:00:00.000Z",
        attestation: { text: "AUP v1 (internal wiki, policy section)", at: "2026-09-01T00:00:00.000Z" },
      },
    ],
    overall: { pass: 0, gap: 1, insufficientEvidence: 0, attested: 1, result: "gap" },
    ...over,
  };
}

describe("renderCertifyHtml", () => {
  it("renders a standalone page with pills, panels, tally, and doctrine footer", () => {
    const html = renderCertifyHtml(reportWith({}));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("agent-trust-baseline");
    expect(html).toContain('class="pill bad"');
    expect(html).toContain('class="pill mute"');
    expect(html).toContain("Data &amp; Privacy");
    expect(html).toContain("Society");
    expect(html).toContain("GAP");
    expect(html).toMatch(/never a policy decision|sole PEP/i);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://"); // standalone: no external assets
    expect(html).not.toContain("<script"); // standalone: no JS
    expect(html.match(/<style/g)).toHaveLength(1); // exactly one inline stylesheet
    expect(html).toContain('role="group" aria-label="Tally"');
  });

  it("renders the empty-gaps branch for a clean pass report", () => {
    const html = renderCertifyHtml(
      reportWith({
        requirements: [
          {
            id: "SEC-01",
            domain: "security",
            title: "Gate mode enforced",
            severity: "high",
            status: "pass",
            evidence: "gate mode is hold",
          },
        ],
        overall: { pass: 1, gap: 0, insufficientEvidence: 0, attested: 0, result: "pass" },
      }),
    );
    expect(html).toContain("PASS");
    expect(html).toContain("No gaps. Evidence-only report");
  });

  it("renders the fail-closed zero-evidence state honestly (no vacuous pass)", () => {
    const report = reportWith({
      requirements: [
        {
          id: "REL-01",
          domain: "reliability",
          title: "ORR freshness",
          severity: "medium",
          status: "insufficient_evidence",
          evidence: "no ORR report — kya orr run --path .",
        },
      ],
      overall: { pass: 0, gap: 0, insufficientEvidence: 1, attested: 0, result: "gap" },
    });
    const html = renderCertifyHtml(report);
    expect(html).toContain("GAP");
    expect(html).toContain('class="pill warn"');
    expect(html).toContain("No certifiable evidence");
    expect(html).not.toContain("No gaps. Evidence-only report");
    const md = formatCertifyMarkdown(report);
    expect(md).toContain("No certifiable evidence");
  });

  it("escapes attacker-controllable text (attestation, titles, evidence)", () => {
    const html = renderCertifyHtml(
      reportWith({
        requirements: [
          {
            id: "SOC-01",
            domain: "society",
            title: "<script>alert(1)</script>",
            severity: "high",
            status: "attested",
            evidence: "attested",
            attestation: {
              text: '"><img src=x onerror=alert(1)>',
              at: "2026-09-01T00:00:00.000Z",
            },
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('"><img');
  });

  it("refuses to render secret-shaped content", () => {
    expect(() =>
      renderCertifyHtml(
        reportWith({
          requirements: [
            {
              id: "SOC-01",
              domain: "society",
              title: "t",
              severity: "high",
              status: "attested",
              evidence: "attested",
              attestation: {
                // secret-shaped test string constructed at runtime (public-mirror push protection)
                text: `key is ${["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("")}`,
                at: "2026-09-01T00:00:00.000Z",
              },
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("markdown renderer covers gaps and domains", () => {
    const md = formatCertifyMarkdown(reportWith({}));
    expect(md).toContain("## Gaps (work plan)");
    expect(md).toContain("**DP-01** [high]");
    expect(md).toContain("| SOC-01 | high | attested |");
  });
});

describe("runCertify html format (integration)", () => {
  it("writes report.html", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-certify-html-"));
    const home = mkdtempSync(join(tmpdir(), "kya-certify-home-"));
    dirs.push(cwd, home);
    const result = runCertify({
      cwd,
      env: { KYA_HOME: home },
      windowDays: 30,
      out: ".kya/certify",
      formats: ["html"],
      jsonStdout: false,
      open: false,
      quiet: true,
      failOn: "never",
      sign: false,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(result.htmlPath).toBe(join(cwd, ".kya", "certify", "report.html"));
  });
});
