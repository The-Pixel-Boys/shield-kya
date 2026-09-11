import { describe, expect, it } from "vitest";
import {
  deriveTrailSummary,
  scrubUrl,
  summarizeShellCommand,
} from "../src/trail-summary.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runWrap } from "../src/commands/wrap.js";
import { readTrail } from "../src/trail.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";

describe("deriveTrailSummary", () => {
  it("summarizes file writes with path and size hint", () => {
    expect(
      deriveTrailSummary("org.sample.data.write", {
        path: "apps/dashboard/lib/foo.ts",
        content: "x".repeat(42),
      }),
    ).toBe("write apps/dashboard/lib/foo.ts (42 chars)");
  });

  it("summarizes shell as bin + arg count, not full command", () => {
    expect(
      deriveTrailSummary("org.sample.shell.exec", {
        command: "rm -rf dist",
      }),
    ).toBe("shell rm (+2 args)");
    expect(summarizeShellCommand("AWS_SECRET_ACCESS_KEY=wJalrX aws s3 ls")).toBe(
      "shell aws (+2 args)",
    );
  });

  it("scrubs tokens in URL-shaped command strings", () => {
    const s = deriveTrailSummary("org.sample.shell.exec", {
      command: "https://api.example.com/v1?access_token=SHORTSECRET99",
    });
    expect(s).not.toContain("SHORTSECRET99");
    expect(s).toContain("https://api.example.com/v1");
  });

  it("does not fall back to header/cookie blobs", () => {
    const s = deriveTrailSummary("org.sample.data.write", {
      header: "Cookie: session=abc123secretvalue",
    });
    expect(s).toBe("(no safe summary)");
    expect(s).not.toContain("abc123");
  });

  it("redacts secrets that would enter the summary string", () => {
    const viaPath = deriveTrailSummary("org.sample.data.write", {
      path: "cfg.env",
      content: "sk_live_abcdefghijklmnopqrstuv",
    });
    expect(viaPath).toContain("cfg.env");
    expect(viaPath).not.toMatch(/sk_live_abcdefgh/);

    const viaUrl = deriveTrailSummary("org.sample.data.write", {
      url: "https://example.com/x?access_token=supersecretTOKEN123",
    });
    expect(viaUrl).not.toContain("supersecretTOKEN123");
    expect(viaUrl).toContain("https://example.com/x");

    const viaAccessToken = deriveTrailSummary("org.sample.data.write", {
      accessToken: "sk_live_shouldneverappear",
      path: "ok.ts",
    });
    expect(viaAccessToken).toContain("ok.ts");
    expect(viaAccessToken).not.toContain("sk_live_shouldneverappear");

    const viaClientSecret = deriveTrailSummary("org.sample.data.write", {
      client_secret: "shh",
      note: "hello",
    });
    expect(viaClientSecret).not.toContain("shh");
    expect(viaClientSecret).toContain("hello");
  });

  it("does not dump bare string args", () => {
    const s = deriveTrailSummary("org.sample.data.write", "sk_live_abcdefghijklmnopqrstuv");
    expect(s).toMatch(/chars/);
    expect(s).not.toContain("sk_live_");
  });

  it("returns undefined without useful args", () => {
    expect(deriveTrailSummary("org.sample.safe.read")).toBeUndefined();
  });

  it("placeholder when args exist but nothing safe", () => {
    expect(
      deriveTrailSummary("org.sample.data.write", {
        password: "x",
        token: "y",
      }),
    ).toBe("(no safe summary)");
  });

  it("clips long summaries", () => {
    const s = deriveTrailSummary("org.sample.data.write", {
      path: "a/" + "b".repeat(200) + ".ts",
    });
    expect(s!.length).toBeLessThanOrEqual(80);
    expect(s!.endsWith("…")).toBe(true);
  });

  it("scrubUrl strips query and userinfo", () => {
    expect(scrubUrl("https://user:pass@example.com/a?token=1#frag")).toBe(
      "https://example.com/a",
    );
  });
});

describe("wrap trail summary", () => {
  it("records summary on trail from wrap args", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-sum-"));
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      await runWrap(config, {
        toolId: "org.sample.data.write",
        irreversible: true,
        offline: true,
        args: { path: "src/x.ts", content: "hello" },
      });
      const trail = readTrail(cwd);
      expect(trail[0]?.summary).toContain("src/x.ts");
      expect(trail[0]?.summary).toContain("5 chars");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("receipt summary line", () => {
  it("renders summary in the feed", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          {
            ts: new Date().toISOString(),
            sessionId: "s",
            product: "cursor",
            toolId: "org.sample.data.write",
            verdict: "REQUIRE_APPROVE",
            reasonCode: "HIGH_STAKES_WRITE",
            mode: "observe",
            summary: "write apps/foo.ts (12 chars)",
          },
        ],
        3,
      ),
    );
    expect(html).toContain('class="summary"');
    expect(html).toContain("write apps/foo.ts (12 chars)");
  });

  it("escapes hostile summary HTML", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          {
            ts: new Date().toISOString(),
            sessionId: "s",
            toolId: "org.sample.data.write",
            verdict: "ALLOW",
            reasonCode: "ALLOW",
            mode: "observe",
            summary: `<script>alert(1)</script> & "x"`,
          },
        ],
        3,
      ),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("omits blank summary lines", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          {
            ts: new Date().toISOString(),
            sessionId: "s",
            toolId: "org.sample.safe.read",
            verdict: "ALLOW",
            reasonCode: "ALLOW",
            mode: "observe",
            summary: "   ",
          },
        ],
        3,
      ),
    );
    expect(html).not.toContain('class="summary"');
  });
});
