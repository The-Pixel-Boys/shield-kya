/**
 * Splunk app guard (integrations/splunk/shield_kya). Ties the app to what KYA really writes:
 * span attribute names come from integrations/otlp-fields.json, trail keys from the TrailEvent type
 * in src/trail.ts, and the transforms.conf regexes run on a real trail file (kya wrap --offline) and on
 * real OpenTelemetry Collector splunk_hec exporter events (integrations/splunk/test/). No Splunk needed.
 * The live checks (AppInspect, package rules) are in integrations/splunk/appinspect.sh and build.py.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPLUNK = join(ROOT, "integrations/splunk");
const APP = join(SPLUNK, "shield_kya");
const read = (p: string): string => readFileSync(p, "utf8");

type Conf = Map<string, Map<string, string>>;
/** Minimal .conf reader: [stanza] and `key = value` lines, # comments. */
function conf(path: string): Conf {
  const out: Conf = new Map();
  let cur = new Map<string, string>();
  out.set("", cur);
  for (const raw of read(path).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      cur = new Map();
      out.set(s[1], cur);
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`cannot parse ${path}: ${line}`);
    cur.set(kv[1], kv[2]);
  }
  return out;
}

const props = conf(join(APP, "default/props.conf"));
const transforms = conf(join(APP, "default/transforms.conf"));
const macros = conf(join(APP, "default/macros.conf"));
const app = conf(join(APP, "default/app.conf"));
const dashboard = read(join(APP, "default/data/ui/views/shield_kya_verdicts.xml"));
const fields = JSON.parse(read(join(ROOT, "integrations/otlp-fields.json"))) as {
  spans: { attributes: { name: string; values?: string[] }[] };
};
const spanAttrs = new Map(fields.spans.attributes.map((a) => [a.name, a]));
const trailKeys = new Set(
  [...(/export interface TrailEvent \{([\s\S]*?)\n\}/.exec(read(join(ROOT, "src/trail.ts")))?.[1] ?? "").matchAll(/readonly (\w+)\??:/g)].map((m) => m[1]),
);
const trailRows = read(join(SPLUNK, "test/trail-sample.jsonl")).trim().split("\n");
const hecRows = read(join(SPLUNK, "test/hec-span-events.jsonl")).trim().split("\n");

/** Fields a sourcetype defines: FIELDALIAS targets, EVAL- names, REPORT- transform outputs. */
function definedFields(sourcetype: string): Set<string> {
  const st = props.get(sourcetype);
  if (!st) throw new Error(`no props stanza ${sourcetype}`);
  const out = new Set<string>();
  for (const [k, v] of st) {
    if (k.startsWith("FIELDALIAS-")) for (const m of v.matchAll(/\S+ AS (\S+)/g)) out.add(m[1]);
    if (k.startsWith("EVAL-")) out.add(k.slice(5));
    if (k.startsWith("REPORT-")) {
      for (const name of v.split(",").map((x) => x.trim())) {
        const t = transforms.get(name);
        if (!t) throw new Error(`${sourcetype} ${k} names missing transform ${name}`);
        out.add(/^(\w+)::/.exec(t.get("FORMAT") ?? "")![1]);
      }
    }
  }
  return out;
}
/** Run one transforms.conf stanza on _raw the way Splunk does (first match, $1). */
function extract(stanza: string, raw: string): string | undefined {
  const t = transforms.get(stanza)!;
  return new RegExp(t.get("REGEX")!).exec(raw)?.[1];
}

