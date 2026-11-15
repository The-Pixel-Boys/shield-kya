/**
 * Feature kya-near-miss-card (spec item G5), unit level: rule labels, the card builder, the privacy rule, the event
 * picker, the report control and the live action. The real-stack runs (built CLI, bundle) are in near-miss-card-e2e.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardSvg, cardCaption, cardInputOf, cardLines, eventIdOf, pickNearMiss, recentNearMiss, ruleLabel, xmlEscape, CARD_FALLBACK_LABEL, type CardInput } from "../src/card.js";
import { GUARD_SHELL_RULES, guardLabel } from "../src/guard-pack.js";
import { NEVER_LIST_INPUT_RULES } from "../src/never-list-input.js";
import { loadReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import { runReportCardAction, startLiveReceiptServer } from "../src/receipt/live-server.js";
import { resolveConfig } from "../src/config.js";
import type { TrailEvent } from "../src/trail.js";

const ev = (o: Partial<TrailEvent> & { ts: string }): TrailEvent => ({
  sessionId: "s1", toolId: "Bash", verdict: "DENY", outcome: "blocked", reasonCode: "NEVER_SHELL", mode: "offline", product: "claude", neverRule: "railway-volume-delete", ...o,
});
const CARD: CardInput = { ruleId: "railway-volume-delete", label: "delete a cloud volume", host: "Claude Code", date: "2026-04-25" };

/** Visible text of the SVG: every <text> element, tags removed, entities decoded, one string per element. */
const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const visible = (svg: string): string[] => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));

describe("kya-near-miss-card: every rule has a human label", () => {
  const ids = [
    ...NEVER_LIST_INPUT_RULES.map((r) => r.id),
    ...GUARD_SHELL_RULES,
    "guard-config-write",
    // The families whose ids are built from a kind or a tool name.
    "secret-read-railway", "secret-read-docker", "secret-read-kube", "secret-read-pypirc", "secret-read-gh", "secret-read-azure", "secret-read-gcloud", "secret-read-key", "secret-read-environ",
    "secret-write-aws", "secret-write-privkey", "secret-write-github", "secret-write-github-pat", "secret-write-slack", "secret-write-stripe",
    "exfil-curl", "exfil-wget", "exfil-nc", "exfil-ncat", "exfil-socat", "exfil-scp", "exfil-rsync",
  ];
  it.each(ids)("rule %s has a label", (id) => {
    const l = ruleLabel(id);
    expect(l, `no label for ${id}`).toBeTruthy();
    expect(l!.length).toBeLessThanOrEqual(60);
    expect(l).toBe(l!.trim());
    expect(l).not.toMatch(/[–—.]/); // no long dash, no full stop (the card adds one)
    expect(`My coding agent tried to ${l}.`).toMatch(/^My coding agent tried to [a-z]/);
  });

  it("every never-list row carries a label field", () => {
    for (const r of NEVER_LIST_INPUT_RULES) expect(r.label.trim().length, r.id).toBeGreaterThan(0);
  });

  it("the spec examples read as written, and an unknown id has no label", () => {
    expect(ruleLabel("railway-volume-delete")).toBe("delete a cloud volume");
    expect(ruleLabel("rm-project-wipe")).toBe("wipe the project folder");
    expect(ruleLabel("secret-read-file")).toBe("read a credentials file");
    expect(ruleLabel("no-such-rule")).toBeUndefined();
    expect(guardLabel("secret-read-whatever-new")).toBe("read a credentials file");
  });
});

