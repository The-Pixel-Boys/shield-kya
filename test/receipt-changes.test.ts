import { describe, expect, it } from "vitest";
import {
  buildChangesModel,
  UNKNOWN_FILE,
} from "../src/receipt/changes.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.data.write",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("buildChangesModel", () => {
  it("groups events by session then file", () => {
    const model = buildChangesModel([
      ev({ ts: iso(300), sessionId: "s1", targetPath: "src/a.ts", diffPreview: "+ one" }),
      ev({ ts: iso(200), sessionId: "s1", targetPath: "src/b.ts", diffPreview: "+ two" }),
      ev({ ts: iso(100), sessionId: "s1", targetPath: "src/a.ts", diffPreview: "+ three" }),
      ev({ ts: iso(50), sessionId: "s2", targetPath: "README.md", diffPreview: "+ four" }),
    ]);
    expect(model.sessions).toHaveLength(2);
    const s1 = model.sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const a = s1.files.find((f) => f.path === "src/a.ts")!;
    expect(a.writes).toBe(2);
    expect(a.entries.map((e) => e.preview)).toEqual(["+ one", "+ three"]);
    expect(s1.fileCount).toBe(2);
    expect(s1.changeCount).toBe(3);
    const s2 = model.sessions.find((s) => s.sessionId === "s2")!;
    expect(s2.fileCount).toBe(1);
    expect(s2.changeCount).toBe(1);
  });

  it("sorts sessions by last activity desc and entries chronological within a file", () => {
    const model = buildChangesModel([
      ev({ ts: iso(500), sessionId: "old", targetPath: "a.ts", diffPreview: "x" }),
      ev({ ts: iso(10), sessionId: "new", targetPath: "a.ts", diffPreview: "y" }),
      ev({ ts: iso(400), sessionId: "old", targetPath: "a.ts", diffPreview: "z" }),
    ]);
    expect(model.sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
    const old = model.sessions[1]!;
    expect(old.files[0]!.entries.map((e) => e.preview)).toEqual(["x", "z"]);
    expect(model.sessions[0]!.lastTs >= model.sessions[1]!.lastTs).toBe(true);
  });

  it("buckets events without targetPath under the unknown-file group", () => {
    const model = buildChangesModel([
      ev({ ts: iso(0), sessionId: "s", diffPreview: "+ change" }),
      ev({ ts: iso(1), sessionId: "s", targetPath: "   ", diffPreview: "+ blank" }),
    ]);
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]!.files).toHaveLength(1);
    expect(model.sessions[0]!.files[0]!.path).toBe(UNKNOWN_FILE);
    expect(model.sessions[0]!.files[0]!.writes).toBe(2);
  });

  it("excludes events without a diff preview", () => {
    const model = buildChangesModel([
      ev({ ts: iso(0), sessionId: "s", targetPath: "a.ts" }),
      ev({ ts: iso(1), sessionId: "s", targetPath: "a.ts", diffPreview: "   " }),
      ev({ ts: iso(2), sessionId: "s", targetPath: "a.ts", diffPreview: "+ real" }),
    ]);
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]!.changeCount).toBe(1);
    expect(model.changeCount).toBe(1);
    expect(model.fileCount).toBe(1);
    expect(buildChangesModel([ev({ ts: iso(0), sessionId: "s", targetPath: "a.ts" })]).sessions).toHaveLength(0);
  });

  it("rolls up the worst verdict per file (allow < review < deny < never)", () => {
    const model = buildChangesModel([
      ev({ ts: iso(300), sessionId: "s", targetPath: "a.ts", verdict: "ALLOW", diffPreview: "1" }),
      ev({ ts: iso(200), sessionId: "s", targetPath: "a.ts", verdict: "DENY", reasonCode: "NOPE", diffPreview: "2" }),
      ev({ ts: iso(100), sessionId: "s", targetPath: "a.ts", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD", diffPreview: "3" }),
      ev({ ts: iso(50), sessionId: "s", targetPath: "b.ts", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD", diffPreview: "4" }),
    ]);
    const s = model.sessions[0]!;
    expect(s.files.find((f) => f.path === "a.ts")!.worst).toBe("deny");
    expect(s.files.find((f) => f.path === "b.ts")!.worst).toBe("review");
  });

  it("ranks never-events above deny", () => {
    const model = buildChangesModel([
      ev({ ts: iso(100), sessionId: "s", targetPath: "a.ts", verdict: "DENY", reasonCode: "NOPE", diffPreview: "1" }),
      ev({
        ts: iso(50),
        sessionId: "s",
        targetPath: "a.ts",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
        diffPreview: "2",
      }),
    ]);
    expect(model.sessions[0]!.files[0]!.worst).toBe("never");
  });
});

describe("changes tab rendering", () => {
  const events: TrailEvent[] = [
    ev({
      ts: iso(200),
      sessionId: "sess-a",
      toolId: "org.sample.data.write",
      targetPath: "src/alpha.ts",
      diffPreview: "+ const a = 1;",
      product: "claude",
      project: "dev",
    }),
    ev({
      ts: iso(100),
      sessionId: "sess-a",
      toolId: "org.sample.data.edit",
      verdict: "DENY",
      reasonCode: "DENIED",
      targetPath: "src/alpha.ts",
      diffPreview: "- old\n+ new",
      product: "claude",
      project: "dev",
    }),
    ev({
      ts: iso(50),
      sessionId: "sess-b",
      toolId: "org.sample.data.write",
      diffPreview: "+ readme line",
      product: "cursor",
    }),
  ];
  const html = renderReceiptHtml(buildWindowReceiptModel(events, 3));

  it("renders the Changes tab after Overview with a matching zone", () => {
    const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>"));
    expect(nav.indexOf('href="#overview"')).toBeLessThan(nav.indexOf('href="#changes"'));
    expect(nav.indexOf('href="#changes"')).toBeLessThan(nav.indexOf('href="#certify"'));
    expect(html).toContain('<a class="tab" id="tab-changes" href="#changes">Changes</a>');
    expect(html).toContain('<section class="zone" id="changes" aria-labelledby="tab-changes">');
  });

  it("groups changes by session then file with counts and verdict badges", () => {
    expect(html).toContain('id="changes-list"');
    expect(html).toContain("src/alpha.ts");
    expect(html).toContain("2 writes");
    expect(html).toContain("1 file");
    expect(html).toContain("2 changes");
    expect(html).toContain("+ const a = 1;");
    // Old events without targetPath land in the unknown-file bucket.
    expect(html).toContain("(unknown file)");
  });

  it("stamps the full filter facet set, including data-session, on change entries", () => {
    const zone = html.slice(html.indexOf('id="changes-list"'));
    const firstEntry = zone.slice(zone.indexOf('class="chg-entry'));
    expect(firstEntry).toContain('data-verdict="ALLOW"');
    expect(firstEntry).toContain('data-mode="observe"');
    expect(firstEntry).toContain('data-plane="unknown"');
    expect(firstEntry).toContain('data-product="claude"');
    expect(firstEntry).toContain('data-tool="org.sample.data.write"');
    expect(firstEntry).toContain('data-project="dev"');
    expect(firstEntry).toContain('data-session="sess-a"');
  });

  it("stamps data-session on feed articles", () => {
    const feed = html.slice(html.indexOf('id="feed"'), html.indexOf('id="system"'));
    expect(feed).toContain('data-session="sess-a"');
    expect(feed).toContain('data-session="sess-b"');
  });

  it("renders session rollup rows as session filter chips with file counts", () => {
    expect(html).toContain('data-fgroup="session" data-fvalue="sess-a"');
    expect(html).toContain('data-fgroup="session" data-fvalue="sess-b"');
    expect(html).toContain("1 file changed");
    // The filter engine whitelist must accept the session group.
    expect(html).toContain(" session ");
  });

  it("escapes attacker-controlled paths and previews", () => {
    const evil = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          ev({
            ts: iso(0),
            sessionId: "evil",
            targetPath: `<img src=x onerror=alert(1)>.ts`,
            diffPreview: `<script>alert(2)</script>`,
          }),
        ],
        3,
      ),
    );
    expect(evil).not.toContain("<img src=x");
    expect(evil).not.toContain("<script>alert(2)</script>");
    expect(evil).toContain("&lt;img src=x");
  });

  it("renders the empty state when no previews exist", () => {
    const empty = renderReceiptHtml(
      buildWindowReceiptModel([ev({ ts: iso(0), sessionId: "s", targetPath: "a.ts" })], 3),
    );
    expect(empty).toContain(
      "No recorded changes yet — write/edit tool calls will show up here.",
    );
    expect(empty).toContain('id="changes-list"');
  });
});

