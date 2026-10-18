import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSaFirstPartyProbes } from "../src/commands/orr.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-secrets-"));
  dirs.push(d);
  return d;
}

function secretsFinding(root: string) {
  return runSaFirstPartyProbes(root).find(
    (f) => f.id === "sa.probe.secrets_in_tree",
  );
}

describe("orr secrets probe", () => {
  it("ignores .env.example and docs placeholders", () => {
    const root = tmp();
    writeFileSync(
      join(root, ".env.example"),
      'api_key = "abcdefghijklmnop1234567890"\n',
    );
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs", "setup.md"),
      'set api_key: "your_real_key_here_12345" in prod\n',
    );
    writeFileSync(
      join(root, "config.ts"),
      'export const secret = "changeme_placeholder_xx";\n',
    );
    expect(secretsFinding(root)).toBeUndefined();
  });

  it("ignores test fixtures with fake keys", () => {
    const root = tmp();
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "test", "fixtures", "keys.json"),
      '{"api_key": "abcdef1234567890abcdef"}\n',
    );
    expect(secretsFinding(root)).toBeUndefined();
  });

  it("flags a real-looking secret and names the file", () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "config.ts"),
      'export const apiKey = "sk_live_9f8e7d6c5b4a3210";\n',
    );
    const finding = secretsFinding(root);
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("src/config.ts:1");
    expect(finding?.evidence).not.toContain("sk_live_9f8e7d6c5b4a3210");
  });
});
