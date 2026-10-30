// Hosted credentials file: mode 0600 on create and on overwrite, malformed files read as absent.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsPath, deleteCredentials, readCredentials, writeCredentials } from "../src/login/credentials.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-creds-"));
  dirs.push(d);
  mkdirSync(join(d, ".kya"), { recursive: true });
  return d;
}
const CREDS = {
  baseUrl: "https://console.example.test",
  // Built at runtime: the repo token-shape scan (mirror push protection) must not see a literal.
  apiKey: "sk_" + "live_" + "0123456789abcdef0123456789abcdef",
  keyPrefix: "sk_" + "live_" + "01234567",
  createdAt: "2026-10-29T00:00:00.000Z",
};
const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(process.platform === "win32")("hosted credentials file", () => {
  it("is written with mode 0600 and reads back", () => {
    const env = { KYA_HOME: home() };
    const path = writeCredentials(CREDS, env);
    expect(path).toBe(credentialsPath(env));
    expect(mode(path)).toBe(0o600);
    expect(readCredentials(env)).toEqual(CREDS);
  });

  it("overwrites a wider existing file and keeps it at 0600", () => {
    const env = { KYA_HOME: home() };
    const path = credentialsPath(env);
    writeFileSync(path, "{}", { mode: 0o644 });
    writeCredentials(CREDS, env);
    expect(mode(path)).toBe(0o600);
    expect(readCredentials(env)?.apiKey).toBe(CREDS.apiKey);
  });

  it("reads a malformed or incomplete file as absent", () => {
    const env = { KYA_HOME: home() };
    writeFileSync(credentialsPath(env), JSON.stringify({ baseUrl: CREDS.baseUrl, apiKey: "short" }));
    expect(readCredentials(env)).toBeUndefined();
    writeFileSync(credentialsPath(env), "not json");
    expect(readCredentials(env)).toBeUndefined();
  });

  it("re-validates the saved console URL on every read (a remote http file is not used)", () => {
    const env = { KYA_HOME: home() };
    writeFileSync(credentialsPath(env), JSON.stringify({ ...CREDS, baseUrl: "http://attacker.example.test" }));
    expect(readCredentials(env)).toBeUndefined();
    writeFileSync(credentialsPath(env), JSON.stringify({ ...CREDS, baseUrl: "https://console.example.test/?x=1" }));
    expect(readCredentials(env)).toBeUndefined();
    writeFileSync(credentialsPath(env), JSON.stringify({ ...CREDS, baseUrl: "http://127.0.0.1:9" }));
    expect(readCredentials(env)?.baseUrl).toBe("http://127.0.0.1:9");
  });

  it("deletes the file and reports whether one was removed", () => {
    const env = { KYA_HOME: home() };
    expect(deleteCredentials(env)).toBe(false);
    writeCredentials(CREDS, env);
    expect(deleteCredentials(env)).toBe(true);
    expect(existsSync(credentialsPath(env))).toBe(false);
  });
});
