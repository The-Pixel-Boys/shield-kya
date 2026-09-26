import { describe, expect, it } from "vitest";
import { computeDashboard, fillBucketWindow } from "../src/receipt/dashboard.js";
import {
  buildReceiptModel,
  buildWindowReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;
// Local-clock helpers: :30 past the hour / noon, so bucket placement never
// straddles an hour/day boundary or DST transition.
const hourAgo = (i: number) => {
  const d = new Date(NOW);
  d.setHours(d.getHours() - i, 30, 0, 0);
  return d.toISOString();
};
const dayAgo = (i: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - i);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

describe("computeDashboard — verdict mix", () => {
  it("counts verdicts and never as a separate overlay", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 6; i++) events.push(ev({ ts: iso(i), sessionId: "s" }));
    for (let i = 0; i < 3; i++) {
      events.push(
        ev({ ts: iso(10 + i), sessionId: "s", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
      );
    }
    // neverEvent rows also count in their verdict bucket (DENY here).
    events.push(
      ev({
        ts: iso(20),
        sessionId: "s",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    );
    const d = computeDashboard(events);
    expect(d.verdictMix).toEqual({ allow: 6, review: 3, deny: 1, never: 1, total: 10 });
  });

  it("handles an empty feed", () => {
    const d = computeDashboard([]);
    expect(d.verdictMix).toEqual({ allow: 0, review: 0, deny: 0, never: 0, total: 0 });
    expect(d.activity.buckets).toEqual([]);
    expect(d.topTools).toEqual([]);
    expect(d.productHotspots).toEqual([]);
    expect(d.projectHotspots).toEqual([]);
  });
});

describe("computeDashboard — activity timeline", () => {
  // Fixed local wall-clock times (Sep 15/16 2026) — immune to when the suite runs.
  const at = (day: 15 | 16, h: number) => new Date(2026, 8, day, h, 30).toISOString();

  it("uses hourly buckets when the span is ≤ 36h", () => {
    const d = computeDashboard([
      ev({ ts: at(15, 10), sessionId: "s" }),
      ev({ ts: at(15, 10), sessionId: "s" }),
      ev({ ts: at(15, 12), sessionId: "s" }),
    ]);
    expect(d.activity.granularity).toBe("hour");
    expect(d.activity.buckets.length).toBe(3);
    // Same-day window: bare hour labels.
    expect(d.activity.buckets.map((b) => b.label)).toEqual(["10:00", "11:00", "12:00"]);
    // The 10:00 bucket holds the two events at 10:30; 11:00 is empty.
    expect(d.activity.buckets[0]?.count).toBe(2);
    expect(d.activity.buckets[1]?.count).toBe(0);
    expect(d.activity.buckets[2]?.count).toBe(1);
    // Buckets ascend chronologically.
    const total = d.activity.buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(3);
  });

  it("prefixes hour labels with the short date when the window crosses midnight", () => {
    const d = computeDashboard([
      ev({ ts: at(15, 22), sessionId: "s" }),
      ev({ ts: at(16, 2), sessionId: "s" }),
    ]);
    expect(d.activity.granularity).toBe("hour");
    expect(d.activity.buckets.map((b) => b.label)).toEqual([
      "Sep 15 22:00",
      "Sep 15 23:00",
      "Sep 16 00:00",
      "Sep 16 01:00",
      "Sep 16 02:00",
    ]);
  });

  it("dedupes bucket starts so a DST spring-forward cannot double a column", () => {
    // Stepping back across a nonexistent 02:00 can map two steps to the same
    // bucket start; feed that case directly to the pure window builder.
    const candidates = [1200, 1100, 1000, 1000, 900, 800];
    const buckets = fillBucketWindow({
      counts: new Map([
        [1000, 2],
        [1100, 1],
        [1200, 3],
      ]),
      latest: 1200,
      earliest: 1000,
      cap: 6,
      stepBack: (_latest, i) => candidates[i]!,
      label: (ms) => `L${ms}`,
    });
    expect(buckets.map((b) => b.label)).toEqual(["L1000", "L1100", "L1200"]);
    expect(buckets.map((b) => b.count)).toEqual([2, 1, 3]);
  });

  it("uses daily buckets when the span exceeds 36h", () => {
    const d = computeDashboard([
      ev({ ts: dayAgo(0), sessionId: "s" }),
      ev({ ts: dayAgo(1), sessionId: "s" }),
      ev({ ts: dayAgo(2), sessionId: "s" }),
    ]);
    expect(d.activity.granularity).toBe("day");
    expect(d.activity.buckets).toHaveLength(3);
    for (const b of d.activity.buckets) expect(b.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.activity.buckets.at(-1)?.count).toBe(1);
  });

  it("treats exactly 36h as hourly and 36h+1ms as daily", () => {
    const at = (span: number) =>
      computeDashboard([
        ev({ ts: iso(0), sessionId: "s" }),
        ev({ ts: iso(span), sessionId: "s" }),
      ]).activity.granularity;
    expect(at(36 * HOUR)).toBe("hour");
    expect(at(36 * HOUR + 1)).toBe("day");
  });

  it("skips events with unparseable timestamps", () => {
    const d = computeDashboard([
      ev({ ts: hourAgo(0), sessionId: "s" }),
      ev({ ts: "not-a-date", sessionId: "s" }),
      ev({ ts: hourAgo(1), sessionId: "s" }),
    ]);
    expect(d.activity.granularity).toBe("hour");
    const total = d.activity.buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(2);

    const none = computeDashboard([ev({ ts: "junk", sessionId: "s" })]);
    expect(none.activity.buckets).toEqual([]);
  });

  it("caps hourly buckets at 24, keeping the most recent", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 30; i++) events.push(ev({ ts: hourAgo(i), sessionId: "s" }));
    // Same ts as hourAgo(0) — guaranteed to land in the most recent bucket.
    for (let i = 0; i < 5; i++) events.push(ev({ ts: hourAgo(0), sessionId: "s" }));
    const d = computeDashboard(events);
    expect(d.activity.granularity).toBe("hour");
    expect(d.activity.buckets).toHaveLength(24);
    // The latest hour holds the 5 extra events + the hourAgo(0) one; the 6
    // oldest hours (hourAgo(24)..hourAgo(29)) are dropped.
    expect(d.activity.buckets.at(-1)?.count).toBe(6);
    const total = d.activity.buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(30 - 6 + 5);
  });

  it("caps daily buckets at 14, keeping the most recent", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(ev({ ts: dayAgo(i), sessionId: "s" }));
    for (let i = 0; i < 3; i++) events.push(ev({ ts: dayAgo(0), sessionId: "s" }));
    const d = computeDashboard(events);
    expect(d.activity.granularity).toBe("day");
    expect(d.activity.buckets).toHaveLength(14);
    expect(d.activity.buckets.at(-1)?.count).toBe(4);
  });
});

