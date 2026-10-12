/**
 * Community dashboards guard (integrations/). Runs scripts/validate-dashboards.mjs
 * over the committed Datadog / Grafana files and proves the field list is tied
 * to what the CLI really emits: the exporter source and a captured OTLP payload
 * (test/fixtures/otlp-capture.json, recorded from the real kya binary).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { datadogMetricRefs, promqlRefs, traceqlRefs, validateDashboards } from "../scripts/validate-dashboards.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(PACKAGE_ROOT, rel), "utf8");
const fields = JSON.parse(read("integrations/otlp-fields.json")) as {
  spans: { resourceAttributes: string[]; attributes: { name: string }[] };
  metrics: { name: string; plane: string; attributes: string[] }[];
};

describe("validate-dashboards", () => {
  it("accepts the committed dashboards, monitors and fixture", () => {
    const { errors, panels } = validateDashboards();
    expect(errors).toEqual([]);
    expect(panels.length).toBeGreaterThanOrEqual(30);
  });

  it("parses the query languages it relies on", () => {
    expect(datadogMetricRefs("count:kya.client.evaluate.latency{$service,$env} by {verdict}.as_count()")).toEqual([
      { name: "kya.client.evaluate.latency", tagKeys: [], groupKeys: ["verdict"] },
    ]);
    expect(traceqlRefs('{resource.service.name="x" && span.gen_ai.tool.name != nil}')).toEqual([
      { scope: "resource", name: "service.name" },
      { scope: "span", name: "gen_ai.tool.name" },
    ]);
    expect(promqlRefs('sum by (le) (rate(kya_x_bucket{job="a"}[5m]))')).toEqual({ names: ["kya_x_bucket"], labels: ["job", "le"] });
  });

  describe("rejects drift", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kya-dash-"));
      cpSync(join(PACKAGE_ROOT, "integrations"), join(dir, "integrations"), { recursive: true });
      mkdirSync(join(dir, "test/fixtures"), { recursive: true });
      cpSync(join(PACKAGE_ROOT, "test/fixtures/otlp-capture.json"), join(dir, "test/fixtures/otlp-capture.json"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const edit = (rel: string, from: string, to: string): void => {
      const path = join(dir, rel);
      const body = readFileSync(path, "utf8");
      expect(body).toContain(from);
      writeFileSync(path, body.split(from).join(to));
    };

    it("flags an attribute KYA does not emit", () => {
      edit("integrations/grafana/kya-dashboard.json", "span.kya.reason_code", "span.kya.reason");
      expect(validateDashboards(dir).errors.join("\n")).toContain("unknown spanAttr kya.reason");
    });

    it("flags a Prometheus name that is not a translation of an emitted metric", () => {
      edit("integrations/grafana/kya-dashboard.json", "kya_client_evaluate_latency_milliseconds_bucket", "kya_client_evaluate_latency_bucket");
      expect(validateDashboards(dir).errors.join("\n")).toContain("kya_client_evaluate_latency_bucket is not a translation");
    });

    it("flags a hosted panel whose title hides that it is hosted only", () => {
      edit("integrations/datadog/kya-dashboard.json", "Hosted kill latency vs SLO ms (hosted only)", "Kill latency vs SLO");
      expect(validateDashboards(dir).errors.join("\n")).toContain('title must say "(hosted only)"');
    });

    it("flags an OSS field missing from the captured payloads", () => {
      edit("test/fixtures/otlp-capture.json", '"key": "kya.mode"', '"key": "kya.mode_renamed"');
      expect(validateDashboards(dir).errors.join("\n")).toContain("kya.mode is not in the captured OTLP fixture");
    });

    it("flags an unscoped TraceQL attribute (typo would hide behind the scope check)", () => {
      edit("integrations/grafana/kya-dashboard.json", 'span.kya.verdict=\\"DENY\\"', '.kya.verdikt=\\"DENY\\"');
      expect(validateDashboards(dir).errors.join("\n")).toContain("unscoped attribute .kya.verdikt");
    });

    it("flags a Datadog span facet without the @ prefix", () => {
      edit("integrations/datadog/kya-dashboard.json", '"facet": "@kya.reason_code"', '"facet": "kya.reason_code"');
      expect(validateDashboards(dir).errors.join("\n")).toContain('span facet kya.reason_code needs the "@" prefix');
    });

    it("flags a hard-coded value KYA never emits", () => {
      edit("integrations/grafana/kya-dashboard.json", 'kya.verdict=\\"DENY\\"', 'kya.verdict=\\"DENNY\\"');
      expect(validateDashboards(dir).errors.join("\n")).toContain("value kya.verdict=DENNY is not one KYA emits");
    });

    it("flags a Datadog metric grouped by the reserved host tag", () => {
      edit("integrations/datadog/kya-dashboard.json", "by {verdict}.as_count()", "by {host}.as_count()");
      expect(validateDashboards(dir).errors.join("\n")).toContain('groups by "host"');
    });

    it("flags a malformed monitor query", () => {
      edit("integrations/datadog/monitors.json", '.last(\\"30m\\") < 1', ".last(30m) < 1");
      expect(validateDashboards(dir).errors.join("\n")).toContain("query is not trace-analytics");
    });
  });
});

describe("otlp-fields.json matches the emitting code", () => {
  it("span attributes equal the keys src/otel/exporter.ts builds", () => {
    const src = read("src/otel/exporter.ts");
    const emitted = [...src.matchAll(/(?:strAttr|intAttr)\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(fields.spans.attributes.map((a) => a.name).sort()).toEqual(emitted);
    const resource = [...src.matchAll(/attr\("(service\.[a-z]+)"/g)].map((m) => m[1]).sort();
    expect([...fields.spans.resourceAttributes].sort()).toEqual(resource);
  });

  it("every allowed attribute value is a string literal in src", () => {
    const literals = new Set<string>();
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/"([A-Za-z_]+)"/g)) literals.add(m[1] as string);
      }
    };
    walk(join(PACKAGE_ROOT, "src"));
    const values = fields.spans.attributes.flatMap((a) => (a as { values?: string[] }).values ?? []);
    expect(values.length).toBeGreaterThan(10);
    expect(values.filter((v) => !literals.has(v))).toEqual([]);
  });

  it("OSS metrics equal the histogram src/otel.ts records", () => {
    const src = read("src/otel.ts");
    const names = [...src.matchAll(/createHistogram\("([^"]+)"/g)].map((m) => m[1]);
    const recordKeys = [...(/\.record\([\s\S]*?\{([^}]*)\}\s*\)/.exec(src)?.[1] ?? "").matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    const oss = fields.metrics.filter((m) => m.plane === "oss");
    expect(oss.map((m) => m.name)).toEqual(names);
    expect(oss[0]?.attributes).toEqual(recordKeys);
  });

  it("the fixture holds ALLOW, REQUIRE_APPROVE and a never-list DENY from the real CLI", () => {
    const doc = JSON.parse(read("test/fixtures/otlp-capture.json")) as {
      traces: { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeSpans: { spans: { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[] }[] }[] }[];
    };
    const spans = doc.traces.flatMap((t) => t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
    const attr = (s: (typeof spans)[number], k: string) => s.attributes.find((a) => a.key === k)?.value.stringValue;
    expect(new Set(spans.map((s) => attr(s, "kya.verdict")))).toEqual(new Set(["ALLOW", "REQUIRE_APPROVE", "DENY"]));
    const drop = spans.find((s) => attr(s, "gen_ai.tool.name") === "postgres__drop_table");
    expect(drop && attr(drop, "kya.reason_code")).toBe("NEVER_EVENT");
    for (const t of doc.traces) {
      expect(t.resourceSpans[0]?.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue).toBe("shield-kya-cli");
    }
  });

  // Monorepo-only guard: the hosted plane source is not part of the public package.
  const hostedBinder = join(PACKAGE_ROOT, "../../app/src/main/java/com/shieldagent/app/kya/KyaMicrometerBinder.java");
  const hostedTimer = join(PACKAGE_ROOT, "../../api/src/main/java/com/shieldagent/api/v1/KyaMeterSupport.java");
  const hostedLlm = join(PACKAGE_ROOT, "../../dispute-agent/src/main/java/com/shieldagent/agent/llm/LlmMeterSupport.java");
  const hosted = [hostedBinder, hostedTimer, hostedLlm];
  it.skipIf(!hosted.every((p) => existsSync(p)))("hosted metrics equal the Micrometer meters", () => {
    const java = hosted.map((p) => readFileSync(p, "utf8")).join("\n");
    const meters = [...java.matchAll(/(?:Gauge|Timer)\.builder\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(fields.metrics.filter((m) => m.plane === "hosted").map((m) => m.name).sort()).toEqual(meters);
  });
});
