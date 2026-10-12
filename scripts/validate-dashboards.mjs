#!/usr/bin/env node
/**
 * Validate the community dashboards under integrations/ (plain Node, no deps).
 *
 *   node scripts/validate-dashboards.mjs
 *
 * 1. Every JSON file parses.
 * 2. Required top-level keys per format (Datadog dashboard, Datadog monitors,
 *    Grafana import file with __inputs / __requires).
 * 3. Every span attribute and metric name a query references exists in
 *    integrations/otlp-fields.json, the single list read from the emitting code.
 * 4. Panels that read hosted-only or connected-mode-only metrics say so in
 *    their title.
 * 5. Every OSS name a query references appears in the real captured OTLP
 *    payloads (test/fixtures/otlp-capture.json).
 * 6. Hard-coded attribute values (verdicts, reason codes, modes, hosts) are in
 *    the "values" list of that attribute; unscoped TraceQL attributes, Datadog
 *    span facets without "@", and Datadog metric group-by on the reserved
 *    "host" tag are rejected.
 *
 * Name translation rules this script assumes (documented in docs/dashboards.md):
 * - Datadog keeps OTLP metric and attribute names; span attributes are facets
 *   prefixed with "@".
 * - Prometheus (OTLP receiver, UnderscoreEscapingWithSuffixes, the default):
 *   dots become underscores, unit "ms"/"milliseconds" adds "_milliseconds",
 *   histograms add _bucket/_sum/_count, resource service.name becomes "job".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DATADOG_MONITOR_TYPES = new Set([
  "composite", "event alert", "log alert", "metric alert", "process alert", "query alert",
  "rum alert", "service check", "synthetics alert", "trace-analytics alert", "slo alert",
  "event-v2 alert", "audit alert", "ci-pipelines alert", "ci-tests alert", "error-tracking alert",
  "database-monitoring alert", "network-performance alert", "cost alert", "data-quality alert",
  "network-path alert", "data-jobs alert", "llm-observability alert",
]);
// Backend-reserved tag / label keys that are not KYA attributes.
const DATADOG_RESERVED_TAGS = new Set(["service", "env", "version"]);
// Reserved Datadog span facets that legitimately have no "@" prefix.
const DATADOG_RESERVED_SPAN_FACETS = new Set(["service", "env", "version", "resource_name", "operation_name", "status"]);
const PROM_RESERVED_LABELS = new Set(["job", "instance", "le"]);
const GRAFANA_BUILTIN_VARS = new Set(["__rate_interval", "__interval", "__range"]);

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${path}: does not parse (${err instanceof Error ? err.message : err})`);
    return undefined;
  }
}

/** Load integrations/otlp-fields.json into lookup tables. */
export function loadFields(root = PACKAGE_ROOT) {
  const raw = JSON.parse(readFileSync(join(root, "integrations/otlp-fields.json"), "utf8"));
  const spanAttrs = new Set(raw.spans.attributes.map((a) => a.name));
  const values = new Map(raw.spans.attributes.filter((a) => a.values).map((a) => [a.name, new Set(a.values)]));
  const resourceAttrs = new Set(raw.spans.resourceAttributes);
  const metrics = new Map(raw.metrics.map((m) => [m.name, m]));
  const prom = new Map();
  for (const m of raw.metrics) for (const p of promNames(m)) prom.set(p, m);
  return { raw, spanAttrs, resourceAttrs, metrics, prom, values };
}

/** Prometheus names an OTLP metric becomes under UnderscoreEscapingWithSuffixes. */
export function promNames(metric) {
  const unit = metric.unit === "ms" || metric.unit === "milliseconds" ? "_milliseconds" : "";
  const base = metric.name.replace(/\./g, "_") + unit;
  return metric.type === "histogram" ? [`${base}_bucket`, `${base}_sum`, `${base}_count`] : [base];
}

const DOTTED = "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*";