describe("kya-near-miss-card: the SVG", () => {
  it("is 1200 x 630 and its visible text, title and description are the four lines", () => {
    const svg = buildCardSvg(CARD);
    expect(svg).toMatch(/<svg [^>]*width="1200" height="630" viewBox="0 0 1200 630"/);
    const lines = cardLines(CARD);
    expect(lines).toEqual([
      "My coding agent tried to delete a cloud volume.",
      "KYA Guard stopped it.",
      "Rule railway-volume-delete | Claude Code | 2026-04-25",
      "Install: npx @shield-agent/kya@latest start",
    ]);
    expect(visible(svg)).toEqual(lines);
    expect(decode(/<title[^>]*>([\s\S]*?)<\/title>/.exec(svg)![1]!)).toBe(`${lines[0]} ${lines[1]}`);
    expect(decode(/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)![1]!)).toBe(lines.join(" "));
  });

  it("wraps a long first line over several tspans that still read as one line", () => {
    const svg = buildCardSvg({ ...CARD, label: "send your environment variables to a raw IP address" });
    expect(svg.match(/<tspan /g)!.length).toBeGreaterThan(1);
    expect(visible(svg)[0]).toBe("My coding agent tried to send your environment variables to a raw IP address.");
  });

  it("escapes every text for XML", () => {
    const evil = `<script>alert(1)</script> & "q" 'a'`;
    const svg = buildCardSvg({ ruleId: evil, label: evil, host: evil, date: evil });
    expect(svg).not.toContain("<script");
    expect(svg).not.toMatch(/&(?!(amp|lt|gt|quot|#39);)/);
    expect(xmlEscape(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
    // Control characters are not allowed in XML 1.0: they become spaces.
    expect(buildCardSvg({ ...CARD, host: "a\u0000b\u001Fc\nd" })).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it("holds only what it is given: extra properties on the input never reach the file", () => {
    const sneaky = { ...CARD, command: "CMD_MARK_1", path: "PATH_MARK_2", project: "PROJ_MARK_3", sessionId: "SESS_MARK_4" } as unknown as CardInput;
    expect(buildCardSvg(sneaky)).toBe(buildCardSvg(CARD));
  });

  it("the caption is two lines: the sentence, then the rule and the install line", () => {
    const c = cardCaption(CARD).split("\n");
    expect(c).toHaveLength(2);
    expect(c[0]).toBe("My coding agent tried to delete a cloud volume. KYA Guard stopped it.");
    expect(c[1]).toContain("railway-volume-delete");
    expect(c[1]).toContain("npx @shield-agent/kya@latest start");
  });
});

describe("kya-near-miss-card: privacy by construction", () => {
  const MARKS = ["CMD_MARK_a1", "PATH_MARK_b2", "PROJ_MARK_c3", "SESS_MARK_d4", "SUMMARY_MARK_e5", "DIFF_MARK_f6", "TOOL_MARK_g7"];
  it("a trail row stuffed with marker strings gives a card with none of them", () => {
    const row = ev({
      ts: "2026-04-25T10:00:00.000Z", sessionId: MARKS[3]!, project: MARKS[2]!, toolId: MARKS[6]!,
      summary: `rm ${MARKS[0]}`, diffPreview: MARKS[5]!, targetPath: `/home/${MARKS[1]}/x`, argsHash: MARKS[0]!, summary_: MARKS[4]!,
    } as Partial<TrailEvent> & { ts: string });
    const svg = buildCardSvg(cardInputOf(row));
    for (const m of MARKS) expect(svg, m).not.toContain(m);
    expect(Object.keys(cardInputOf(row)).sort()).toEqual(["date", "host", "label", "ruleId"]);
    expect(visible(svg)).toEqual(cardLines(CARD));
  });

  it("an unknown rule id gets the generic label, a bad timestamp gets a plain date word", () => {
    const i = cardInputOf(ev({ ts: "not a date", neverRule: "from-the-future" }));
    expect(i).toMatchObject({ ruleId: "from-the-future", label: CARD_FALLBACK_LABEL, date: "unknown date" });
  });
});

describe("kya-near-miss-card: which call gets a card", () => {
  const deny = ev({ ts: "2026-04-25T10:00:00.000Z" });
  const newer = ev({ ts: "2026-04-26T10:00:00.000Z", neverRule: "terraform-destroy" });
  const ask = ev({ ts: "2026-04-27T10:00:00.000Z", verdict: "REQUIRE_APPROVE", outcome: "held", reasonCode: "GUARD_ASK", neverRule: "prisma-migrate-reset" });
  const ran = ev({ ts: "2026-04-28T10:00:00.000Z", verdict: "ALLOW", outcome: "ran", reasonCode: "", neverRule: undefined });

  it("takes the newest denied call, ignoring a newer ask and a newer ran call", () => {
    const p = pickNearMiss([deny, newer, ask, ran]);
    expect(p).toMatchObject({ ok: true });
    expect(p.ok && p.event.neverRule).toBe("terraform-destroy");
  });

  it("--id picks another denied call", () => {
    const p = pickNearMiss([deny, newer, ask], eventIdOf(deny));
    expect(p.ok && p.event.neverRule).toBe("railway-volume-delete");
  });

  it("no rows and only-ask rows give a clear message and no event", () => {
    expect(pickNearMiss([])).toEqual({ ok: false, message: expect.stringContaining("has not stopped a call yet") });
    const onlyAsk = pickNearMiss([ask, ran]);
    expect(onlyAsk.ok).toBe(false);
    expect(!onlyAsk.ok && onlyAsk.message).toMatch(/asked you about one, and an approved ask is not a near miss/);
  });

  it("an id of an ask or a ran call is refused, an unknown id lists the recent stopped calls", () => {
    const a = pickNearMiss([deny, ask], eventIdOf(ask));
    expect(!a.ok && a.message).toMatch(/was not denied/);
    const u = pickNearMiss([deny, ask], "00000000");
    expect(!u.ok && u.message).toContain(`${eventIdOf(deny)} (railway-volume-delete, 2026-04-25)`);
  });

  it("the id is a stable 8 hex digits that shows nothing of the row", () => {
    expect(eventIdOf(deny)).toMatch(/^[0-9a-f]{8}$/);
    expect(eventIdOf(deny)).toBe(eventIdOf({ ...deny }));
    expect(eventIdOf(deny)).not.toBe(eventIdOf(newer));
  });

  it("recentNearMiss sees a deny from the last 7 days only", () => {
    const now = new Date("2026-04-30T00:00:00Z");
    expect(recentNearMiss([deny], now)).toBe(deny);
    expect(recentNearMiss([deny], new Date("2026-05-10T00:00:00Z"))).toBeUndefined();
    expect(recentNearMiss([ask, ran], now)).toBeUndefined();
  });
});

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
});
/** A temp project and a temp HOME / KYA_HOME, with a trail of one denied, one held and one ran call. Process env points at it until afterEach. */
function world(): { proj: string; home: string; deny: TrailEvent; ask: TrailEvent; ran: TrailEvent } {
  const base = mkdtempSync(join(tmpdir(), "kya-card-unit-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(join(home, ".kya"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  // KYA_CARD_PNG=0: no Chrome start in unit tests (the CLI e2e test covers the PNG when a renderer exists).
  for (const k of ["HOME", "KYA_HOME", "KYA_OFFLINE", "KYA_NO_BROWSER", "KYA_CARD_PNG"]) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, KYA_HOME: home, KYA_OFFLINE: "1", KYA_NO_BROWSER: "1", KYA_CARD_PNG: "0" });
  const now = Date.now();
  const deny = ev({ ts: new Date(now - 60_000).toISOString() });
  const ask = ev({ ts: new Date(now - 50_000).toISOString(), verdict: "REQUIRE_APPROVE", outcome: "held", reasonCode: "GUARD_ASK", neverRule: "prisma-migrate-reset", toolId: "AskTool" });
  const ran = ev({ ts: new Date(now - 40_000).toISOString(), verdict: "ALLOW", outcome: "ran", reasonCode: "", neverRule: undefined, toolId: "RanTool" });
  writeFileSync(join(home, ".kya", "trail.jsonl"), [deny, ask, ran].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { proj, home, deny, ask, ran };
}

describe("kya-near-miss-card: the report", () => {
  const html = (proj: string, extra: object = {}): string => renderReceiptHtml({ ...loadReceiptModel({ cwd: proj, days: 3, live: false }), ...extra });

  it("static report: the CLI command sits next to the stopped row (panel and feed), and next to no other row", () => {
    const w = world();
    const page = html(w.proj);
    const id = eventIdOf(w.deny);
    expect(page.split(`kya receipt --card --id ${id}`).length - 1).toBe(2);
    expect(page.match(/Make card:/g)).toHaveLength(2);
    expect(page).not.toContain(eventIdOf(w.ask));
    expect(page).not.toContain(eventIdOf(w.ran));
    expect(page).not.toContain("data-card-id");
  });

  it("live report: a Make card button with the id, only for the stopped row", () => {
    const w = world();
    const page = html(w.proj, { live: true, liveToken: "tok-for-test" });
    expect(page.match(/data-card-id="[0-9a-f]{8}"/g)).toEqual([`data-card-id="${eventIdOf(w.deny)}"`, `data-card-id="${eventIdOf(w.deny)}"`]);
    expect(page).toContain(">Make card</button>");
    expect(page).not.toContain("Make card:");
  });

  it("no stopped call (the demo panel, or only ask and ran rows) shows no card control", () => {
    const w = world();
    writeFileSync(join(w.home, ".kya", "trail.jsonl"), [w.ask, w.ran].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const page = html(w.proj, { live: true, liveToken: "tok" });
    expect(page).not.toContain("Make card");
    expect(page).not.toContain('data-card-id="'); // the live script names the attribute, but no row carries one
  });
});

describe("kya-near-miss-card: POST /action/card on the live server", () => {
  it("is refused without the token (401), from a proxy (403) and with a bad id (400); works with the token", async () => {
    const w = world();
    const config = resolveConfig({ cwd: w.proj, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
    const s = await startLiveReceiptServer({ config, days: 3 });
    try {
      const post = (q: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${s.port}/action/card${q}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const id = eventIdOf(w.deny);
      const cards = join(w.home, ".kya", "cards");

      expect((await post("", { id })).status).toBe(401);
      expect((await post("?t=wrong", { id })).status).toBe(401);
      expect((await post(`?t=${s.token}`, { id }, { "X-Forwarded-For": "1.2.3.4" })).status).toBe(403);
      expect(existsSync(cards), "a refused request writes nothing").toBe(false);

      expect((await post(`?t=${s.token}`, { id: "../../etc/passwd" })).status).toBe(400);
      expect((await post(`?t=${s.token}`, {})).status).toBe(400);

      const ok = await post(`?t=${s.token}`, { id });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; svg: string; caption: string };
      expect(body.ok).toBe(true);
      expect(body.svg.startsWith(cards)).toBe(true);
      expect(readFileSync(body.svg, "utf8")).toBe(buildCardSvg(cardInputOf(w.deny)));
      expect(body.caption).toContain("My coding agent tried to delete a cloud volume.");

      const held = (await (await post(`?t=${s.token}`, { id: eventIdOf(w.ask) })).json()) as { ok: boolean; error: string };
      expect(held).toMatchObject({ ok: false });
      expect(held.error).toMatch(/was not denied/);
    } finally {
      await s.close();
    }
  });

  it("runReportCardAction maps an unknown id to ok:false and a malformed id to 400", async () => {
    world();
    expect((await runReportCardAction("zzzzzzzz", process.env)).status).toBe(400);
    const r = await runReportCardAction("00000000", process.env);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false });
  });
});
