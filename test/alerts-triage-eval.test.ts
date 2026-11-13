/**
 * Synthetic triage evaluation set (node N1 of the incident alerting plan).
 * The generator is scripts/gen-triage-eval.mjs. These tests check that the committed files are exactly its
 * output, that every case fits the TriageInput shape, that the classes are balanced and that no real-looking
 * data leaked in. No model is called.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS, CATEGORIES, DETECTOR_IDS, JSONL_FILE, PRODUCTS, REVIEW_FILE, URGENCIES, generate } from "../scripts/gen-triage-eval.mjs";

const SEVERITIES = ["low", "medium", "high", "critical"];
const REASON_CODES = new Set([
  "NEVER_EVENT", "NEVER_SHELL", "NEVER_SECRET_READ", "NEVER_SECRET_WRITE", "NEVER_EXFIL",
  "HIGH_STAKES_WRITE", "HIGH_STAKES_ADMIN", "SHELL_EXEC", "UNKNOWN_TOOL", "POLICY_DENY", "LOW_RISK_READ",
]);
const CLASS_RE = /^(command:[A-Za-z0-9._+-]+|project:[A-Za-z0-9._()/*-]+|secret:[a-z-]+|network:[A-Za-z0-9.-]+|tmp:\/\*\*|system:\/[a-z]+\/\*\*|home:(dot\/\*\*|other)|absolute:other|none)$/;
const HOST_OK = /(^|\.)example\.(com|net|org)$|^registry\.npmjs\.org$|^pypi\.org$|^(203\.0\.113|198\.51\.100|192\.0\.2)\.\d+$/;

interface Case {
  id: string;
  input: Record<string, unknown>;
  labels: Record<string, string>;
  note: string;
}

const raw = readFileSync(JSONL_FILE, "utf8");
const cases: Case[] = raw.trim().split("\n").map((l) => JSON.parse(l) as Case);

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isInt = (v: unknown, min: number): boolean => Number.isInteger(v) && (v as number) >= min;

/** Returns a list of problems; empty means the case fits the shape. */
export function validateCase(c: unknown): string[] {
  const errs: string[] = [];
  const o = c as Case;
  if (typeof o !== "object" || o === null) return ["not an object"];
  if (Object.keys(o).join() !== "id,input,labels,note") errs.push(`keys: ${Object.keys(o).join()}`);
  if (typeof o.id !== "string" || !/^tri-[a-z]{3}-\d{3}$/.test(o.id)) errs.push("id");
  if (typeof o.note !== "string" || o.note.length === 0) errs.push("note");
  const i = o.input as Record<string, unknown> | undefined;
  if (!i || typeof i !== "object") return [...errs, "input"];
  if (i.schemaVersion !== "1") errs.push("schemaVersion");
  if (!isStrArr(i.detectorIds) || i.detectorIds.length === 0 || !i.detectorIds.every((d) => DETECTOR_IDS.includes(d))) errs.push("detectorIds");
  if (!SEVERITIES.includes(i.severity as string)) errs.push("severity");
  if (!isStrArr(i.reasonCodes) || i.reasonCodes.length === 0 || !i.reasonCodes.every((x) => REASON_CODES.has(x))) errs.push("reasonCodes");
  if (!isStrArr(i.neverRules)) errs.push("neverRules");
  if (!isStrArr(i.targetClasses) || i.targetClasses.length === 0 || !i.targetClasses.every((x) => CLASS_RE.test(x))) errs.push("targetClasses");
  if (!isStrArr(i.toolIds) || i.toolIds.length === 0) errs.push("toolIds");
  const n = i.counts as Record<string, unknown> | undefined;
  if (!n || !isInt(n.allow, 0) || !isInt(n.hold, 0) || !isInt(n.deny, 0)) errs.push("counts");
  if (!isInt(i.windowMinutes, 1)) errs.push("windowMinutes");
  if (!isStrArr(i.summaries) || i.summaries.length === 0 || i.summaries.length > 5 || i.summaries.some((s) => s.length === 0 || s.length > 120)) errs.push("summaries");
  if (!PRODUCTS.includes(i.product as string)) errs.push("product");
  if (!isInt(i.repeats, 1)) errs.push("repeats");
  const l = o.labels as Record<string, unknown> | undefined;
  if (!l || typeof l !== "object") return [...errs, "labels"];
  if (!CATEGORIES.includes(l.category as string)) errs.push("labels.category");
  if (!URGENCIES.includes(l.urgency as string)) errs.push("labels.urgency");
  if (!ACTIONS.includes(l.action as string)) errs.push("labels.action");
  if (l.benign !== "yes" && l.benign !== "no") errs.push("labels.benign");
  // Consistency rules the templates must keep.
  if (l.benign === "yes" !== (l.category === "benign-noise")) errs.push("benign only in benign-noise");
  if (isStrArr(i.reasonCodes) && isStrArr(i.neverRules)) {
    const never = i.reasonCodes.some((x) => x.startsWith("NEVER_"));
    if (never !== i.neverRules.length > 0) errs.push("NEVER_ reason code and neverRules disagree");
  }
  if (l.action === "none" && l.urgency !== "ignore" && l.urgency !== "daily-digest") errs.push("action none needs a low urgency");
  if (l.action === "stop-agent" && l.urgency !== "page-now") errs.push("stop-agent needs page-now");
  return errs;
}