/** "@kya.verdict:DENY $service" -> ["kya.verdict"] (Datadog span search / facet). */
export function datadogSpanAttrs(text) {
  return [...text.matchAll(new RegExp(`@(${DOTTED})`, "g"))].map((m) => m[1]);
}

/** "@kya.verdict:DENY @kya.reason_code:(A OR B)" -> [{name, value}] (wildcards skipped). */
export function datadogSpanValues(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`@(${DOTTED}):(\\([^)]*\\)|[^\\s)]+)`, "g"))) {
    for (const v of m[2].replace(/^\(|\)$/g, "").split(/\s+OR\s+/)) {
      const value = v.trim();
      if (value && !value.includes("*")) out.push({ name: m[1], value });
    }
  }
  return out;
}

/** "count:kya.x{$service,a:b} by {verdict}.as_count()" -> metric, tag keys, group keys. */
export function datadogMetricRefs(query) {
  const re = new RegExp(`(?:[a-z0-9]+:)?([a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+)\\{([^}]*)\\}(?:\\s*by\\s*\\{([^}]*)\\})?`, "g");
  return [...query.matchAll(re)].map((m) => ({
    name: m[1],
    tagKeys: m[2]
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && t !== "*" && !t.startsWith("$"))
      .map((t) => t.split(":")[0]),
    groupKeys: (m[3] ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  }));
}

/**
 * TraceQL: span.kya.verdict / resource.service.name -> {scope, name}. An
 * unscoped ".kya.verdict" comes back with scope "unscoped" so callers can
 * reject it (it matches span or resource and hides typos from scope checks).
 */
export function traceqlRefs(query) {
  const scoped = [...query.matchAll(new RegExp(`\\b(span|resource)\\.(${DOTTED})`, "g"))].map((m) => ({
    scope: m[1],
    name: m[2],
  }));
  const unscoped = [...query.matchAll(new RegExp(`(?<![\\w.])\\.(${DOTTED})`, "g"))].map((m) => ({
    scope: "unscoped",
    name: m[1],
  }));
  return [...scoped, ...unscoped];
}

/** TraceQL: span.kya.verdict="DENY" / =~"A|B" -> [{name, value}]. */
export function traceqlValues(query) {
  const out = [];
  for (const m of query.matchAll(new RegExp(`\\bspan\\.(${DOTTED})\\s*(=~|!=|=)\\s*"([^"]*)"`, "g"))) {
    const parts = m[2] === "=~" ? m[3].split("|") : [m[3]];
    for (const value of parts) if (value && !/[.*+?\\[\\]]/.test(value)) out.push({ name: m[1], value });
  }
  return out;
}

/** PromQL: kya_* metric names plus label keys used in selectors and by(). */
export function promqlRefs(expr) {
  const names = [...expr.matchAll(/\b(kya_[a-z0-9_]+)\b/g)].map((m) => m[1]);
  const labels = [
    ...[...expr.matchAll(/\{([^}]*)\}/g)].flatMap((m) =>
      [...m[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/g)].map((x) => x[1]),
    ),
    ...[...expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) =>
      m[1].split(",").map((s) => s.trim()).filter(Boolean),
    ),
  ];
  return { names, labels };
}

