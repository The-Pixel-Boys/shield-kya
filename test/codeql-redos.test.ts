/**
 * CodeQL js/polynomial-redos and js/incomplete-sanitization backlog (alerts 3, 4, 5, 6, 10, 12, 13, 24).
 * Each attack string is the shape CodeQL names. 100k repetitions must finish well under the limit; the old
 * regexes needed many seconds at this size.
 */
import { describe, expect, it } from "vitest";
import { assertNoSecrets, stripEscapes } from "../src/dash/render.js";
import { deriveDiffPreview } from "../src/diff-preview.js";
import { isSecretPath, trimTrailingSlashes } from "../src/never-list-input.js";
import { redactEvidence } from "../src/orr/agentshield.js";
import { hasPemBlock, replacePemBlocks } from "../src/pem.js";
import { buildWindowReceiptModel, renderReceiptMarkdown } from "../src/receipt/render-receipt.js";
import { deriveTargetPath, redactTrailText, scrubUrl, summarizeShellCommand } from "../src/trail-summary.js";
import type { TrailEvent } from "../src/trail.js";

const N = 100_000;
const LIMIT_MS = 1000;
/** The PEM regex only needs 207 ms at 100k chars, so its attack input is larger. */
const PEM_N = 400_000;
const ESC = "\u001b";
const BEL = "\u0007";

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0 };
}

/** PEM marker built from parts, so no key-looking literal sits in this file. */
function marker(kind: "BEGIN" | "END", label = "PRIVATE KEY"): string {
  return `${"-".repeat(5)}${kind} ${label}${"-".repeat(5)}`;
}

describe("alert 6: stripEscapes OSC", () => {
  it("stays linear on repeated ESC ]", () => {
    expect(timed(() => stripEscapes(`${ESC}]`.repeat(N))).ms).toBeLessThan(LIMIT_MS);
  });
  it("stays linear on ESC ] plus a long unterminated body", () => {
    expect(timed(() => stripEscapes(`${ESC}]0;${"x".repeat(N)}`)).ms).toBeLessThan(LIMIT_MS);
  });
  it("still strips OSC (BEL and ST end), CSI and bare ESC sequences", () => {
    expect(stripEscapes(`a${ESC}]0;title${BEL}b`)).toBe("ab");
    expect(stripEscapes(`a${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\b`)).toBe("alinkb");
    expect(stripEscapes(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripEscapes(`${ESC}]x`)).toBe("x");
    expect(stripEscapes("plain \u202etext\u200b")).toBe("plain text");
  });
});

describe("alert 3: assertNoSecrets scheme scan", () => {
  it("stays linear on a long run of A", () => {
    expect(timed(() => assertNoSecrets("A".repeat(N))).ms).toBeLessThan(LIMIT_MS);
  });
  it("stays linear on repeated scheme markers", () => {
    expect(timed(() => assertNoSecrets("a://x:".repeat(N / 6))).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => assertNoSecrets("A".repeat(N) + "://".repeat(1000))).ms).toBeLessThan(LIMIT_MS);
  });
  it("still rejects URL credentials and accepts plain URLs", () => {
    expect(() => assertNoSecrets("see https://user:hunter2@example.com/x")).toThrow(/secret/);
    expect(() => assertNoSecrets("x git+ssh://u:p@host")).toThrow(/secret/);
    expect(() => assertNoSecrets("first http://ok.example/a then https://u:p@h/")).toThrow(/secret/);
    expect(() => assertNoSecrets("https://example.com/path:with:colons")).not.toThrow();
    expect(() => assertNoSecrets("https://user@example.com/")).not.toThrow();
    expect(() => assertNoSecrets("1://u:p@h")).not.toThrow();
    expect(() => assertNoSecrets("no scheme u:p@h")).not.toThrow();
  });
  it("still checks the other patterns", () => {
    expect(() => assertNoSecrets("x", marker("BEGIN"))).toThrow(/secret/);
    expect(() => assertNoSecrets("npm_abcdefgh1234")).toThrow(/secret/);
  });
});

