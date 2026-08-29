import type { DashPane } from "./entitlement.js";

export interface KeyAction {
  readonly type:
    | "pane"
    | "refresh"
    | "offline"
    | "quit"
    | "help"
    | "up"
    | "down"
    | "wrap"
    | "kill"
    | "register-hint"
    | "invoke"
    | "shrink-build"
    | "shrink-read"
    | "orr-run"
    | "decide-approve"
    | "decide-reject"
    | "noop";
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
  if (raw === "o") return { type: "orr-run" };
  if (raw === "O") return { type: "offline" };
  if (raw === "w") return { type: "wrap" };
  if (raw === "k") return { type: "kill" };
  if (raw === "n") return { type: "register-hint" };
  if (raw === "i") return { type: "invoke" };
  if (raw === "b") return { type: "shrink-build" };
  if (raw === "R") return { type: "shrink-read" };
  if (raw === "a") return { type: "decide-approve" };
  if (raw === "x") return { type: "decide-reject" };
  if (raw === "?" || raw === "h") return { type: "help" };
  if (raw === "j" || raw === "down") return { type: "down" };
  if (raw === "up") return { type: "up" };
  if (raw === "\t") return { type: "noop" };
  const digit = DIGIT[raw];
  if (digit) return { type: "pane", pane: digit };
  const letter = LETTER[raw];
  if (letter) return { type: "pane", pane: letter };
  return { type: "noop" };
}