describe("triage eval set", () => {
  it("regenerates byte-identical from the generator (determinism)", () => {
    const a = generate();
    const b = generate();
    expect(a.jsonl).toBe(b.jsonl);
    expect(a.jsonl).toBe(raw);
    expect(a.review).toBe(readFileSync(REVIEW_FILE, "utf8"));
  });

  it("has the 300 first cases plus the thin-class top-up, and every case fits the TriageInput shape", () => {
    expect(cases.length).toBeGreaterThanOrEqual(300);
    expect(cases.length).toBeLessThanOrEqual(350);
    const bad = cases.map((c) => ({ id: c.id, errs: validateCase(c) })).filter((x) => x.errs.length > 0);
    expect(bad).toEqual([]);
  });

  it("validator rejects broken cases", () => {
    const good = cases[0]!;
    const copy = (f: (c: Case) => void): Case => {
      const c = JSON.parse(JSON.stringify(good)) as Case;
      f(c);
      return c;
    };
    expect(validateCase(copy((c) => { c.input.severity = "urgent"; }))).toContain("severity");
    expect(validateCase(copy((c) => { c.input.summaries = Array(6).fill("x"); }))).toContain("summaries");
    expect(validateCase(copy((c) => { c.input.summaries = ["x".repeat(121)]; }))).toContain("summaries");
    expect(validateCase(copy((c) => { c.labels.category = "other"; }))).toContain("labels.category");
    expect(validateCase(copy((c) => { c.input.counts = { allow: -1, hold: 0, deny: 0 }; }))).toContain("counts");
  });

  it("ids are unique and no two cases have the same input", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => JSON.stringify(c.input))).size).toBe(cases.length);
  });

  it("class balance: each category 30 to 60 cases, every urgency and action at least 30", () => {
    const count = (f: (c: Case) => string): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const c of cases) m[f(c)] = (m[f(c)] ?? 0) + 1;
      return m;
    };
    const byCat = count((c) => c.labels.category!);
    expect(Object.keys(byCat).sort()).toEqual([...CATEGORIES].sort());
    for (const n of Object.values(byCat)) {
      expect(n).toBeGreaterThanOrEqual(30);
      expect(n).toBeLessThanOrEqual(60);
    }
    const byUrg = count((c) => c.labels.urgency!);
    expect(Object.keys(byUrg).sort()).toEqual([...URGENCIES].sort());
    for (const n of Object.values(byUrg)) {
      expect(n).toBeGreaterThanOrEqual(30);
      expect(n).toBeLessThanOrEqual(cases.length * 0.45);
    }
    const byAct = count((c) => c.labels.action!);
    expect(Object.keys(byAct).sort()).toEqual([...ACTIONS].sort());
    for (const n of Object.values(byAct)) expect(n).toBeGreaterThanOrEqual(30);
    const byProduct = count((c) => c.input.product as string);
    expect(Object.keys(byProduct).sort()).toEqual([...PRODUCTS].sort());
    for (const n of Object.values(byProduct)) expect(n).toBeGreaterThanOrEqual(20);
  });

  it("every category has at least 4 templates in use", () => {
    for (const cat of CATEGORIES) {
      const tpls = new Set(cases.filter((c) => c.labels.category === cat).map((c) => c.note.split(":")[0]));
      expect(tpls.size, cat).toBeGreaterThanOrEqual(4);
    }
  });

  it("has no forbidden content: real paths, secret shapes, real hosts, long dashes", () => {
    const files = [raw, readFileSync(REVIEW_FILE, "utf8"), readFileSync(new URL("../scripts/gen-triage-eval.mjs", import.meta.url), "utf8")];
    for (const text of files) {
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("/home/");
      expect(text).not.toMatch(/AKIA[0-9A-Z]{4}/);
      expect(text).not.toMatch(/ghp_[A-Za-z0-9]/);
      expect(text).not.toMatch(/github_pat_/);
      expect(text).not.toContain("sk_live_");
      expect(text).not.toContain("-----BEGIN");
      expect(text).not.toMatch(/xox[abpr]-/);
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/Co-Authored-By/i);
    }
    for (const c of cases) {
      const i = c.input as { targetClasses: string[]; summaries: string[] };
      for (const cls of i.targetClasses) if (cls.startsWith("network:")) expect(cls.slice(8), c.id).toMatch(HOST_OK);
      for (const s of i.summaries) for (const m of s.matchAll(/https?:\/\/([^/\s]+)/g)) expect(m[1], c.id).toMatch(HOST_OK);
    }
  });

  it("hard cases are present: benign look-alikes, mixed signals, injection, evasion", () => {
    const has = (id: string): boolean => cases.some((c) => c.note.startsWith(`${id}:`));
    for (const id of ["B5", "B6", "B7", "B8", "C7", "E2", "I1", "I2", "I3", "V1", "V6"]) expect(has(id), id).toBe(true);
    const inj = cases.filter((c) => c.labels.category === "prompt-injection-driven");
    expect(inj.every((c) => (c.input.summaries as string[]).some((s) => /ignore previous|print the token|disregard|admin mode|system prompt|send the keys|as root|do not tell|override the policy|forward the env/.test(s)))).toBe(true);
    const evasion = cases.filter((c) => c.note.startsWith("V1:"));
    expect(evasion.every((c) => (c.input.toolIds as string[]).length >= 2)).toBe(true);
  });
});