describe("alerts 10 and 13: PEM block scan", () => {
  const head = marker("BEGIN");
  const pem = `${head}\nMIIB\n${marker("END")}`;
  it("stays linear on repeated BEGIN headers with no END (alert 10 shape)", () => {
    const s = head.repeat(Math.floor(PEM_N / 27));
    const a = timed(() => redactEvidence(s));
    expect(a.ms).toBeLessThan(LIMIT_MS);
    expect(a.out).toBe(s);
  });
  it("stays linear on repeated lowercase headers (alert 13 shape)", () => {
    const s = head.toLowerCase().repeat(Math.floor(PEM_N / 27));
    const a = timed(() => hasPemBlock(s));
    expect(a.ms).toBeLessThan(LIMIT_MS);
    expect(a.out).toBe(false);
    expect(timed(() => redactTrailText(s)).ms).toBeLessThan(LIMIT_MS);
  });
  it("stays linear on repeated complete blocks", () => {
    const a = timed(() => redactEvidence(pem.repeat(N / 60)));
    expect(a.ms).toBeLessThan(LIMIT_MS);
    expect(a.out).toBe("[redacted-pem]".repeat(N / 60));
  });
  it("detects and replaces blocks like the old regex", () => {
    expect(hasPemBlock(`a\n${pem}\nb`)).toBe(true);
    expect(hasPemBlock(`a\n${head}\nno footer`)).toBe(false);
    expect(hasPemBlock(`${marker("BEGIN", "rsa private key")}\nx\n${marker("END", "rsa private key")}`)).toBe(true);
    expect(hasPemBlock("just text")).toBe(false);
    expect(replacePemBlocks(`x ${pem} y ${pem} z`, "[R]")).toBe("x [R] y [R] z");
    expect(replacePemBlocks(`x ${pem} y ${head} z`, "[R]")).toBe(`x [R] y ${head} z`);
    expect(replacePemBlocks("none", "[R]")).toBe("none");
    expect(redactEvidence(`k: ${pem}`)).toBe("k: [redacted-pem]");
    expect(redactTrailText(`k: ${pem} tail`)).toBe("k: [redacted-pem] tail");
    // AgentShield form is case-sensitive and has no digits in the label.
    const lower = `${marker("BEGIN", "rsa PRIVATE KEY")}\nx\n${marker("END", "rsa PRIVATE KEY")}`;
    expect(redactEvidence(lower)).toBe(lower);
  });
  it("diff preview still withholds a PEM body", () => {
    expect(deriveDiffPreview("Write", { path: "k.txt", content: `a\n${pem}\nb` })).toBe("[redacted-pem]");
    expect(deriveDiffPreview("Write", { path: "k.txt", content: `a\n${head}\nno footer` })).not.toBe("[redacted-pem]");
  });
});

describe("alerts 12 and 24: trail summary '#' scans", () => {
  it("scrubUrl stays linear on long runs of delimiters", () => {
    expect(timed(() => scrubUrl("#".repeat(N))).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => scrubUrl("?".repeat(N))).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => scrubUrl("&#".repeat(N / 2))).ms).toBeLessThan(LIMIT_MS);
  });
  it("deriveTargetPath and summarizeShellCommand stay linear on a long run of #", () => {
    expect(timed(() => deriveTargetPath({ path: "#".repeat(N) })).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => summarizeShellCommand("#".repeat(N))).ms).toBeLessThan(LIMIT_MS);
  });
  it("scrubUrl still redacts query values", () => {
    expect(scrubUrl("/a?b=1&c=2")).toBe("/a?b=[redacted]&c=[redacted]");
    expect(scrubUrl("file.txt#frag=secret")).toBe("file.txt#frag=[redacted]");
    expect(scrubUrl("a?b#c=d")).toBe("a?b#c=[redacted]");
    expect(scrubUrl("?a=&b=2")).toBe("?a=&b=[redacted]");
    expect(scrubUrl("plain")).toBe("plain");
    expect(scrubUrl("https://u:p@h.example/p?q=1#f")).toBe("https://h.example/p");
  });
  it("deriveTargetPath still scrubs a query-like path and keeps a plain one", () => {
    expect(deriveTargetPath({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(deriveTargetPath({ path: "out.txt?token=abc" })).toBe("out.txt?token=[redacted]");
    expect(deriveTargetPath({ path: "a#b" })).toBe("a#b");
  });
});

describe("alerts 4 and 5: markdown receipt backslash", () => {
  function md(summary: string): string {
    const e: TrailEvent = {
      ts: new Date().toISOString(),
      sessionId: "s",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary,
    };
    return renderReceiptMarkdown(buildWindowReceiptModel([e], 3));
  }
  it("a backslash cannot cancel the escape of the next character", () => {
    // Before the fix the input `\<b>` became `\\<b>`: Markdown reads `\\` as one literal backslash, so `<b>` was raw HTML.
    const out = md("x \\<b>y\\</b>");
    expect(out).toContain("x \\\\\\<b\\>y\\\\\\</b\\>");
  });
  it("a backslash before a backtick or bracket stays literal", () => {
    expect(md("a\\`b\\[c]")).toContain("a\\\\\\`b\\\\\\[c\\]");
  });
  it("a Windows path keeps its backslashes as literal text", () => {
    expect(md("C:\\Users\\me\\f.txt")).toContain("C:\\\\Users\\\\me\\\\f.txt");
  });
});

/** Small deterministic pseudo-random strings over a chosen alphabet, so the old regex and the new scan can be compared. */
function corpus(alphabet: readonly string[], count: number, maxLen: number): string[] {
  let seed = 12345;
  const next = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 8);
  return Array.from({ length: count }, () =>
    Array.from({ length: next() % (maxLen + 1) }, () => alphabet[next() % alphabet.length]).join(""),
  );
}