describe("Splunk app shield_kya", () => {
  it("app.conf and app.manifest agree with the package rules", () => {
    expect(app.get("package")?.get("id")).toBe("shield_kya");
    const label = app.get("ui")?.get("label") ?? "";
    expect(label.length).toBeGreaterThanOrEqual(5);
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).not.toMatch(/^splunk|for splunk/i);
    const version = app.get("launcher")?.get("version");
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(app.get("id")?.get("version")).toBe(version);
    const manifest = JSON.parse(read(join(APP, "app.manifest")));
    expect(manifest.info.id).toMatchObject({ name: "shield_kya", version });
    expect(manifest.info.title).toBe(label);
  });

  it("has no hidden files, no local/ folder, no inputs.conf and no Python", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? [join(dir, n) + "/", ...walk(join(dir, n))] : [join(dir, n)]));
    const rel = walk(APP).map((p) => p.slice(APP.length + 1));
    expect(rel.filter((p) => p.split("/").some((part) => part.startsWith(".")))).toEqual([]);
    expect(rel).not.toContain("local/");
    // Splunk Cloud refuses [http://...] stanzas in apps (AppInspect check_inputs_conf_for_http_inputs).
    expect(rel).not.toContain("default/inputs.conf");
    expect(rel.filter((p) => p.endsWith(".py"))).toEqual([]);
  });

  it("span EVALs read only attributes KYA emits, trail aliases read only TrailEvent keys", () => {
    for (const [k, v] of props.get("shield:kya:verdict")!) {
      if (!k.startsWith("EVAL-")) continue;
      const attr = /^'attributes\.(.+)'$/.exec(v)?.[1];
      expect(attr && spanAttrs.has(attr), `${k} = ${v}`).toBe(true);
    }
    const alias = props.get("shield:kya:trail")!.get("FIELDALIAS-shield_kya_trail")!;
    for (const m of alias.matchAll(/(\S+) AS \S+/g)) expect(trailKeys.has(m[1]), m[1]).toBe(true);
  });

  it("both sourcetypes define every kya_* field and macro the dashboard uses", () => {
    const used = new Set([...dashboard.matchAll(/\b(kya_\w+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThanOrEqual(6);
    for (const st of ["shield:kya:trail", "shield:kya:verdict"]) {
      const defined = definedFields(st);
      expect([...used].filter((f) => !defined.has(f)), st).toEqual([]);
    }
    for (const m of dashboard.matchAll(/`(\w+)`/g)) expect(macros.has(m[1]), m[1]).toBe(true);
    for (const m of read(join(APP, "default/macros.conf")).matchAll(/`(\w+)`/g)) expect(macros.has(m[1]), m[1]).toBe(true);
  });

  it("dashboard filters only on verdict and reason code values KYA emits", () => {
    const verdicts = spanAttrs.get("kya.verdict")!.values!;
    const reasons = spanAttrs.get("kya.reason_code")!.values!;
    for (const m of dashboard.matchAll(/kya_verdict="([^"]+)"/g)) expect(verdicts).toContain(m[1]);
    for (const m of dashboard.matchAll(/kya_reason_code(?:="([^"]+)"| IN \(([^)]*)\))/g)) {
      for (const v of (m[1] ?? m[2]).split(",").map((x) => x.trim().replace(/"/g, ""))) expect(reasons).toContain(v);
    }
  });

  it("trail index-time settings find the ts value on each real trail line", () => {
    const st = props.get("shield:kya:trail")!;
    // Splunk reads the time right after the first TIME_PREFIX match, in at most MAX_TIMESTAMP_LOOKAHEAD characters.
    const prefix = new RegExp(st.get("TIME_PREFIX")!);
    const lookahead = Number(st.get("MAX_TIMESTAMP_LOOKAHEAD"));
    expect(st.get("TIME_FORMAT")).toBe("%Y-%m-%dT%H:%M:%S.%3NZ");
    expect(st.get("TZ")).toBe("UTC");
    for (const raw of trailRows) {
      const ev = JSON.parse(raw) as { ts: string };
      const m = prefix.exec(raw);
      expect(m, raw).not.toBeNull();
      const at = m!.index + m![0].length;
      const text = raw.slice(at, at + 24);
      expect(text).toBe(ev.ts);
      expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(lookahead).toBeGreaterThanOrEqual(text.length);
    }
  });

  it("transforms extract the MCP server and gate host from a real trail file", () => {
    const rows = trailRows.map((raw) => ({ raw, ev: JSON.parse(raw) as Record<string, unknown> }));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const { raw, ev } of rows) {
      expect(extract("shield_kya_trail_host", raw)).toBe(ev.host);
      const tool = String(ev.toolId);
      expect(extract("shield_kya_mcp_server", raw)).toBe(tool.includes("__") ? tool.split("__")[0] : undefined);
      for (const k of Object.keys(ev)) expect(trailKeys.has(k), k).toBe(true);
    }
    // A server name with a single underscore stays whole; only "__" splits.
    expect(extract("shield_kya_mcp_server", '{"toolId":"my_server__drop_table"}')).toBe("my_server");
  });

  it("transforms and EVAL paths match real splunk_hec exporter span events", () => {
    expect(hecRows.length).toBeGreaterThanOrEqual(4);
    for (const line of hecRows) {
      const hec = JSON.parse(line) as { event: { attributes: Record<string, string> }; sourcetype: string };
      expect(hec.sourcetype).toBe("shield:kya:verdict");
      // Splunk indexes the "event" object as _raw.
      const raw = JSON.stringify(hec.event);
      const tool = hec.event.attributes["gen_ai.tool.name"];
      expect(extract("shield_kya_mcp_server", raw)).toBe(tool.includes("__") ? tool.split("__")[0] : undefined);
      for (const [k, v] of props.get("shield:kya:verdict")!) {
        if (!k.startsWith("EVAL-")) continue;
        const attr = /^'attributes\.(.+)'$/.exec(v)![1];
        expect(hec.event.attributes[attr], `${k} in ${raw}`).toBeTypeOf("string");
      }
    }
  });
});