describe("computeDashboard — top tools", () => {
  it("ranks by count desc, ties by toolId asc, capped at 8", () => {
    const events: TrailEvent[] = [];
    for (let t = 0; t < 10; t++) {
      for (let i = 0; i < 10 - t; i++) {
        events.push(ev({ ts: iso(t * 100 + i), sessionId: "s", toolId: `tool-${t}` }));
      }
    }
    // Tie pair: two tools with 1 event each beyond the cap check.
    const d = computeDashboard(events);
    expect(d.topTools).toHaveLength(8);
    expect(d.topTools[0]).toMatchObject({ toolId: "tool-0", count: 10, worst: "allow" });
    expect(d.topTools.at(-1)).toMatchObject({ toolId: "tool-7", count: 3 });

    const ties = computeDashboard([
      ev({ ts: iso(0), sessionId: "s", toolId: "zzz" }),
      ev({ ts: iso(1), sessionId: "s", toolId: "aaa" }),
    ]);
    expect(ties.topTools.map((t) => t.toolId)).toEqual(["aaa", "zzz"]);
  });

  it("maps the worst verdict per tool: never > deny > review > allow", () => {
    const d = computeDashboard([
      ev({ ts: iso(0), sessionId: "s", toolId: "t-allow" }),
      ev({ ts: iso(1), sessionId: "s", toolId: "t-review", verdict: "REQUIRE_APPROVE" }),
      ev({ ts: iso(2), sessionId: "s", toolId: "t-deny", verdict: "DENY", reasonCode: "NOPE" }),
      ev({ ts: iso(3), sessionId: "s", toolId: "t-deny", verdict: "REQUIRE_APPROVE" }),
      ev({ ts: iso(4), sessionId: "s", toolId: "t-never" }),
      ev({
        ts: iso(5),
        sessionId: "s",
        toolId: "t-never",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ]);
    const worst = new Map(d.topTools.map((t) => [t.toolId, t.worst]));
    expect(worst.get("t-allow")).toBe("allow");
    expect(worst.get("t-review")).toBe("review");
    expect(worst.get("t-deny")).toBe("deny");
    expect(worst.get("t-never")).toBe("never");
  });
});

describe("computeDashboard — risk hotspots", () => {
  it("counts deny + never per product and project, excluding clean entities", () => {
    const d = computeDashboard([
      ev({ ts: iso(0), sessionId: "s", product: "cursor", project: "web", verdict: "DENY", reasonCode: "NOPE" }),
      ev({ ts: iso(1), sessionId: "s", product: "cursor", project: "web", verdict: "DENY", reasonCode: "NOPE" }),
      ev({
        ts: iso(2),
        sessionId: "s",
        product: "claude",
        project: "api",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
      ev({ ts: iso(3), sessionId: "s", product: "kimi", project: "clean" }),
      ev({ ts: iso(4), sessionId: "s", verdict: "REQUIRE_APPROVE" }),
    ]);
    expect(d.productHotspots).toEqual([
      { label: "Cursor", value: "cursor", count: 2 },
      { label: "Claude Code", value: "claude", count: 1 },
    ]);
    expect(d.projectHotspots).toEqual([
      { label: "web", value: "web", count: 2 },
      { label: "api", value: "api", count: 1 },
    ]);
  });

  it("counts deny and never together, caps at 8, sorted desc", () => {
    const events: TrailEvent[] = [];
    for (let p = 0; p < 10; p++) {
      for (let i = 0; i < 10 - p; i++) {
        events.push(
          ev({
            ts: iso(p * 100 + i),
            sessionId: "s",
            project: `proj-${p}`,
            verdict: "DENY",
            reasonCode: "NOPE",
          }),
        );
      }
    }
    // One project with a deny and a never counts 2.
    events.push(
      ev({ ts: iso(2000), sessionId: "s", project: "proj-8", verdict: "DENY", reasonCode: "NOPE" }),
      ev({
        ts: iso(2001),
        sessionId: "s",
        project: "proj-8",
        verdict: "ALLOW",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    );
    const d = computeDashboard(events);
    expect(d.projectHotspots).toHaveLength(8);
    expect(d.projectHotspots[0]).toMatchObject({ label: "proj-0", count: 10 });
    expect(d.projectHotspots.map((h) => h.label)).not.toContain("proj-9");
    expect(d.projectHotspots.find((h) => h.label === "proj-8")?.count).toBe(4);
  });

  it("counts deny + never per recognized MCP server, excluding unknown servers", () => {
    const d = computeDashboard([
      ev({ ts: iso(0), sessionId: "s", toolId: "mcp__github__delete_branch", verdict: "DENY", reasonCode: "NOPE" }),
      ev({ ts: iso(1), sessionId: "s", toolId: "mcp__github__get_issue", verdict: "DENY", reasonCode: "NOPE" }),
      ev({
        ts: iso(2),
        sessionId: "s",
        toolId: "postgres__drop_table",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
      ev({ ts: iso(3), sessionId: "s", toolId: "mcp__github__create_issue" }),
      ev({ ts: iso(4), sessionId: "s", toolId: "mcp__acme-internal__nuke", verdict: "DENY", reasonCode: "NOPE" }),
    ]);
    expect(d.serverHotspots).toEqual([
      { label: "GitHub", value: "GitHub", count: 2 },
      { label: "PostgreSQL", value: "PostgreSQL", count: 1 },
    ]);
  });
});

describe("dashboard HTML", () => {
  const richEvents: TrailEvent[] = [
    ev({ ts: iso(0), sessionId: "s", toolId: "Bash", product: "cursor", project: "web" }),
    ev({ ts: iso(HOUR), sessionId: "s", toolId: "Bash", product: "cursor", project: "web", verdict: "DENY", reasonCode: "NOPE" }),
    ev({
      ts: iso(2 * HOUR),
      sessionId: "s",
      toolId: "Write",
      product: "claude",
      project: "api",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      neverEvent: true,
    }),
    ev({ ts: iso(3 * HOUR), sessionId: "s", toolId: "Read", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
  ];

  it("renders the dashboard between the blocked banner and the feed", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(richEvents, 3));
    expect(html).toContain('<section class="panel" id="dashboard"');
    expect(html.indexOf('id="dashboard"')).toBeGreaterThan(html.indexOf('class="alert"'));
    expect(html.indexOf('id="dashboard"')).toBeLessThan(html.indexOf('id="feed"'));
    for (const title of ["Verdict mix", "Activity", "Top tools", "Risk hotspots"]) {
      expect(html).toContain(title);
    }
  });

  it("omits the dashboard entirely when there are no events", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).not.toContain('id="dashboard"');
  });

  it("hides the hotspots panel when no deny/never events exist", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          ev({ ts: iso(0), sessionId: "s" }),
          ev({ ts: iso(HOUR), sessionId: "s", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
        ],
        3,
      ),
    );
    expect(html).toContain('id="dashboard"');
    expect(html).not.toContain("Risk hotspots");
    // Zero-count verdict-mix rows are hidden, consistent with the header chips.
    expect(html).toContain('class="db-item" data-fgroup="verdict" data-fvalue="ALLOW"');
    expect(html).toContain('class="db-item" data-fgroup="verdict" data-fvalue="REQUIRE_APPROVE"');
    expect(html).not.toContain('class="db-item" data-fgroup="verdict" data-fvalue="DENY"');
    expect(html).not.toContain('class="db-item" data-fgroup="never"');
  });

  it("marks dashboard rows as filter buttons (fgroup/fvalue/aria-pressed)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(richEvents, 3));
    // Verdict mix rows reuse the verdict/never groups.
    expect(html).toContain('class="db-item" data-fgroup="verdict" data-fvalue="ALLOW" aria-pressed="false"');
    expect(html).toContain('class="db-item" data-fgroup="never" data-fvalue="1" aria-pressed="false"');
    // Top tools rows introduce the tool group.
    expect(html).toContain('class="db-item" data-fgroup="tool" data-fvalue="Bash" aria-pressed="false"');
    // Hotspots reuse product/project groups (raw value, display label).
    expect(html).toMatch(/class="db-item" data-fgroup="product" data-fvalue="cursor" aria-pressed="false"[^>]*>/);
    expect(html).toContain('class="db-item" data-fgroup="project" data-fvalue="web" aria-pressed="false"');
  });

  it("renders a Servers hotspot subsection for deny/never on recognized MCP servers", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          ev({ ts: iso(0), sessionId: "s", toolId: "mcp__github__delete_branch", verdict: "DENY", reasonCode: "NOPE" }),
          ev({ ts: iso(1), sessionId: "s", toolId: "mcp__github__get_issue" }),
        ],
        3,
      ),
    );
    expect(html).toContain("Risk hotspots");
    expect(html).toContain('<p class="sub">Servers</p>');
    expect(html).toContain('class="db-item" data-fgroup="server" data-fvalue="GitHub" aria-pressed="false"');
    // Clean MCP usage without deny/never renders no server hotspot rows.
    const clean = renderReceiptHtml(
      buildWindowReceiptModel(
        [ev({ ts: iso(0), sessionId: "s", toolId: "mcp__github__get_issue" })],
        3,
      ),
    );
    expect(clean).not.toContain('data-fgroup="server" data-fvalue="GitHub" aria-pressed="false"');
  });

  it("stamps data-tool on feed rows, escaped and clipped to 60 chars", () => {
    const long = `t${"x".repeat(100)}`;
    const html = renderReceiptHtml(
      buildReceiptModel(
        "s",
        [
          ev({ ts: iso(0), sessionId: "s", toolId: "Bash" }),
          ev({ ts: iso(1), sessionId: "s", toolId: long }),
        ],
        {},
      ),
    );
    expect(html).toContain('data-tool="Bash"');
    expect(html.match(/data-tool=/g)?.length).toBeGreaterThanOrEqual(2);
    // Clipped to 60 (clip() ends truncated values with an ellipsis).
    const clipped = /data-tool="(t[x…]+)"/.exec(html);
    expect(clipped).toBeTruthy();
    expect(clipped![1]).toHaveLength(60);
  });

  it("escapes hostile toolIds and project names in dashboard markup", () => {
    const xssTool = `<img src=x onerror=alert(1)>`;
    const xssProject = `<svg onload=alert(2)>`;
    const html = renderReceiptHtml(
      buildReceiptModel(
        "s",
        [
          ev({
            ts: iso(0),
            sessionId: "s",
            toolId: xssTool,
            project: xssProject,
            verdict: "DENY",
            reasonCode: "NOPE",
          }),
          ev({ ts: iso(1), sessionId: "s", toolId: "Bash", project: "plain" }),
        ],
        {},
      ),
    );
    expect(html).not.toContain(xssTool);
    expect(html).not.toContain(xssProject);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;svg onload=alert(2)&gt;");
    expect(html).toContain('data-tool="&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('data-fvalue="&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('data-fvalue="&lt;svg onload=alert(2)&gt;"');
    expect(html).not.toContain(`data-fvalue="${xssTool}"`);
    expect(html).not.toContain(`data-fvalue="${xssProject}"`);
  });
});

