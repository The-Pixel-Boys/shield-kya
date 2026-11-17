/**
 * Honest verdicts (first-run spec F3): the trail `outcome` field, counts and labels by outcome in the report,
 * collapse and sort of the feed, the share summary and `kya certify` counts. The real-CLI path is in
 * honest-verdicts-e2e.test.ts. Offline verdicts are pinned here (no verdict change, only tests).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../src/commands/hook.js";
import { evaluateOffline } from "../src/offline-evaluate.js";
import { trailStats } from "../src/certify/evaluate.js";
import { formatCertifyMarkdown } from "../src/certify/render.js";
import { computeDashboard, worstOf } from "../src/receipt/dashboard.js";
import { buildSharePayload } from "../src/receipt/share.js";
import {
  aggregateEvents,
  buildWindowReceiptModel,
  collapseFeedRows,
  renderFeedPage,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { eventMatchesFilter } from "../src/receipt/search.js";
import { countOutcomes, outcomeOf, readTrail, wouldHoldInStrict, type TrailEvent } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const NOW = Date.now();
const iso = (n: number) => new Date(NOW - n * 1000).toISOString();
function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts">): TrailEvent {
  return { sessionId: "s", toolId: "Bash", verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC", mode: "offline", ...partial };
}
const ran = (n: number, extra: Partial<TrailEvent> = {}) => ev({ ts: iso(n), outcome: "ran", summary: "shell echo (+1 args)", argsHash: "h1", ...extra });
const blocked = (n: number, extra: Partial<TrailEvent> = {}) =>
  ev({ ts: iso(n), outcome: "blocked", verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true, summary: "shell rm (+2 args)", ...extra });

describe("offline verdicts stay the policy opinion (no verdict change)", () => {
  const verdictOf = (toolId: string) => evaluateOffline({ toolId, irreversible: false } as never, "ide", { command: "echo hi" }).verdict;
  it("a shell call is still REQUIRE_APPROVE with SHELL_EXEC; the outcome is the hook's, not the evaluator's", () => {
    const r = evaluateOffline({ toolId: "Bash" } as never, "ide", { command: "echo hi" });
    expect(r).toMatchObject({ verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC" });
    expect(r).not.toHaveProperty("outcome");
    expect(verdictOf("Read")).toBe("ALLOW");
  });
});

describe("trail outcome field", () => {
  it("reads valid outcomes, drops a bad value, and keeps old lines (no outcome) readable", () => {
    const home = tmp("kya-f3-trail-");
    mkdirSync(join(home, ".kya"), { recursive: true });
    const base = { sessionId: "s", toolId: "Bash", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" };
    const lines = [
      { ts: iso(5), ...base, outcome: "ran" },
      { ts: iso(4), ...base, outcome: "blocked" },
      { ts: iso(3), ...base, outcome: "held" },
      { ts: iso(2), ...base, outcome: "error" },
      { ts: iso(1), ...base, outcome: "nonsense" },
      { ts: iso(0), ...base },
    ];
    appendFileSync(join(home, ".kya", "trail.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const rows = readTrail(home, { KYA_HOME: home });
    expect(rows.map((r) => r.outcome)).toEqual(["ran", "blocked", "held", "error", undefined, undefined]);
  });

  it("outcomeOf, wouldHoldInStrict and countOutcomes", () => {
    expect(outcomeOf({ outcome: "ran" })).toBe("ran");
    expect(outcomeOf({ outcome: "x" })).toBeUndefined();
    expect(outcomeOf({})).toBeUndefined();
    expect(wouldHoldInStrict({ verdict: "REQUIRE_APPROVE", outcome: "ran" })).toBe(true);
    expect(wouldHoldInStrict({ verdict: "REQUIRE_APPROVE", outcome: "held" })).toBe(false);
    expect(wouldHoldInStrict({ verdict: "REQUIRE_APPROVE" })).toBe(false);
    expect(wouldHoldInStrict({ verdict: "ALLOW", outcome: "ran" })).toBe(false);
    const c = countOutcomes([ran(1), ran(2), blocked(3), ev({ ts: iso(4), outcome: "held" }), ev({ ts: iso(5), outcome: "error" }), ev({ ts: iso(6) })]);
    expect(c).toEqual({ ran: 2, blocked: 1, held: 1, error: 1, recorded: 5, legacy: 1, wouldHold: 2 });
  });

  it("filter group outcome matches the stored outcome only", () => {
    expect(eventMatchesFilter(ran(1), "outcome", "ran")).toBe(true);
    expect(eventMatchesFilter(ran(1), "outcome", "blocked")).toBe(false);
    expect(eventMatchesFilter(ev({ ts: iso(1) }), "outcome", "ran")).toBe(false);
  });
});

describe("hook writes outcome (unit)", () => {
  const stdin = (tool: string, input: unknown) =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "u", tool_name: tool, tool_use_id: `${tool}-${Math.random()}`, tool_input: input });
  async function once(over: { strict?: boolean; failClosed?: boolean; tool?: string; input?: unknown; evaluate?: never }) {
    const home = tmp("kya-f3-hook-");
    const cwd = tmp("kya-f3-cwd-");
    const r = await runHook({
      host: "claude",
      strict: over.strict ?? false,
      failClosed: over.failClosed,
      stdinText: stdin(over.tool ?? "Bash", over.input ?? { command: "echo hi" }),
      env: { HOME: home, KYA_HOME: home, KYA_OFFLINE: "1" },
      cwd,
      ...(over.evaluate ? { evaluate: over.evaluate } : {}),
    });
    return { r, rows: readTrail(cwd, { KYA_HOME: home }) };
  }
  it("exit 0 with REQUIRE_APPROVE is ran; the verdict is kept", async () => {
    const { r, rows } = await once({});
    expect(r.exitCode).toBe(0);
    expect(rows[0]).toMatchObject({ verdict: "REQUIRE_APPROVE", outcome: "ran" });
  });
  it("strict mode: REQUIRE_APPROVE is held (exit 2)", async () => {
    const { r, rows } = await once({ strict: true });
    expect(r.exitCode).toBe(2);
    expect(rows[0]).toMatchObject({ verdict: "REQUIRE_APPROVE", outcome: "held" });
  });
  it("DENY is blocked in both modes", async () => {
    for (const strict of [false, true]) {
      const { r, rows } = await once({ strict, tool: "mcp__postgres__drop_table", input: {} });
      expect(r.exitCode).toBe(2);
      expect(rows[0]).toMatchObject({ verdict: "DENY", outcome: "blocked" });
    }
  });
  it("an evaluator failure: fail-open leaves an error row, fail-closed a blocked row", async () => {
    const boom = (() => { throw new Error("boom"); }) as never;
    const open = await once({ evaluate: boom });
    expect(open.r.exitCode).toBe(0);
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0]).toMatchObject({ outcome: "error", reasonCode: "HOOK_ERROR", toolId: "Bash" });
    const closed = await once({ evaluate: boom, failClosed: true });
    expect(closed.r.exitCode).toBe(2);
    expect(closed.rows[0]).toMatchObject({ outcome: "blocked", reasonCode: "FAIL_CLOSED" });
  });
  it("a failure while writing the error row never re-enters the handler: fail-open exit 0 with one stderr line, fail-closed exit 2", async () => {
    // KYA_HOME is a regular file, so the trail directory cannot be created: every trail write throws.
    const base = tmp("kya-f3-badhome-");
    const badHome = join(base, "not-a-dir");
    writeFileSync(badHome, "x");
    const cwd = tmp("kya-f3-cwd-");
    let calls = 0;
    const evaluate = (() => { calls++; throw new Error("boom"); }) as never;
    const run = (failClosed: boolean) =>
      runHook({
        host: "claude",
        strict: false,
        failClosed,
        stdinText: stdin("Bash", { command: "echo hi" }),
        env: { HOME: base, KYA_HOME: badHome, KYA_OFFLINE: "1" },
        cwd,
        evaluate,
      });
    const open = await run(false);
    expect(open.exitCode).toBe(0);
    expect(open.stdout).toBe("");
    expect(open.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(open.stderr).toContain("error recording a failed hook call");
    expect(calls).toBe(1);
    const closed = await run(true);
    expect(closed.exitCode).toBe(2);
    expect(closed.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(closed.stderr).toContain("KYA fail-closed: internal error");
    expect(calls).toBe(2);
  });
  it("an unreadable payload fail-open writes no row (no call to count)", async () => {
    const home = tmp("kya-f3-hook-");
    const cwd = tmp("kya-f3-cwd-");
    const r = await runHook({ host: "claude", strict: false, stdinText: "not json", env: { HOME: home, KYA_HOME: home }, cwd });
    expect(r.exitCode).toBe(0);
    expect(readTrail(cwd, { KYA_HOME: home })).toHaveLength(0);
  });
});

describe("collapse and sort", () => {
  it("collapses identical consecutive rows into one with a count", () => {
    const rows = collapseFeedRows([ran(1), ran(2), ran(3)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });
  it("does not collapse across a different row, a different command hash, blocked rows, change previews or old rows", () => {
    expect(collapseFeedRows([ran(1), ran(2, { summary: "shell ls" }), ran(3)]).map((r) => r.count)).toEqual([1, 1, 1]);
    expect(collapseFeedRows([ran(1), ran(2, { argsHash: "h2" })]).map((r) => r.count)).toEqual([1, 1]);
    expect(collapseFeedRows([blocked(1), blocked(2)]).map((r) => r.count)).toEqual([1, 1]);
    expect(collapseFeedRows([ran(1, { diffPreview: "+a" }), ran(2, { diffPreview: "+a" })]).map((r) => r.count)).toEqual([1, 1]);
    const old = (n: number) => ev({ ts: iso(n), summary: "shell echo (+1 args)", argsHash: "h1" });
    expect(collapseFeedRows([old(1), old(2)]).map((r) => r.count)).toEqual([1, 1]);
  });

  it("HTML feed: blocked rows first under their own heading, repeats collapsed, note on the ran row", () => {
    const events = [ran(10), ran(9), ran(8), blocked(100), blocked(200)];
    const html = renderFeedPage(events, {}, 1, NOW, false).feedHtml;
    const firstBlocked = html.indexOf("BLOCKED");
    expect(firstBlocked).toBeGreaterThan(0);
    expect(html.indexOf(">Blocked</div>")).toBeLessThan(firstBlocked);
    expect(html.lastIndexOf("BLOCKED")).toBeLessThan(html.indexOf("RAN"));
    expect(html).toContain("shell echo (+1 args), 3 times");
    expect((html.match(/<article/g) ?? []).length).toBe(3);
    expect(html).toContain("would hold in strict mode");
    expect(html).toContain('data-outcome="blocked"');
  });

  it("a search keeps the ranking order and never collapses", () => {
    const html = renderFeedPage([ran(1), ran(2)], {}, 1, NOW, false, "echo").feedHtml;
    expect((html.match(/<article/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(html).not.toContain("times</div>");
  });
});

describe("report counts by outcome", () => {
  const events = [ran(1), ran(2), blocked(3), blocked(4), ev({ ts: iso(5), outcome: "held" })];

  it("Markdown headline, strict line, feed first with blocked rows on top", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel(events, 3));
    expect(md).toContain("Ran 2, Blocked 2, Held 1 | Never 2");
    expect(md).toContain("2 calls that ran would hold in strict mode. To turn strict mode on, add `--strict` to the `kya hook` command");
    expect(md).not.toMatch(/Review \d/);
    expect(md.indexOf("## Feed")).toBeLessThan(md.indexOf("## Analytics"));
    const feed = md.split("\n").filter((l) => l.startsWith("- **"));
    expect(feed.slice(0, 2).every((l) => l.startsWith("- **BLOCKED**"))).toBe(true);
    expect(feed.some((l) => l.includes("2 times") && l.includes("(would hold in strict mode)"))).toBe(true);
    expect(feed.some((l) => l.startsWith("- **HELD**"))).toBe(true);
    expect(md).toContain("Outcome mix: Ran 40%");
  });

  it("an Error count shows only when above 0; one ran call says 'call', not 'calls'", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([ran(1), ev({ ts: iso(2), outcome: "error", verdict: "ALLOW" })], 3));
    expect(md).toContain("Ran 1, Blocked 0, Held 0, Error 1");
    expect(md).toContain("1 call that ran would hold in strict mode");
  });

  it("no strict line when nothing ran that strict mode would hold", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([ev({ ts: iso(1), outcome: "ran", verdict: "ALLOW", reasonCode: "ALLOW" })], 3));
    expect(md).toContain("Ran 1, Blocked 0, Held 0");
    expect(md).not.toContain("strict mode");
  });

  it("HTML: outcome buttons, hero card and outcome mix replace Allow/Deny/Review", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3));
    expect(html).toContain("Ran<b>2</b>");
    expect(html).toContain("Blocked<b>2</b>");
    expect(html).toContain("Held<b>1</b>");
    expect(html).not.toContain("Review<b>");
    expect(html).toContain('data-fgroup="outcome" data-fvalue="blocked"');
    expect(html).toContain("<h3>Outcome mix</h3>");
    expect(html).toContain('<span class="verdict">RAN</span>');
    expect(html).toContain(`class="strict-howto"`);
  });

  it("old trail lines (no outcome anywhere) keep their verdict, labelled Earlier, under the current labels", () => {
    const old = [ev({ ts: iso(1), verdict: "ALLOW", reasonCode: "ALLOW" }), ev({ ts: iso(2) }), ev({ ts: iso(3), verdict: "DENY", reasonCode: "NEVER_EVENT" })];
    const md = renderReceiptMarkdown(buildWindowReceiptModel(old, 3));
    expect(md).toContain("Ran 0, Blocked 0, Held 0 | Never 1");
    expect(md).toContain("Earlier calls (no outcome recorded): Allow 1 | Deny 1 | Review 1");
    expect(md).toContain("**REVIEW**");
    const html = renderReceiptHtml(buildWindowReceiptModel(old, 3));
    expect(html).toContain("Earlier: Review<b>1</b>");
    expect(html).toContain("Ran<b>0</b>");
    expect(html).not.toMatch(/>Review<b>/);
    expect(html).not.toContain(`class="strict-howto"`);
    expect(html).toContain("<h3>Outcome mix</h3>");
    expect(html).not.toContain("<h3>Verdict mix</h3>");
    // Old rows are never collapsed.
    const same = [ev({ ts: iso(1), summary: "shell echo", argsHash: "h" }), ev({ ts: iso(2), summary: "shell echo", argsHash: "h" })];
    expect(renderReceiptMarkdown(buildWindowReceiptModel(same, 3))).not.toContain("times");
  });

  it("an empty trail shows the current labels with zeros, never Allow, Deny or Review", () => {
    const model = buildWindowReceiptModel([], 3);
    const md = renderReceiptMarkdown(model);
    expect(md).toContain("Ran 0, Blocked 0, Held 0 | Never 0");
    expect(md).not.toMatch(/Allow \d+ \| Deny \d+ \| Review \d+/);
    const html = renderReceiptHtml(model);
    const card = html.match(/<section class="panel" aria-label="Verdicts">[\s\S]*?<\/section>/)?.[0] ?? "";
    for (const l of ["Ran", "Blocked", "Held", "Never"]) expect(card).toContain(`<span class="mix-lab">${l}</span>`);
    for (const l of ["Allow", "Deny", "Review"]) expect(card).not.toContain(`<span class="mix-lab">${l}</span>`);
    expect(html).toContain("Ran<b>0</b>");
    expect(html).not.toMatch(/>(Allow|Deny|Review)<b>/);
  });

  it("mixed trail: new rows by outcome, old rows by verdict on a second line", () => {
    const mixed = [...events, ev({ ts: iso(500), verdict: "REQUIRE_APPROVE" }), ev({ ts: iso(501), verdict: "ALLOW", reasonCode: "ALLOW" })];
    const md = renderReceiptMarkdown(buildWindowReceiptModel(mixed, 3));
    expect(md).toContain("Ran 2, Blocked 2, Held 1");
    expect(md).toContain("Earlier calls (no outcome recorded): Allow 1 | Deny 0 | Review 1");
    const html = renderReceiptHtml(buildWindowReceiptModel(mixed, 3));
    expect(html).toContain("Earlier: Review<b>1</b>");
  });

  it("a ran call is not a review for the session and tool worst-case", () => {
    expect(aggregateEvents([ran(1)]).sessions[0]!.worst).toBe("allow");
    expect(aggregateEvents([blocked(1)]).sessions[0]!.worst).toBe("never");
    expect(aggregateEvents([ev({ ts: iso(1), outcome: "held" })]).sessions[0]!.worst).toBe("hold");
    expect(worstOf(undefined, ran(1))).toBe("allow");
    expect(worstOf(undefined, ev({ ts: iso(1), outcome: "held" }))).toBe("review");
    expect(worstOf(undefined, ev({ ts: iso(1) }))).toBe("review");
    const d = computeDashboard(events);
    expect(d.outcomeMix).toMatchObject({ ran: 2, blocked: 2, held: 1, recorded: 5, legacy: 0 });
    expect(d.verdictMix.review).toBe(3);
  });
});

describe("share and certify read outcome", () => {
  it("share summary: review counts held rows only, not calls that ran", () => {
    const events = [ran(1), ran(2), ran(3), blocked(4), ev({ ts: iso(5), outcome: "held" })];
    const { stats } = buildSharePayload(buildWindowReceiptModel(events, 3));
    expect(stats).toMatchObject({ total: 5, allow: 3, deny: 1, review: 1, ran: 3, blocked: 1, held: 1, error: 0 });
  });
  it("share summary for old rows keeps the verdict counts and sends zero outcome counts (an old allow never ran)", () => {
    const { stats } = buildSharePayload(buildWindowReceiptModel([ev({ ts: iso(1) }), ev({ ts: iso(2), verdict: "ALLOW" })], 3));
    expect(stats).toMatchObject({ allow: 1, review: 1, deny: 0 });
    expect(stats).toMatchObject({ ran: 0, blocked: 0, held: 0, error: 0 });
  });
  it("certify trail stats keep the verdict mix (signed bundle) and add outcomes only when recorded", () => {
    const withOutcome = trailStats([ran(1), blocked(2)]);
    expect(withOutcome.verdictMix).toEqual({ ALLOW: 0, DENY: 1, REQUIRE_APPROVE: 1 });
    expect(withOutcome.outcomes).toEqual({ ran: 1, blocked: 1, held: 0, error: 0 });
    expect(trailStats([ev({ ts: iso(1) })])).not.toHaveProperty("outcomes");
  });
  it("certify Markdown line counts by outcome, or by verdict for old trails", () => {
    const report = (trail: ReturnType<typeof trailStats>) =>
      formatCertifyMarkdown({
        format: "shield-kya-certify-report",
        version: 1,
        generatedAt: "2026-11-13T00:00:00.000Z",
        catalog: { id: "c", version: "1", updated: "2026-11-13" },
        window: { days: 30, since: "2026-10-13T00:00:00.000Z", until: "2026-11-13T00:00:00.000Z" },
        trail,
        requirements: [],
        overall: { pass: 0, gap: 0, insufficientEvidence: 0, attested: 0, result: "gap" },
      } as never);
    expect(report(trailStats([ran(1), ran(2), blocked(3)]))).toContain("3 events in window - ran 2 · blocked 1 · held 0");
    expect(report(trailStats([ran(1), ev({ ts: iso(2) })]))).toContain("ran 1 · blocked 0 · held 0 · 1 earlier with no outcome");
    expect(report(trailStats([ev({ ts: iso(1) })]))).toContain("allow 0 · deny 0 · review 1");
  });
});