/** Per-panel references for the Datadog dashboard. */
function datadogPanels(dash, fields, file, errors) {
  for (const key of ["title", "layout_type", "widgets"]) {
    if (dash[key] === undefined) errors.push(`${file}: missing top-level "${key}"`);
  }
  if (!["ordered", "free"].includes(dash.layout_type)) errors.push(`${file}: layout_type must be ordered or free`);
  if (!Array.isArray(dash.widgets) || dash.widgets.length === 0) return [];
  const vars = new Set((dash.template_variables ?? []).map((v) => v.name));
  const panels = [];
  for (const w of dash.widgets) {
    const def = w.definition;
    if (!def?.type) {
      errors.push(`${file}: widget without definition.type`);
      continue;
    }
    if (def.type === "note") continue;
    const refs = [];
    if (!def.title) errors.push(`${file}: ${def.type} widget without a title`);
    if (!Array.isArray(def.requests) || def.requests.length === 0) errors.push(`${file}: "${def.title}" has no requests`);
    for (const req of def.requests ?? []) {
      if (!Array.isArray(req.formulas) || req.formulas.length === 0) errors.push(`${file}: "${def.title}" request without formulas`);
      for (const q of req.queries ?? []) {
        const text = q.search?.query ?? q.query ?? "";
        for (const v of text.matchAll(/\$([a-z_]+)/g)) {
          if (!vars.has(v[1])) errors.push(`${file}: "${def.title}" uses undefined template variable $${v[1]}`);
        }
        if (q.data_source === "spans") {
          if (!q.compute?.aggregation) errors.push(`${file}: "${def.title}" spans query without compute.aggregation`);
          for (const g of q.group_by ?? []) {
            if (!g.facet?.startsWith("@") && !DATADOG_RESERVED_SPAN_FACETS.has(g.facet)) {
              errors.push(`${file}: "${def.title}" span facet ${g.facet} needs the "@" prefix (without it Datadog reads a tag)`);
            }
          }
          const names = [...datadogSpanAttrs(text), ...(q.group_by ?? []).flatMap((g) => datadogSpanAttrs(g.facet))];
          for (const n of names) refs.push({ kind: "spanAttr", name: n });
          for (const v of datadogSpanValues(text)) refs.push({ kind: "value", ...v });
        } else if (q.data_source === "metrics") {
          const found = datadogMetricRefs(text);
          if (found.length === 0) errors.push(`${file}: "${def.title}" metric query names no metric: ${text}`);
          for (const m of found) {
            refs.push({ kind: "metric", name: m.name });
            if (m.groupKeys.includes("host")) {
              errors.push(`${file}: "${def.title}" groups by "host", which is Datadog's reserved hostname tag; KYA's host attribute collides with it`);
            }
            for (const k of [...m.tagKeys, ...m.groupKeys]) {
              if (!DATADOG_RESERVED_TAGS.has(k)) refs.push({ kind: "metricAttr", metric: m.name, name: k });
            }
          }
        } else {
          errors.push(`${file}: "${def.title}" uses unsupported data_source ${q.data_source}`);
        }
      }
    }
    panels.push({ file, title: def.title ?? "", refs });
  }
  return panels;
}

function datadogMonitors(list, fields, file, errors) {
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(`${file}: must be a non-empty array of monitor bodies`);
    return [];
  }
  const panels = [];
  for (const m of list) {
    for (const key of ["name", "type", "query", "message", "options"]) {
      if (m[key] === undefined) errors.push(`${file}: monitor "${m.name ?? "?"}" missing "${key}"`);
    }
    if (!DATADOG_MONITOR_TYPES.has(m.type)) errors.push(`${file}: "${m.name}" has unknown type ${m.type}`);
    const refs = [];
    if (m.type === "trace-analytics alert") {
      const shape = /^trace-analytics\("([^"]*)"\)\.rollup\("count"\)(?:\.by\("[^"]*"\))?\.last\("\d+[mh]"\) (?:<|<=|>|>=) (\d+(?:\.\d+)?)$/;
      const match = shape.exec(m.query ?? "");
      if (!match) {
        errors.push(`${file}: "${m.name}" query is not trace-analytics("...").rollup("count").last("Nm") <op> N`);
      } else {
        const service = /(?:^|\s)service:(\S+)/.exec(match[1])?.[1];
        if (service !== fields.raw.spans.service) errors.push(`${file}: "${m.name}" must filter service:${fields.raw.spans.service}`);
        // Datadog maps resource service.name to the reserved "service" tag.
        else refs.push({ kind: "resourceAttr", name: "service.name" });
        if (Number(match[2]) !== m.options?.thresholds?.critical) {
          errors.push(`${file}: "${m.name}" options.thresholds.critical must equal the query threshold ${match[2]}`);
        }
        for (const n of datadogSpanAttrs(match[1])) refs.push({ kind: "spanAttr", name: n });
        for (const v of datadogSpanValues(match[1])) refs.push({ kind: "value", ...v });
      }
    }
    panels.push({ file, title: m.name ?? "", refs, monitor: true });
  }
  return panels;
}