describe("render.ts hasUrlCredentials userinfo scan (CodeQL js/polynomial-redos)", () => {
  it("stays linear on many '!' and on '!:' repeats after ://", () => {
    expect(timed(() => assertNoSecrets("a://" + "!".repeat(N))).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => assertNoSecrets("a://!:" + "!:".repeat(N / 2))).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => assertNoSecrets("a://!:".repeat(N / 6))).ms).toBeLessThan(LIMIT_MS);
  });
  it("a long password run with a final @ is still a leak", () => {
    expect(() => assertNoSecrets("a://u:" + "!".repeat(N) + "@h")).toThrow(/secret/);
    expect(() => assertNoSecrets("a://" + "!:".repeat(N / 2) + "@h")).toThrow(/secret/);
  });
  it("decides like the old regex on random small inputs", () => {
    const old = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/;
    const cases = corpus(["a://", "u", ":", "@", "/", " "], 30_000, 10);
    let leaks = 0;
    for (const c of cases) {
      let threw = false;
      try {
        assertNoSecrets(c);
      } catch {
        threw = true;
      }
      // No other pattern in assertNoSecrets can match these alphabets, so the only throw is the URL rule.
      expect(threw, JSON.stringify(c)).toBe(old.test(c));
      if (threw) leaks++;
    }
    expect(leaks).toBeGreaterThan(10);
  });
});

describe("never-list-input.ts trailing-slash trim (CodeQL js/polynomial-redos)", () => {
  it("stays linear on a long run of '/' as the cwd, the home or a path", () => {
    const slashes = "/".repeat(N);
    expect(timed(() => trimTrailingSlashes(slashes + "x" + slashes)).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => isSecretPath("Cookies", "/h" + slashes, ["/c" + slashes])).ms).toBeLessThan(LIMIT_MS);
    expect(timed(() => isSecretPath("Cookies", "/home/me", [slashes + "x" + slashes])).ms).toBeLessThan(LIMIT_MS);
  });
  it("trims like the old regex on random small inputs", () => {
    for (const c of corpus(["/", "a", "."], 2000, 10)) {
      expect(trimTrailingSlashes(c), JSON.stringify(c)).toBe(c.replace(/\/+$/, ""));
    }
  });
  it("still denies a credential file in a home that is spelled with extra slashes", () => {
    for (const slashes of ["", "/", "////"]) {
      expect(isSecretPath(".npmrc", "/data/me", [`/data/me${slashes}`]), slashes).toBe(true);
      expect(isSecretPath(".npmrc", "/data/me" + slashes, ["/data/me"]), slashes).toBe(true);
      expect(isSecretPath(".npmrc", "/data/me", ["/data/other"]), slashes).toBe(false);
    }
  });
  it("a long-slash home does not turn an unrelated cwd into the home", () => {
    expect(isSecretPath(".npmrc", "/data/me" + "/".repeat(N), ["/data/other"])).toBe(false);
    expect(isSecretPath(".npmrc", "/data/me" + "/".repeat(N), ["/data/me" + "/".repeat(N / 2)])).toBe(true);
  });
});
