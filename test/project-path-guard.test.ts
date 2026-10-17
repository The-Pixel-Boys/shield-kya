/**
 * Project-scope writes never leave the project (fs-atomic projectWritePath).
 * A cloned repo can ship `.mcp.json` or `.kya` as a symlink (or a hard link)
 * to a file the user owns elsewhere; `kya connect --project`, `kya start` and
 * `kya init` must refuse with exit 1 and leave that file byte for byte intact.
 * User-level ~/.claude.json behind a dotfiles symlink is still written through.
 * The e2e cases spawn the built dist/cli.js (run `pnpm build` first).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPathError, projectWritePath } from "../src/fs-atomic.js";
import { runInit } from "../src/commands/init.js";
import { recordAttestation } from "../src/certify/attest.js";
import { writeDaemonState } from "../src/receipt/daemon.js";
import { saveSandboxState } from "../src/sandbox/runtime.js";
import { writeOpenshellPolicy } from "../src/sandbox/openshell-policy.js";
import { mergeJsonHostConfig } from "../src/commands/connect.js";
import { maybePrintStarCta, STAR_CTA_MIN_EVENTS } from "../src/star-cta.js";
import { appendTrail } from "../src/trail.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const SECRET = "victim file outside the project, must stay byte for byte\n";

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `kya-ppg-${tag}-`));
}

/** A project dir plus a sibling "outside" dir holding a file the attacker targets. */
function fixture(): { cwd: string; home: string; outside: string; victim: string; done: () => void } {
  const base = tmp("fx");
  const cwd = join(base, "repo");
  const home = join(base, "home");
  const outside = join(base, "outside");
  for (const d of [cwd, home, outside]) mkdirSync(d);
  const victim = join(outside, "authorized_keys");
  writeFileSync(victim, SECRET);
  return { cwd, home, outside, victim, done: () => rmSync(base, { recursive: true, force: true }) };
}

