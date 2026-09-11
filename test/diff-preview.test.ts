import { describe, expect, it } from "vitest";
import {
  DIFF_MAX_LINES,
  DIFF_MAX_TOTAL_CHARS,
  clipMultiline,
  deriveDiffPreview,
} from "../src/diff-preview.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runWrap } from "../src/commands/wrap.js";
import { readTrail } from "../src/trail.js";
import { assertNoSecrets } from "../src/dash/render.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";

describe("deriveDiffPreview", () => {
  it("builds +/- hunk from old_string/new_string", () => {
    const p = deriveDiffPreview("Edit", {
      path: "a.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    });
    expect(p).toContain("-const x = 1");
    expect(p).toContain("+const x = 2");
  });

  it("accepts camelCase oldString/newString", () => {
    const p = deriveDiffPreview("Edit", {
      path: "a.ts",
      oldString: "a",
      newString: "b",
    });
    expect(p).toContain("-a");
    expect(p).toContain("+b");
  });

  it("clips long write content", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
    const p = deriveDiffPreview("Write", {
      path: "big.ts",
      content: lines.join("\n"),
    });
    expect(p).toBeTruthy();
    expect(p!.split("\n").length).toBeLessThanOrEqual(DIFF_MAX_LINES + 3);
    expect(p!.length).toBeLessThanOrEqual(DIFF_MAX_TOTAL_CHARS + 80);
  });

  it("redacts sk_live_ in preview", () => {
    const p = deriveDiffPreview("Write", {
      path: "env",
      content: "KEY=1\nsk_live_abcdefghijklmnopqrstuv\nOK=1",
    });
    expect(p).toBeTruthy();
    expect(p).not.toMatch(/sk_live_abcdefgh/);
  });

  it("collapses PEM blocks to [redacted-pem]", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAuFAKESECRETKEYMATERIALabcdefghijklmnopqrstuvwxyz0123456789
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrs
-----END RSA PRIVATE KEY-----`;
    const p = deriveDiffPreview("Write", { path: "key.pem", content: pem });
    expect(p).toBe("[redacted-pem]");
    expect(p).not.toMatch(/MIIE/);
    expect(() => assertNoSecrets(p!)).not.toThrow();
  });

  it("redacts lowercase password= assignments", () => {
    const p = deriveDiffPreview("Write", {
      path: ".env",
      content: "password=hunter2\nOK=1",
    });
    expect(p).toBeTruthy();
    expect(p).not.toContain("hunter2");
    expect(p).toMatch(/\[redacted\]|OK=1/);
  });

  it("returns undefined for shell even with diff field", () => {
    expect(
      deriveDiffPreview("Shell", { command: "rm -rf dist", diff: "-a\n+b\n" }),
    ).toBeUndefined();
    expect(
      deriveDiffPreview("Bash", { command: "echo", patch: "-x\n+y\n" }),
    ).toBeUndefined();
  });

  it("does not preview create_todo without a path", () => {
    expect(
      deriveDiffPreview("create_todo", { text: "buy milk" }),
    ).toBeUndefined();
  });

  it("does not match PutObject via bare put substring without path", () => {
    expect(
      deriveDiffPreview("computer", { content: "nope" }),
    ).toBeUndefined();
  });

  it("respects KYA_DIFF_PREVIEW=0", () => {
    expect(
      deriveDiffPreview(
        "Write",
        { path: "a.ts", content: "hi" },
        { KYA_DIFF_PREVIEW: "0" },
      ),
    ).toBeUndefined();
  });

  it("prefers patch lines from diff field on apply_diff", () => {
    const p = deriveDiffPreview("apply_diff", {
      path: "a.ts",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
    });
    expect(p).toContain("-old");
    expect(p).toContain("+new");
  });

  it("clipMultiline preserves newlines", () => {
    const s = clipMultiline("a\nb\nc", 100);
    expect(s).toBe("a\nb\nc");
    expect(clipMultiline("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("wrap + receipt diffPreview", () => {
  it("records diffPreview on trail and renders multiline details", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-diff-"));
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      await runWrap(config, {
        toolId: "Write",
        irreversible: true,
        offline: true,
        args: {
          path: "src/x.ts",
          content: "export const a = 1\nexport const b = 2\n",
        },
      });
      const trail = readTrail(cwd);
      expect(trail[0]?.diffPreview).toBeTruthy();
      expect(trail[0]?.diffPreview).toContain("export const");

      const html = renderReceiptHtml(
        buildWindowReceiptModel(
          [
            {
              ts: new Date().toISOString(),
              sessionId: "s",
              toolId: "Write",
              verdict: "REQUIRE_APPROVE",
              reasonCode: "HIGH_STAKES_WRITE",
              mode: "observe",
              summary: "write src/x.ts (40 chars)",
              diffPreview: "-a\n+b\n<script>alert(1)</script>",
            },
          ],
          3,
        ),
      );
      expect(html).toContain('class="diff"');
      expect(html).toContain("Change preview");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
      // newlines preserved inside <pre>
      expect(html).toMatch(/<pre>-a\n\+b\n/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits diffPreview when env disables", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-diff-off-"));
    const prev = process.env.KYA_DIFF_PREVIEW;
    process.env.KYA_DIFF_PREVIEW = "0";
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      await runWrap(config, {
        toolId: "Write",
        irreversible: true,
        offline: true,
        args: { path: "a.ts", content: "hello" },
      });
      expect(readTrail(cwd)[0]?.diffPreview).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.KYA_DIFF_PREVIEW;
      else process.env.KYA_DIFF_PREVIEW = prev;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("assertNoSecrets gaps closed", () => {
  it("throws on PEM headers and password assignments", () => {
    expect(() => assertNoSecrets("-----BEGIN RSA PRIVATE KEY-----")).toThrow(/secret/);
    expect(() => assertNoSecrets("password=hunter2")).toThrow(/secret/);
    expect(() => assertNoSecrets("password=[redacted]")).not.toThrow();
  });
});
