import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalConfigDir, kyaHome } from "../src/config.js";
import {
  appendTrail,
  globalTrailPath,
  hostToProduct,
  legacyTrailPath,
  readTrail,
  readTrailSince,
  trailPath,
} from "../src/trail.js";

describe("kyaHome / globalConfigDir", () => {
  it("prefers KYA_HOME over os.homedir()", () => {
    const fake = mkdtempSync(join(tmpdir(), "kya-home-"));
    expect(kyaHome({ KYA_HOME: fake })).toBe(fake);
    expect(globalConfigDir({ KYA_HOME: fake })).toBe(join(fake, ".kya"));
  });

  it("falls back to os.homedir() when KYA_HOME is unset or blank", () => {
    expect(kyaHome({})).toBe(homedir());
    expect(globalConfigDir({})).toBe(join(homedir(), ".kya"));
    expect(kyaHome({ KYA_HOME: "   " })).toBe(kyaHome({}));
  });
});

const baseEvent = {
  ts: "2026-09-15T10:00:00.000Z",
  sessionId: "s1",
  toolId: "Bash",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe" as const,
};

describe("global trail", () => {
  it("appendTrail writes to the global path and stamps project = basename(cwd)", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    const cwd = mkdtempSync(join(tmpdir(), "kya-proj-"));
    appendTrail(cwd, baseEvent, env);
    const globalFile = globalTrailPath(env);
    const lines = readFileSync(globalFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row.project).toBe(cwd.split("/").pop());
    expect(trailPath(cwd, env)).toBe(globalFile);
  });

  it("readTrail merges a legacy per-cwd trail and sorts by ts", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    const cwd = mkdtempSync(join(tmpdir(), "kya-proj-"));
    appendTrail(cwd, { ...baseEvent, ts: "2026-09-15T12:00:00.000Z", toolId: "new" }, env);
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    appendFileSync(
      legacyTrailPath(cwd),
      `${JSON.stringify({ ...baseEvent, ts: "2026-09-15T09:00:00.000Z", toolId: "old" })}\n`,
    );
    const events = readTrail(cwd, env);
    expect(events.map((e) => e.toolId)).toEqual(["old", "new"]);
    expect(events[0]!.project).toBeUndefined(); // legacy rows have no project
    expect(events[1]!.project).toBe(cwd.split("/").pop());
  });

  it("readTrail tolerates a missing global file and a missing legacy file", () => {
    const env = { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-home-")) };
    expect(readTrail(mkdtempSync(join(tmpdir(), "kya-proj-")), env)).toEqual([]);
  });

  it("malformed global lines are dropped without bricking the merge", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath(env),
      `{not json\n${JSON.stringify(baseEvent)}\n${JSON.stringify({ ...baseEvent, mode: "yolo" })}\n`,
    );
    const events = readTrail(mkdtempSync(join(tmpdir(), "kya-proj-")), env);
    expect(events).toHaveLength(1);
    expect(events[0]!.toolId).toBe("Bash");
  });

  it("equal-ts events keep insertion order: global rows before legacy rows", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    const cwd = mkdtempSync(join(tmpdir(), "kya-proj-"));
    const ts = "2026-09-15T10:00:00.000Z";
    appendTrail(cwd, { ...baseEvent, ts, toolId: "global" }, env);
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    appendFileSync(
      legacyTrailPath(cwd),
      `${JSON.stringify({ ...baseEvent, ts, toolId: "legacy" })}\n`,
    );
    const events = readTrail(cwd, env);
    expect(events.map((e) => e.toolId)).toEqual(["global", "legacy"]);
  });

  it("an event with an unparseable ts sorts after every dated event", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    const cwd = mkdtempSync(join(tmpdir(), "kya-proj-"));
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath(env),
      [
        JSON.stringify({ ...baseEvent, ts: "not-a-date", toolId: "broken" }),
        JSON.stringify({ ...baseEvent, ts: "2026-09-15T10:00:00.000Z", toolId: "dated" }),
        "",
      ].join("\n"),
    );
    const events = readTrail(cwd, env);
    expect(events.map((e) => e.toolId)).toEqual(["dated", "broken"]);
  });

  it("cwd === KYA_HOME: legacy path coincides with the global path and rows are not duplicated", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    expect(legacyTrailPath(home)).toBe(globalTrailPath(env));
    appendTrail(home, baseEvent, env);
    const events = readTrail(home, env);
    expect(events).toHaveLength(1);
    expect(events[0]!.toolId).toBe("Bash");
  });

  it("readTrailSince honors the passed env, not process.env", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    const cwd = mkdtempSync(join(tmpdir(), "kya-proj-"));
    appendTrail(cwd, { ...baseEvent, ts: "2026-09-15T10:00:00.000Z", toolId: "old" }, env);
    appendTrail(cwd, { ...baseEvent, ts: "2026-09-15T12:00:00.000Z", toolId: "new" }, env);
    const events = readTrailSince(cwd, new Date("2026-09-15T11:00:00.000Z"), env);
    expect(events.map((e) => e.toolId)).toEqual(["new"]);
    const other = mkdtempSync(join(tmpdir(), "kya-home-"));
    expect(readTrailSince(cwd, new Date(0), { KYA_HOME: other })).toEqual([]);
  });

  it("keeps product kimi", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-home-"));
    const env = { KYA_HOME: home };
    mkdirSync(join(home, ".kya"), { recursive: true });
    appendFileSync(globalTrailPath(env), `${JSON.stringify({ ...baseEvent, product: "kimi" })}\n`);
    expect(readTrail(mkdtempSync(join(tmpdir(), "kya-proj-")), env)[0]!.product).toBe("kimi");
  });
});

describe("hostToProduct", () => {
  it("maps hook host ids to products and falls back to other", () => {
    expect(hostToProduct("claude")).toBe("claude");
    expect(hostToProduct("grok")).toBe("grok");
    expect(hostToProduct("kimi")).toBe("kimi");
    expect(hostToProduct("cursor")).toBe("cursor");
    expect(hostToProduct("codex")).toBe("codex");
    expect(hostToProduct("windsurf")).toBe("other");
  });
});