function kya(args: readonly string[], cwd: string, home: string) {
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      KYA_HOME: home,
      KYA_NO_BROWSER: "1",
      KYA_SKIP_NODE_CHECK: "1",
      KYA_OFFLINE: "1",
      KYA_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const noTmp = (dir: string) => expect(readdirSync(dir).filter((f) => f.includes("kya-tmp"))).toEqual([]);

describe.skipIf(!posix)("projectWritePath", () => {
  it("allows a regular file, a missing file and a symlink that stays inside", () => {
    const f = fixture();
    try {
      const reg = join(f.cwd, "a.json");
      writeFileSync(reg, "{}");
      expect(projectWritePath(reg, f.cwd)).toBe(reg);
      expect(projectWritePath(join(f.cwd, "x", "y.json"), f.cwd)).toBe(join(f.cwd, "x", "y.json"));
      symlinkSync("a.json", join(f.cwd, "link.json"));
      expect(projectWritePath(join(f.cwd, "link.json"), f.cwd)).toBe(realpathSync(reg));
    } finally {
      f.done();
    }
  });

  it("refuses a leaf symlink, a parent dir symlink, a dangling link and a hard link", () => {
    const f = fixture();
    try {
      symlinkSync(f.victim, join(f.cwd, ".mcp.json"));
      expect(() => projectWritePath(join(f.cwd, ".mcp.json"), f.cwd)).toThrow(/outside the project/);
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      expect(() => projectWritePath(join(f.cwd, ".kya", "config.json"), f.cwd)).toThrow(/outside the project/);
      expect(() => projectWritePath(join(f.cwd, ".kya"), f.cwd, true)).toThrow(/outside the project/);
      symlinkSync(join(f.outside, "nope", "x.json"), join(f.cwd, "dangling.json"));
      expect(() => projectWritePath(join(f.cwd, "dangling.json"), f.cwd)).toThrow(/dangling symlink/);
      symlinkSync(join(f.outside, "nope"), join(f.cwd, ".cursor"));
      expect(() => projectWritePath(join(f.cwd, ".cursor", "mcp.json"), f.cwd)).toThrow(/dangling symlink/);
      linkSync(f.victim, join(f.cwd, "hard.json"));
      expect(() => projectWritePath(join(f.cwd, "hard.json"), f.cwd)).toThrow(ProjectPathError);
      expect(() => projectWritePath(join(f.cwd, "hard.json"), f.cwd)).toThrow(/hard links/);
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("runInit refuses a .kya directory symlink and an .env.example link, writing nothing outside", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      expect(() => runInit({ cwd: f.cwd })).toThrow(ProjectPathError);
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
      rmSync(join(f.cwd, ".kya"));
      symlinkSync(f.victim, join(f.cwd, ".env.example"));
      expect(() => runInit({ cwd: f.cwd, force: true })).toThrow(/outside the project/);
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });
});

describe.skipIf(!posix)(".kya writers", () => {
  it("certify attestations refuse a .kya link out of the project and a hard linked store", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      expect(() => recordAttestation(f.cwd, "REQ-1", "we checked")).toThrow(ProjectPathError);
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
      rmSync(join(f.cwd, ".kya"));
      mkdirSync(join(f.cwd, ".kya"));
      linkSync(f.victim, join(f.cwd, ".kya", "attestations.json"));
      expect(() => recordAttestation(f.cwd, "REQ-1", "we checked")).toThrow(/hard links/);
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("star CTA still prints but never persists its flag through a .kya link out of the project", () => {
    const f = fixture();
    const prev = process.env.KYA_HOME;
    process.env.KYA_HOME = f.home;
    try {
      for (let i = 0; i < STAR_CTA_MIN_EVENTS; i++) {
        appendTrail(f.cwd, {
          ts: new Date(Date.now() - i * 1000).toISOString(),
          sessionId: `s-${i}`,
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
        });
      }
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      const logs: string[] = [];
      expect(maybePrintStarCta(f.cwd, 3, (m) => logs.push(m))).toBe(true);
      expect(logs).toHaveLength(1);
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      if (prev === undefined) delete process.env.KYA_HOME;
      else process.env.KYA_HOME = prev;
      f.done();
    }
  });

  it("sandbox state and openshell policy refuse a .kya link out of the jail", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      expect(() => saveSandboxState(f.cwd, [])).toThrow(ProjectPathError);
      expect(() => writeOpenshellPolicy(f.cwd, "sbx-00000000-0000-0000-0000-000000000001")).toThrow(ProjectPathError);
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("the generic mcp.json merge refuses a link out of the project when given the root", () => {
    const f = fixture();
    try {
      symlinkSync(f.victim, join(f.cwd, "mcp.json"));
      expect(() => mergeJsonHostConfig(join(f.cwd, "mcp.json"), "mcpServers", {}, false, "shield-kya", f.cwd)).toThrow(
        /outside the project/,
      );
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("receipt daemon state refuses a hard linked state file instead of truncating it", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, ".kya"));
      linkSync(f.victim, join(f.cwd, ".kya", "receipt-server.json"));
      expect(() =>
        writeDaemonState(f.cwd, { pid: 1, port: 1, token: "t", url: "http://127.0.0.1:1/", startedAt: "x" } as never),
      ).toThrow(/hard links/);
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });
});

// Spawns the real CLI (up to three times per case): allow for a loaded CI agent.
describe.skipIf(!posix || !existsSync(cliJs))("e2e: real kya CLI, project symlink guard", { timeout: 30_000 }, () => {
  it("connect --project refuses a .mcp.json symlink to a file outside the project", () => {
    const f = fixture();
    try {
      symlinkSync(f.victim, join(f.cwd, ".mcp.json"));
      const r = kya(["connect", "claude", "--project"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("outside the project");
      expect(r.out).toContain("Replace the symlink with a regular file");
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
      expect(lstatSync(join(f.cwd, ".mcp.json")).isSymbolicLink()).toBe(true);
      noTmp(f.outside);
      noTmp(f.cwd);
    } finally {
      f.done();
    }
  });

  it("connect --project refuses a dangling .mcp.json link and creates nothing outside", () => {
    const f = fixture();
    try {
      symlinkSync(join(f.outside, "made", "evil.json"), join(f.cwd, ".mcp.json"));
      const r = kya(["connect", "claude", "--project"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("dangling symlink");
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("connect --project refuses a hard linked .mcp.json and leaves both names intact", () => {
    const f = fixture();
    try {
      linkSync(f.victim, join(f.cwd, ".mcp.json"));
      const r = kya(["connect", "claude", "--project"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("hard links");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
      expect(lstatSync(join(f.cwd, ".mcp.json")).nlink).toBe(2);
    } finally {
      f.done();
    }
  });

  it("connect --project refuses a .cursor directory symlink out of the project", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".cursor"));
      const r = kya(["connect", "cursor", "--project"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("outside the project");
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("connect --project follows a symlink that stays inside the project", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, "cfg"));
      const real = join(f.cwd, "cfg", "mcp.json");
      writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
      symlinkSync(join("cfg", "mcp.json"), join(f.cwd, ".mcp.json"));
      const r = kya(["connect", "claude", "--project"], f.cwd, f.home);
      expect(r.code).toBe(0);
      const raw = JSON.parse(readFileSync(real, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(raw.mcpServers.other).toBeDefined();
      expect(raw.mcpServers["shield-kya"]).toBeDefined();
      expect(lstatSync(join(f.cwd, ".mcp.json")).isSymbolicLink()).toBe(true);
    } finally {
      f.done();
    }
  });

  it("connect --project on a regular .mcp.json merges as before", () => {
    const f = fixture();
    try {
      const p = join(f.cwd, ".mcp.json");
      writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }));
      const r = kya(["connect", "claude", "--project"], f.cwd, f.home);
      expect(r.code).toBe(0);
      const raw = JSON.parse(readFileSync(p, "utf8")) as { keep: number; mcpServers: Record<string, unknown> };
      expect(raw.keep).toBe(1);
      expect(raw.mcpServers.other).toBeDefined();
      expect(raw.mcpServers["shield-kya"]).toBeDefined();
      expect(lstatSync(p).isFile()).toBe(true);
      noTmp(f.cwd);
    } finally {
      f.done();
    }
  });

  it("user-level ~/.claude.json behind a dotfiles symlink is still written through", () => {
    const f = fixture();
    try {
      const real = join(f.outside, "claude.json");
      writeFileSync(real, JSON.stringify({ theme: "dark" }));
      symlinkSync(real, join(f.home, ".claude.json"));
      const r = kya(["connect", "claude"], f.cwd, f.home);
      expect(r.code).toBe(0);
      const raw = JSON.parse(readFileSync(real, "utf8")) as { theme: string; mcpServers: Record<string, unknown> };
      expect(raw.theme).toBe("dark");
      expect(raw.mcpServers["shield-kya"]).toBeDefined();
      expect(lstatSync(join(f.home, ".claude.json")).isSymbolicLink()).toBe(true);
    } finally {
      f.done();
    }
  });

  it("start refuses a generic mcp.json symlink out of the project", () => {
    const f = fixture();
    try {
      symlinkSync(f.victim, join(f.cwd, "mcp.json"));
      const r = kya(["start"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("outside the project");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("start refuses a .kya/receipts link out of the project and writes nothing at all", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, ".kya"));
      symlinkSync(f.outside, join(f.cwd, ".kya", "receipts"));
      const r = kya(["start"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("outside the project");
      expect(readdirSync(f.cwd)).toEqual([".kya"]);
      expect(readdirSync(join(f.cwd, ".kya"))).toEqual(["receipts"]);
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("certify refuses a .kya link out of the project and a planted report link", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      let r = kya(["certify"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
      rmSync(join(f.cwd, ".kya"));
      mkdirSync(join(f.cwd, ".kya", "certify"), { recursive: true });
      symlinkSync(f.victim, join(f.cwd, ".kya", "certify", "report.md"));
      r = kya(["certify"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("certify through an alias path to the repo still gets the project rules", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      const alias = join(f.home, "lr");
      symlinkSync(f.cwd, alias);
      const r = kya(["certify", "--out", join(alias, ".kya", "certify")], alias, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(r.out).toContain("pass its resolved path");
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("orr refuses a planted leaf link in the default report dir", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, "orr-report"));
      symlinkSync(f.victim, join(f.cwd, "orr-report", "report.md"));
      const r = kya(["orr", "run", "--path", ".", "--skip-optional-producers", "--quiet"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
    } finally {
      f.done();
    }
  });

  it("orr refuses a default ./orr-report link out of the project", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, "orr-report"));
      const r = kya(["orr", "run", "--path", ".", "--skip-optional-producers", "--quiet"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PROJECT_PATH_REFUSED");
      expect(readdirSync(f.outside)).toEqual(["authorized_keys"]);
    } finally {
      f.done();
    }
  });

  it("an explicit output dir outside the project replaces a planted leaf link instead of following it", () => {
    const f = fixture();
    try {
      const out = join(f.home, "out");
      mkdirSync(out);
      symlinkSync(f.victim, join(out, "last-3d.md"));
      const r = kya(["receipt", "--out-dir", out], f.cwd, f.home);
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
      expect(lstatSync(join(out, "last-3d.md")).isFile()).toBe(true);
    } finally {
      f.done();
    }
  });

  it("start refuses a .mcp.json symlink out of the project before writing anything", () => {
    const f = fixture();
    try {
      symlinkSync(f.victim, join(f.cwd, ".mcp.json"));
      const r = kya(["start"], f.cwd, f.home);
      expect(r.code).toBe(1);
      expect(r.out).toContain("outside the project");
      expect(readFileSync(f.victim, "utf8")).toBe(SECRET);
      expect(existsSync(join(f.cwd, ".kya"))).toBe(false);
      noTmp(f.outside);
    } finally {
      f.done();
    }
  });

  it("start, init and receipt refuse a .kya directory symlink out of the project", () => {
    const f = fixture();
    try {
      symlinkSync(f.outside, join(f.cwd, ".kya"));
      for (const cmd of ["start", "init", "receipt"]) {
        const r = kya([cmd], f.cwd, f.home);
        expect(r.code, cmd).toBe(1);
        expect(r.out, cmd).toContain("outside the project");
        expect(readdirSync(f.outside), cmd).toEqual(["authorized_keys"]);
      }
    } finally {
      f.done();
    }
  });
});
