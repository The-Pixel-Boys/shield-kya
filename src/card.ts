/**
 * Near-miss card (spec item G5): one 1200 x 630 SVG that says what almost happened and nothing private.
 *
 * Privacy by construction. `buildCardSvg` takes only { ruleId, label, host, date }: four short strings. It never sees a
 * command, a path, a project name or a session id, so none of them can reach the image. `cardInputOf` is the only place
 * that reads a trail row, and it reads three fields: the rule id, the product and the timestamp. The label comes from the
 * rule table, never from the row. Imported by the kya-guard bundle, so: no network, no child process (the PNG step lives in
 * card-png.ts, which the bundle does not import).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";
import { guardLabel } from "./guard-pack.js";
import { NEVER_LIST_INPUT_RULES } from "./never-list-input.js";
import { outcomeOf, productLabel, type TrailEvent } from "./trail.js";

export interface CardInput {
  readonly ruleId: string;
  /** Short phrase from the rule table, for example "delete a cloud volume". */
  readonly label: string;
  /** Host name as shown to people, for example "Claude Code". */
  readonly host: string;
  /** Calendar date, YYYY-MM-DD. */
  readonly date: string;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** The install one-liner on the card (docs/install.md "One liner"). */
export const CARD_INSTALL = "npx @shield-agent/kya@latest start";
/** Label when a trail row has a rule id this build does not know (a row from a newer version). */
export const CARD_FALLBACK_LABEL = "run a command the guard blocks";

/** Human phrase for a rule id: the never-list rows first, then the guard pack. Undefined when no table knows it. */
export function ruleLabel(ruleId: string): string | undefined {
  return NEVER_LIST_INPUT_RULES.find((r) => r.id === ruleId)?.label ?? guardLabel(ruleId);
}

/** XML 1.0 allows no control characters except tab, LF and CR. A line break would break a one-line text. */
const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001F\u007F￾￿]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Escape text for an XML text node or a double-quoted attribute. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The four lines of the card, in order. The alt text and the visible text come from here, so they cannot differ. */
export function cardLines(input: CardInput): readonly [string, string, string, string] {
  const label = clean(input.label, 60);
  return [
    `My coding agent tried to ${label}.`,
    "KYA Guard stopped it.",
    `Rule ${clean(input.ruleId, 48)} | ${clean(input.host, 24)} | ${clean(input.date, 10)}`,
    `Install: ${CARD_INSTALL}`,
  ];
}

/** Greedy word wrap. A word longer than the limit stays whole on its own line. */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + 1 + w.length > max) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