describe("changes markdown", () => {
  it("renders a ## Changes section grouped session → file with fenced previews", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel(
        [
          ev({
            ts: iso(100),
            sessionId: "sess-a",
            targetPath: "src/alpha.ts",
            diffPreview: "+ one\n~~~ fenced\n+ two",
          }),
          ev({
            ts: iso(50),
            sessionId: "sess-a",
            diffPreview: "+ unknown",
          }),
        ],
        3,
      ),
    );
    expect(md).toContain("## Changes");
    expect(md).toContain("sess-a");
    expect(md).toContain("src/alpha.ts");
    expect(md).toContain("(unknown file)");
    // Fence must outsize the longest tilde run in the content.
    expect(md).toMatch(/~~~~\n\+ one\n~~~ fenced\n\+ two\n~~~~/);
  });

  it("omits the section when nothing changed", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel([ev({ ts: iso(0), sessionId: "s" })], 3),
    );
    expect(md).not.toContain("## Changes");
  });

  it("flattens hostile targetPath newlines — no raw HTML breakout from the header code span", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel(
        [
          ev({
            ts: iso(0),
            sessionId: "evil",
            targetPath: "a.ts`\n<script>alert(1)</script>",
            diffPreview: "+ ok",
          }),
        ],
        3,
      ),
    );
    expect(md).toContain("## Changes");
    const lines = md.split("\n");
    // The payload survives only as literal text inside the single-line
    // `#### ` code-span header — never as its own raw-HTML line.
    const payloadLines = lines.filter((l) => l.includes("<script>alert(1)</script>"));
    expect(payloadLines).toHaveLength(1);
    expect(payloadLines[0]).toMatch(/^#### `/);
    // Every file-header line is one line with a balanced code span.
    for (const h of lines.filter((l) => l.startsWith("#### "))) {
      expect(h.split("`").length - 1).toBe(2);
    }
  });

  it("sizes the Changes-section tilde fence beyond payload runs (no breakout)", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel(
        [
          ev({
            ts: iso(0),
            sessionId: "s",
            targetPath: "a.ts",
            diffPreview: "before\n~~~~\nmiddle\n~~~~~\nafter",
          }),
        ],
        3,
      ),
    );
    const section = md.slice(md.indexOf("## Changes"));
    const lines = section.split("\n");
    // Fence must be one longer than the longest payload run (5 → 6 tildes).
    const fenceIdx = lines.flatMap((l, i) => (l === "~~~~~~" ? [i] : []));
    expect(fenceIdx).toHaveLength(2);
    const [open, close] = fenceIdx as [number, number];
    for (const payload of ["before", "~~~~", "middle", "~~~~~", "after"]) {
      const at = lines.indexOf(payload);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
  });
});