function grafanaPanels(dash, fields, file, errors) {
  for (const key of ["__inputs", "__requires", "title", "uid", "schemaVersion", "panels", "templating"]) {
    if (dash[key] === undefined) errors.push(`${file}: missing top-level "${key}"`);
  }
  if (typeof dash.schemaVersion !== "number") errors.push(`${file}: schemaVersion must be a number`);
  const inputs = new Set((dash.__inputs ?? []).map((i) => i.name));
  const requiredPanels = new Set((dash.__requires ?? []).filter((r) => r.type === "panel").map((r) => r.id));
  const vars = new Set((dash.templating?.list ?? []).map((v) => v.name));
  const panels = [];
  for (const p of dash.panels ?? []) {
    if (!requiredPanels.has(p.type)) errors.push(`${file}: panel type ${p.type} not listed in __requires`);
    if (p.type === "text") continue;
    const refs = [];
    for (const t of p.targets ?? []) {
      const uid = /^\$\{(DS_[A-Z_]+)\}$/.exec(t.datasource?.uid ?? "")?.[1];
      if (!uid || !inputs.has(uid)) errors.push(`${file}: "${p.title}" target datasource must be a declared \${DS_...} input`);
      const text = t.query ?? t.expr ?? "";
      for (const v of text.matchAll(/\$([a-z_]+)/g)) {
        if (!vars.has(v[1]) && !GRAFANA_BUILTIN_VARS.has(v[1])) errors.push(`${file}: "${p.title}" uses undefined variable $${v[1]}`);
      }
      if (t.datasource?.type === "tempo") {
        for (const r of traceqlRefs(text)) {
          if (r.scope === "unscoped") {
            errors.push(`${file}: "${p.title}" uses unscoped attribute .${r.name}; write span.${r.name} or resource.${r.name}`);
            continue;
          }
          refs.push({ kind: r.scope === "resource" ? "resourceAttr" : "spanAttr", name: r.name });
        }
        for (const v of traceqlValues(text)) refs.push({ kind: "value", ...v });
      } else if (t.datasource?.type === "prometheus") {
        const { names, labels } = promqlRefs(text);
        if (names.length === 0) errors.push(`${file}: "${p.title}" PromQL names no kya_ metric: ${text}`);
        for (const n of names) {
          const meta = fields.prom.get(n);
          if (!meta) {
            errors.push(`${file}: "${p.title}" PromQL metric ${n} is not a translation of any metric in otlp-fields.json`);
            continue;
          }
          refs.push({ kind: "metric", name: meta.name });
          for (const l of labels) if (!PROM_RESERVED_LABELS.has(l)) refs.push({ kind: "metricAttr", metric: meta.name, name: l });
        }
      } else {
        errors.push(`${file}: "${p.title}" uses unsupported datasource type ${t.datasource?.type}`);
      }
    }
    panels.push({ file, title: p.title ?? "", refs });
  }
  return panels;
}

/** Names present in the captured OTLP payloads. */
export function fixtureNames(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const spanAttrs = new Set();
  const resourceAttrs = new Set();
  const metrics = new Set();
  const metricAttrs = new Set();
  for (const req of doc.traces ?? []) {
    for (const rs of req.resourceSpans ?? []) {
      for (const a of rs.resource?.attributes ?? []) resourceAttrs.add(a.key);
      for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) for (const a of s.attributes ?? []) spanAttrs.add(a.key);
    }
  }
  for (const req of doc.metrics ?? []) {
    for (const rm of req.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          metrics.add(m.name);
          const points = m.histogram?.dataPoints ?? m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
          for (const p of points) for (const a of p.attributes ?? []) metricAttrs.add(`${m.name}#${a.key}`);
        }
      }
    }
  }
  return { spanAttrs, resourceAttrs, metrics, metricAttrs };
}