const SANS = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** The card: a 1200 x 630 SVG with a title and a description that match the four visible lines. */
export function buildCardSvg(input: CardInput): string {
  const [l1, l2, l3, l4] = cardLines(input);
  const rows = wrap(l1, 30);
  const first = rows.map((r, i) => `<tspan x="80" y="${150 + i * 72}">${xmlEscape(r)}</tspan>`).join("");
  const stopY = 150 + rows.length * 72 + 24;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-labelledby="t d">
<title id="t">${xmlEscape(`${l1} ${l2}`)}</title>
<desc id="d">${xmlEscape([l1, l2, l3, l4].join(" "))}</desc>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0b1220"/>
<rect width="16" height="${CARD_HEIGHT}" fill="#3ddc84"/>
<rect x="40" y="40" width="1120" height="550" rx="20" fill="none" stroke="#1f2a44" stroke-width="2"/>
<text font-family="${SANS}" font-size="60" font-weight="700" fill="#f4f7ff">${first}</text>
<text x="80" y="${stopY}" font-family="${SANS}" font-size="64" font-weight="800" fill="#3ddc84">${xmlEscape(l2)}</text>
<text x="80" y="500" font-family="${MONO}" font-size="26" fill="#9fb0d0">${xmlEscape(l3)}</text>
<text x="80" y="560" font-family="${MONO}" font-size="30" fill="#7cc4ff">${xmlEscape(l4)}</text>
</svg>
`;
}

/** Two lines to paste with the image. */
export function cardCaption(input: CardInput): string {
  const [l1, l2] = cardLines(input);
  return `${l1} ${l2}\nRule ${clean(input.ruleId, 48)}. Local, no network, one file: ${CARD_INSTALL}`;
}

/** Stable short id of a trail row (the `--id` value). A hash of the time, session, tool and rule: it shows nothing of them. */
export function eventIdOf(e: TrailEvent): string {
  return createHash("sha256").update([e.ts, e.sessionId, e.toolId, e.neverRule ?? e.reasonCode].join("\n")).digest("hex").slice(0, 8);
}

/** A near miss is a call the guard denied. An ask (outcome held) is not one: the person answered it. */
export const isNearMiss = (e: TrailEvent): boolean => outcomeOf(e) === "blocked";

/**
 * The only place a trail row meets the card. It reads three fields (neverRule or reasonCode, product, ts) and the rule table.
 * It does not read toolId, project, sessionId, summary, diffPreview or targetPath.
 */
export function cardInputOf(e: TrailEvent): CardInput {
  const ruleId = e.neverRule ?? e.reasonCode;
  return {
    ruleId,
    label: ruleLabel(ruleId) ?? CARD_FALLBACK_LABEL,
    host: productLabel(e.product),
    date: /^\d{4}-\d{2}-\d{2}/.test(e.ts) ? e.ts.slice(0, 10) : "unknown date",
  };
}

export type NearMissPick = { readonly ok: true; readonly event: TrailEvent } | { readonly ok: false; readonly message: string };

const byNewest = (a: TrailEvent, b: TrailEvent): number => Date.parse(b.ts) - Date.parse(a.ts);

/** The call for a card: the row with that id, or the newest denied call. A clear message when there is none. */
export function pickNearMiss(rows: readonly TrailEvent[], id?: string): NearMissPick {
  const denied = rows.filter(isNearMiss).sort(byNewest);
  if (id) {
    const row = rows.find((e) => eventIdOf(e) === id);
    if (row && isNearMiss(row)) return { ok: true, event: row };
    if (row) return { ok: false, message: `The call ${id} was not denied, so there is no near miss to show. A card is only for a call KYA Guard stopped. A call it asked you about is not one.` };
    const known = denied.slice(0, 5).map((e) => `${eventIdOf(e)} (${cardInputOf(e).ruleId}, ${cardInputOf(e).date})`).join(", ");
    return { ok: false, message: `No call with id ${id}. ${known ? `Recent stopped calls: ${known}.` : "KYA Guard has not stopped a call yet."}` };
  }
  if (denied.length) return { ok: true, event: denied[0]! };
  const asked = rows.some((e) => outcomeOf(e) === "held");
  return {
    ok: false,
    message: asked
      ? "KYA Guard has not denied a call yet. It asked you about one, and an approved ask is not a near miss, so there is no card. A card is only for a call it stopped."
      : "KYA Guard has not stopped a call yet, so there is no near miss to show. Nothing was changed.",
  };
}

/** A denied call in the last `days` days (the offer in /kya-guard:status). */
export function recentNearMiss(rows: readonly TrailEvent[], now: Date, days = 7): TrailEvent | undefined {
  const since = now.getTime() - days * 86_400_000;
  return rows.filter((e) => isNearMiss(e) && Date.parse(e.ts) >= since).sort(byNewest)[0];
}

/** Folder of the cards: `<KYA_HOME or HOME>/.kya/cards`. */
export const cardsDir = (env: NodeJS.ProcessEnv): string => join(globalConfigDir(env), "cards");

/** Write the SVG to the cards folder. Returns the path. Writes one local file and nothing else. */
export function writeCardSvg(env: NodeJS.ProcessEnv, e: TrailEvent): { readonly svgPath: string; readonly input: CardInput } {
  const input = cardInputOf(e);
  const dir = cardsDir(env);
  mkdirSync(dir, { recursive: true });
  const svgPath = join(dir, `near-miss-${input.date}-${input.ruleId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}-${eventIdOf(e)}.svg`);
  writeFileSync(svgPath, buildCardSvg(input), "utf8");
  return { svgPath, input };
}

/** The text `kya receipt --card` and `guard.mjs --card` print: the file paths, then the two-line caption. */
export function formatCard(r: { readonly svgPath: string; readonly pngPath?: string; readonly pngNote?: string; readonly input: CardInput; readonly id: string }): string {
  return [
    `Near-miss card for call ${r.id}. It holds the rule, the host and the date. Nothing else, and nothing was sent anywhere.`,
    `SVG: ${r.svgPath}`,
    r.pngPath ? `PNG: ${r.pngPath}` : `PNG: not made. ${r.pngNote ?? "No renderer found."}`,
    "Caption to paste:",
    cardCaption(r.input),
  ].join("\n") + "\n";
}
