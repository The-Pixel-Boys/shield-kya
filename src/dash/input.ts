import type { DashPane } from "./entitlement.js";

export interface KeyAction {
  readonly type: "pane" | "refresh" | "offline" | "quit" | "help" | "noop";
  readonly pane?: DashPane;
}

const DIGIT: Record<string, DashPane> = {
  "1": "home",
  "2": "policy",
  "3": "agents",
  "4": "approvals",
  "5": "sessions",
  "6": "orr",
  "7": "mcp",
};

const LETTER: Record<string, DashPane> = {
  d: "dashboard",
  c: "cases",
  m: "metrics",
  e: "edge",
  s: "settings",
};

export function mapKey(raw: string): KeyAction {
  if (raw === "q" || raw === "\u0003") return { type: "quit" };
  if (raw === "r") return { type: "refresh" };
  if (raw === "o") return { type: "offline" };
  if (raw === "?" || raw === "h") return { type: "help" };
  if (raw === "\t") return { type: "noop" };
  const digit = DIGIT[raw];
  if (digit) return { type: "pane", pane: digit };
  const letter = LETTER[raw];
  if (letter) return { type: "pane", pane: letter };
  return { type: "noop" };
}
