import type { DashPane, Entitlement } from "./entitlement.js";
import { FREE_PANES, paneAllowed } from "./entitlement.js";

export const COLS = 78;

export interface StatusStrip {
  readonly plan: "FREE" | "ENTERPRISE";
  readonly host: string;
  readonly plane: string;
  readonly pane: DashPane;
}

/** Strip C0 / ESC / OSC / bidi / zero-width so plane-controlled strings
 * cannot drive the TTY or spoof display order. */
export function stripEscapes(text: string): string {
  return text
    .replace(/\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_]|[\[\]()#][0-9;?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}

export function hline(ch = "─"): string {
  return ch.repeat(COLS);
}

export function clip(text: string, width = COLS): string {
  const clean = stripEscapes(text).replace(/\r?\n/g, " ");
  if (clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripEscapes(r[i] ?? "").length), 4),
  );
  const line = (cells: readonly string[]) =>
    clip(
      cells
        .map((c, i) => stripEscapes(c ?? "").padEnd(widths[i] ?? 0))
        .join("  "),
    );
  const out = [line(headers), clip(widths.map((w) => "─".repeat(w)).join("  "))];
  if (rows.length === 0) {
    out.push("(empty)");
  } else {
    for (const r of rows) out.push(line(r));
  }
  return out;
}

export function navLine(_ent: Entitlement, active: DashPane): string {
  const free = FREE_PANES.map((p) => (p === active ? `[${p.toUpperCase()}]` : p)).join("  ");
  return clip(`free: ${free}`);
}

export function enterpriseNavLine(ent: Entitlement, active: DashPane): string {
  if (ent.plan === "enterprise") {
    return clip(
      `ent:  ${["dashboard", "cases", "metrics", "edge", "settings"]
        .map((p) => (p === active ? `[${p.toUpperCase()}]` : p))
        .join("  ")}`,
    );
  }
  return clip("ent:  (hidden on FREE - set KYA_DASH_PLAN=enterprise to unlock)");
}

export function lockedPane(pane: DashPane): string[] {
  return [
    `${pane} requires an enterprise license.`,
    "This pane matches the web console and is not part of the free individual plan.",
    "Unlock: KYA_DASH_PLAN=enterprise  or  SCALE plane  or  .kya/license",
    "Docs: docs/operations/kya-tui-license.md",
  ];
}

export function frame(
  status: StatusStrip,
  ent: Entitlement,
  body: readonly string[],
  confirmLine?: string,
): string {
  const head = [
    hline("═"),
    clip(
      `kya dash  ·  ${status.plan}  ·  host=${status.host}  ·  plane=${status.plane}  ·  pane=${status.pane}`,
    ),
    navLine(ent, status.pane),
    enterpriseNavLine(ent, status.pane),
    hline(),
  ];
  const confirm =
    confirmLine && confirmLine.trim()
      ? [hline(), clip(`CONFIRM: ${confirmLine}`), clip("press y to confirm · any other key cancels")]
      : [];
  const foot = [
    hline(),
    clip(
      "1-9 panes  j/k  e eval  p refresh  P posture  w wrap  i/k/b decide (y)  o orr  t passport  O offline  q",
    ),
  ];
  return [...head, ...body.map((l) => clip(l)), ...confirm, ...foot].join("\n");
}

const SCHEME_CHAR = /[a-zA-Z0-9+.-]/;
const USER_STOP = /[/\s:@]/;
const PASS_STOP = /[/\s@]/;

/**
 * True when `s` has `user:pass@` at `from`: one or more chars not in `/ whitespace : @`, `:`, one or more chars not in
 * `/ whitespace @`, `@`. A char scan: the regex form is flagged as polynomial (CodeQL js/polynomial-redos).
 */
function hasUserinfo(s: string, from: number): boolean {
  let k = from;
  while (k < s.length && !USER_STOP.test(s.charAt(k))) k++;
  if (k === from || s.charAt(k) !== ":") return false;
  const pass = ++k;
  while (k < s.length && !PASS_STOP.test(s.charAt(k))) k++;
  return k > pass && s.charAt(k) === "@";
}

/**
 * True for `scheme://user:pass@`. Plain scan: the regex form
 * `/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.../` starts at every letter of a long scheme-like run and is quadratic.
 * The scheme runs before each `://` are disjoint, so this is linear.
 */
function hasUrlCredentials(s: string): boolean {
  for (let i = s.indexOf("://"); i >= 0; i = s.indexOf("://", i + 3)) {
    let letter = false;
    for (let j = i - 1; j >= 0 && SCHEME_CHAR.test(s.charAt(j)); j--) {
      if (/[a-zA-Z]/.test(s.charAt(j))) letter = true;
    }
    if (!letter) continue;
    if (hasUserinfo(s, i + 3)) return true;
  }
  return false;
}

export function assertNoSecrets(text: string, extra?: string): void {
  const hay = extra ? `${text}\n${extra}` : text;
  if (hasUrlCredentials(hay)) throw new Error("dashboard frame leaked a secret");
  const pats = [
    /npm_[A-Za-z0-9]{8,}/,
    /Bearer\s+\S{8,}/i,
    /Basic\s+[A-Za-z0-9+/=_-]{8,}/i,
    /sk_live_[A-Za-z0-9]+/,
    /sk_test_[A-Za-z0-9]+/,
    /sk_[A-Za-z0-9]{16,}/,
    /ghp_[A-Za-z0-9]+/,
    /github_pat_[A-Za-z0-9_]+/,
    /whsec_[A-Za-z0-9]+/,
    /sk-ant-[A-Za-z0-9\-]+/,
    /AKIA[A-Z0-9]{12,}/,
    /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/,
    /[?&#](?:access_token|api[_-]?key|token|secret|password|auth)=[^&\s#"']+/i,
    /sk-proj-[A-Za-z0-9_\-]{20,}/,
    /Cookie:\s*\S+/i,
    /\bsession=[^\s;&"']{8,}/i,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
    /-----END [A-Z0-9 ]*PRIVATE KEY-----/i,
    // Keyword assignments require a realistically long value - short benign
    // mentions ("refreshed token: ab12cd34") must not DoS every render.
    /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?!\[redacted\])[^\s#"']{16,}/i,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/i,
  ];
  for (const p of pats) {
    if (p.test(hay)) throw new Error("dashboard frame leaked a secret");
  }
}

export function paneAllowedOrLocked(
  ent: Entitlement,
  pane: DashPane,
  live: () => readonly string[],
): readonly string[] {
  if (!paneAllowed(ent, pane)) return lockedPane(pane);
  return live();
}