function checkRefs(panels, fields, fixture, errors) {
  for (const p of panels) {
    const where = `${p.file}: "${p.title}"`;
    if (!p.refs.some((r) => r.kind !== "value")) errors.push(`${where} references no KYA field, so nothing ties it to the emitted data`);
    let hosted = false;
    let connected = false;
    for (const r of p.refs) {
      if (r.kind === "value") {
        const allowed = fields.values.get(r.name);
        if (!allowed) errors.push(`${where} filters ${r.name} on a literal value, but otlp-fields.json lists no values for it`);
        else if (!allowed.has(r.value)) errors.push(`${where} value ${r.name}=${r.value} is not one KYA emits`);
        continue;
      }
      if (r.kind === "spanAttr" || r.kind === "resourceAttr") {
        const known = r.kind === "spanAttr" ? fields.spanAttrs : fields.resourceAttrs;
        if (!known.has(r.name)) errors.push(`${where} references unknown ${r.kind} ${r.name}`);
        const seen = r.kind === "spanAttr" ? fixture.spanAttrs : fixture.resourceAttrs;
        if (known.has(r.name) && !seen.has(r.name)) errors.push(`${where} ${r.kind} ${r.name} is not in the captured OTLP fixture`);
        continue;
      }
      const meta = fields.metrics.get(r.kind === "metric" ? r.name : r.metric);
      if (!meta) {
        errors.push(`${where} references unknown metric ${r.name}`);
        continue;
      }
      if (r.kind === "metricAttr" && !meta.attributes.includes(r.name)) {
        errors.push(`${where} groups or filters ${meta.name} by unknown attribute ${r.name}`);
      }
      if (meta.plane === "hosted") hosted = true;
      if (meta.mode === "connected") connected = true;
      if (meta.plane === "oss") {
        if (r.kind === "metric" && !fixture.metrics.has(meta.name)) errors.push(`${where} metric ${meta.name} is not in the captured OTLP fixture`);
        if (r.kind === "metricAttr" && !fixture.metricAttrs.has(`${meta.name}#${r.name}`)) {
          errors.push(`${where} attribute ${r.name} of ${meta.name} is not in the captured OTLP fixture`);
        }
      }
    }
    if (hosted && !p.title.includes("(hosted only)")) errors.push(`${where} reads hosted-only metrics; title must say "(hosted only)"`);
    if (connected && !p.title.includes("(connected mode only)")) errors.push(`${where} reads a connected-mode metric; title must say "(connected mode only)"`);
  }
}

/** Run every check. Returns { errors, panels }. */
export function validateDashboards(root = PACKAGE_ROOT) {
  const errors = [];
  const fields = loadFields(root);
  const fixture = fixtureNames(join(root, "test/fixtures/otlp-capture.json"));
  const panels = [];
  const files = {
    datadog: join(root, "integrations/datadog/kya-dashboard.json"),
    monitors: join(root, "integrations/datadog/monitors.json"),
    grafana: join(root, "integrations/grafana/kya-dashboard.json"),
  };
  for (const [kind, path] of Object.entries(files)) {
    if (!existsSync(path)) {
      errors.push(`${path}: missing`);
      continue;
    }
    const doc = readJson(path, errors);
    if (doc === undefined) continue;
    const rel = path.slice(root.length + 1);
    if (kind === "datadog") panels.push(...datadogPanels(doc, fields, rel, errors));
    if (kind === "monitors") panels.push(...datadogMonitors(doc, fields, rel, errors));
    if (kind === "grafana") panels.push(...grafanaPanels(doc, fields, rel, errors));
  }
  checkRefs(panels, fields, fixture, errors);
  return { errors, panels };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, panels } = validateDashboards();
  for (const e of errors) console.error(`x ${e}`);
  console.log(`${panels.length} panels/monitors checked, ${errors.length} problem(s)`);
  process.exit(errors.length === 0 ? 0 : 1);
}
