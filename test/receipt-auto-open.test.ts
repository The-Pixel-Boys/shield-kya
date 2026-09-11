import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { appendTrail } from "../src/trail.js";
import {
  autoOpenReceiptAfterWrap,
  shouldAutoOpenReceipt,
} from "../src/receipt/auto-open.js";

describe("shouldAutoOpenReceipt", () => {
  it("defaults on for TTY, off for CI", () => {
    expect(shouldAutoOpenReceipt({}, true)).toBe(true);
    expect(shouldAutoOpenReceipt({ CI: "true" }, true)).toBe(false);
    expect(shouldAutoOpenReceipt({}, false)).toBe(false);
  });

  it("respects KYA_RECEIPT_AUTO", () => {
    expect(shouldAutoOpenReceipt({ KYA_RECEIPT_AUTO: "0" }, true)).toBe(false);
    expect(shouldAutoOpenReceipt({ KYA_RECEIPT_AUTO: "1", CI: "true" }, false)).toBe(true);
  });
});

describe("autoOpenReceiptAfterWrap", () => {
  it("writes receipt and marks once-per-cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-auto-"));
    try {
      appendTrail(cwd, {
        ts: new Date().toISOString(),
        sessionId: "s",
        toolId: "org.sample.data.write",
        verdict: "REQUIRE_APPROVE",
        reasonCode: "HIGH_STAKES_WRITE",
        mode: "observe",
      });
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const first = await autoOpenReceiptAfterWrap(config, {
        env: { KYA_RECEIPT_AUTO: "1" },
        isTty: false,
      });
      expect(first.opened).toBe(true);
      expect(first.htmlPath && existsSync(first.htmlPath)).toBe(true);
      expect(existsSync(join(cwd, ".kya", ".receipt-autopen"))).toBe(true);

      const second = await autoOpenReceiptAfterWrap(config, {
        env: { KYA_RECEIPT_AUTO: "1" },
        isTty: false,
      });
      expect(second.opened).toBe(false);
      expect(second.htmlPath).toBeTruthy();

      const forced = await autoOpenReceiptAfterWrap(config, {
        force: true,
        env: { KYA_RECEIPT_AUTO: "1" },
        isTty: false,
      });
      expect(forced.opened).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("disabled returns hint only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-auto-off-"));
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const r = await autoOpenReceiptAfterWrap(config, {
        env: { KYA_RECEIPT_AUTO: "0" },
        isTty: true,
      });
      expect(r.opened).toBe(false);
      expect(r.hint).toContain("kya receipt --open");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