describe("dashboard Markdown", () => {
  it("renders ## Analytics with mix, timeline, top tools, and hotspots", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel(
        [
          ev({ ts: iso(0), sessionId: "s", toolId: "Bash", product: "cursor", project: "web" }),
          ev({ ts: iso(0), sessionId: "s", toolId: "Bash", product: "cursor", project: "web" }),
          ev({ ts: iso(HOUR), sessionId: "s", toolId: "Bash", product: "cursor", project: "web" }),
          ev({ ts: iso(HOUR), sessionId: "s", toolId: "Write", product: "claude", project: "api", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
          ev({ ts: iso(2 * HOUR), sessionId: "s", toolId: "Write", product: "claude", project: "api", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
          ev({ ts: iso(2 * HOUR), sessionId: "s", toolId: "Write", product: "claude", project: "api", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }),
          ev({ ts: iso(3 * HOUR), sessionId: "s", toolId: "Edit", product: "cursor", project: "web", verdict: "DENY", reasonCode: "NOPE" }),
          ev({ ts: iso(3 * HOUR), sessionId: "s", toolId: "Edit", product: "claude", project: "api", verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true }),
          ev({ ts: iso(4 * HOUR), sessionId: "s", toolId: "Bash" }),
          ev({ ts: iso(4 * HOUR), sessionId: "s", toolId: "Bash" }),
        ],
        3,
      ),
    );
    expect(md).toContain("## Analytics");
    expect(md).not.toContain("## Dashboard");
    expect(md).toContain("Allow 50% · Review 30% · Deny 20% · Never 10%");
    expect(md).toContain("Top tools");
    expect(md).toContain("`Bash` × 5");
    expect(md).toContain("`Edit` × 2 (worst: never)");
    expect(md).toContain("Risk hotspots");
    expect(md).toContain("Cursor × 1");
    expect(md).toContain("web × 1");
    // Timeline rendered as per-line bars.
    expect(md).toMatch(/\d{2}:00 [▁▂▃▄▅▆▇]+ \d/);
  });

  it("omits ## Analytics on an empty model and hotspots without deny/never", () => {
    expect(renderReceiptMarkdown(buildWindowReceiptModel([], 3))).not.toContain("## Analytics");
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel([ev({ ts: iso(0), sessionId: "s" })], 3),
    );
    expect(md).toContain("## Analytics");
    expect(md).not.toContain("Risk hotspots");
  });
});
