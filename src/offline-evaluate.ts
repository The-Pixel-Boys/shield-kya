/**
 * Offline sample policy evaluate for light-install demos.
 * Not a second production PEP - production injects HTTP evaluate against Shield.
 * Same sample tools as docs/dev/kya-custom-tools-sample.md (R8: packs off),
 * plus the well-known host tool vocabulary in host-tools.ts.
 */

import type { Host } from "./config.js";
import type { PolicyEvaluateRequest, PolicyEvaluateResponse } from "./client.js";
import { findHostToolTier } from "./host-tools.js";
import { mcpToolTier, parseMcpToolId } from "./mcp-servers.js";
import { findSampleTool, type ActionClass, type PolicyVerdict } from "./sample-tools.js";
import { neverListInputMatch } from "./never-list-input.js";

export type SessionRisk = "LOW" | "MEDIUM" | "HIGH";

/** Destructive verbs on a known MCP server's tool name (shared with the Python shim's vectors). */
export const NEVER_LIST_VERBS = ["drop", "truncate", "purge", "transfer"] as const;
/**
 * Harmless whole words that contain a verb. A verb inside a name is denied unless it
 * sits in one of these words. Data table: the Python shim and the shared vectors use it too.
 * Default is deny, so a compound such as `droptable` or `DROPTABLE` is still denied.
 */
export const NEVER_LIST_HARMLESS = [
  "dropdown", "dropdowns", "dropbox", "dropboxes", "droplet", "droplets",
  "dropout", "dropouts", "dropzone",
  "purgeable",
  "transferable", "transference", "transferor",
] as const;
const NEVER_LIST_HARMLESS_SET: ReadonlySet<string> = new Set(NEVER_LIST_HARMLESS);

/**
 * Lower-case words of a tool name. Splits on anything that is not an ASCII letter,
 * and on camelCase edges (`DropDatabase` gives drop, database; `HTTPDrop` gives http,
 * drop). One linear pass, so no regex backtracking on long input.
 */
function nameWords(s: string): string[] {
  const isUpper = (c: string | undefined): boolean => c !== undefined && c >= "A" && c <= "Z";
  const isLower = (c: string | undefined): boolean => c !== undefined && c >= "a" && c <= "z";
  const words: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!isUpper(c) && !isLower(c)) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    if (cur && isUpper(c) && (isLower(s[i - 1]) || (isUpper(s[i - 1]) && isLower(s[i + 1])))) {
      words.push(cur);
      cur = "";
    }
    cur += c;
  }
  if (cur) words.push(cur);
  return words.map((w) => w.toLowerCase());
}

/**
 * THE never-list rule, on the tool name ALONE: a known sample tool answers by its
 * policyTier; otherwise a destructive admin name on a known MCP server matches. A verb
 * matches inside a name (`drop_table`, `droptable`, `DropDatabase`), except inside a
 * harmless word (NEVER_LIST_HARMLESS, `dropdown_select`). `baseTier` (normal path) and
 * the hook's error fallback both call this one function, so they cannot drift. No
 * config, args or hashing, so the hook can enforce it even when config parsing or arg
 * handling throws.
 */
export function matchesNeverList(toolId: string): boolean {
  const known = findSampleTool(toolId);
  if (known?.policyTier) return known.policyTier === "DENY";
  const mcp = parseMcpToolId(toolId);
  if (!mcp) return false;
  // parseMcpToolId lower-cases the id; take the tool part from the original text so camelCase still splits.
  const orig = toolId.trim();
  const part = orig.slice(-mcp.tool.length);
  const tool = part.toLowerCase() === mcp.tool ? part : mcp.tool;
  // Drop the harmless words, then look for a verb in what is left, joined so a verb split by a separator still counts.
  const rest = nameWords(tool).filter((w) => !NEVER_LIST_HARMLESS_SET.has(w)).join("");
  return NEVER_LIST_VERBS.some((v) => rest.includes(v));
}

function baseTier(
  toolId: string,
  irreversible: boolean,
  actionClass: string | undefined,
  toolInput: unknown,
): { verdict: PolicyVerdict; reasonCode: string; ruleId?: string } {
  if (!toolId || toolId.trim() === "") {
    return { verdict: "DENY", reasonCode: "EMPTY_TOOL" };
  }

  // Never-list first (clearly destructive admin names on a KNOWN MCP server deny
  // outright, even with risk signals declared; sample DENY tools too).
  if (matchesNeverList(toolId)) {
    return { verdict: "DENY", reasonCode: "NEVER_EVENT" };
  }
  // Input rules (shell command, secret path): same DENY, same code.
  const inputHit = neverListInputMatch(toolId, toolInput);
  if (inputHit) {
    return { verdict: "DENY", reasonCode: "NEVER_EVENT", ruleId: inputHit.rule };
  }

  const known = findSampleTool(toolId);
  if (known?.policyTier) {
    if (known.policyTier === "REQUIRE_APPROVE") {
      return { verdict: "REQUIRE_APPROVE", reasonCode: "HIGH_STAKES_WRITE" };
    }
    return { verdict: "ALLOW", reasonCode: "ALLOW" };
  }

  const mcp = parseMcpToolId(toolId);

  // Advisory vocabulary only applies when the caller declared no risk signals;
  // explicit irreversible/actionClass keep their stricter paths below.
  if (!irreversible && (actionClass ?? "").trim() === "") {
    const hostTier = findHostToolTier(toolId);
    if (hostTier === "READ") {
      return { verdict: "ALLOW", reasonCode: "LOW_RISK_READ" };
    }
    if (hostTier === "WRITE") {
      return { verdict: "REQUIRE_APPROVE", reasonCode: "HIGH_STAKES_WRITE" };
    }
    if (hostTier === "SHELL") {
      return { verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC" };
    }
    if (mcp) {
      const mcpTier = mcpToolTier(mcp.server, mcp.tool);
      if (mcpTier === "READ") {
        return { verdict: "ALLOW", reasonCode: "LOW_RISK_READ" };
      }
      if (mcpTier === "WRITE") {
        return { verdict: "REQUIRE_APPROVE", reasonCode: "HIGH_STAKES_WRITE" };
      }
      if (mcpTier === "ADMIN") {
        return { verdict: "REQUIRE_APPROVE", reasonCode: "HIGH_STAKES_ADMIN" };
      }
    }
  }

  const ac = (actionClass ?? "") as ActionClass | string;
  if (ac === "EXTERNAL_SIDE_EFFECT") {
    return { verdict: "DENY", reasonCode: "UNKNOWN_EXTERNAL_SIDE_EFFECT" };
  }
  if (ac === "EXPORT") {
    return { verdict: "REQUIRE_APPROVE", reasonCode: "UNKNOWN_EXPORT" };
  }
  if (irreversible || ac === "WRITE") {
    return { verdict: "REQUIRE_APPROVE", reasonCode: "UNKNOWN_IRREVERSIBLE" };
  }

  return { verdict: "REQUIRE_APPROVE", reasonCode: "UNKNOWN_TOOL" };
}

/** Raise-only: risk may bump ALLOW → REQUIRE_APPROVE; never lowers DENY/REQUIRE_APPROVE. */
export function applySessionRisk(
  base: { verdict: PolicyVerdict; reasonCode: string; ruleId?: string },
  risk: SessionRisk | undefined,
): { verdict: PolicyVerdict; reasonCode: string; ruleId?: string } {
  if (base.verdict === "DENY" || base.verdict === "REQUIRE_APPROVE") {
    return base;
  }
  if (risk === "HIGH") {
    return { verdict: "REQUIRE_APPROVE", reasonCode: "SESSION_RISK_HIGH" };
  }
  if (risk === "MEDIUM") {
    return { verdict: "REQUIRE_APPROVE", reasonCode: "SESSION_RISK_MEDIUM" };
  }
  return base;
}

/**
 * Local fixture evaluate - day-1 offline demo without paid cloud or full console.
 * Doctrine: sole production PEP remains Shield HTTP; this is demo/CT only.
 * `toolInput` is the raw host tool input, read only for the never-list input rules.
 * It never goes into the request (only argsHash does), so nothing leaves the machine.
 */
export function evaluateOffline(
  req: PolicyEvaluateRequest,
  host: Host = "ide",
  toolInput?: unknown,
): PolicyEvaluateResponse {
  const irreversible = req.irreversible ?? false;
  const known = findSampleTool(req.toolId);
  const sandboxId = req.env?.sandboxId?.trim();
  if (known?.requiresSandbox && !sandboxId) {
    return {
      verdict: "DENY",
      reasonCode: "MISSING_SANDBOX_ID",
      toolId: req.toolId,
      argsHash: req.argsHash,
      localVerdict: "DENY",
      sessionRisk: (req.sessionRisk as SessionRisk | undefined) ?? "LOW",
      host: req.env?.host ?? host,
      opaAllow: false,
      opaReason: "OFFLINE_SAMPLE",
    };
  }
  const base = baseTier(req.toolId, irreversible, req.actionClass, toolInput);
  const risk = (req.sessionRisk as SessionRisk | undefined) ?? "LOW";
  const final = applySessionRisk(base, risk);
  const resolvedHost = req.env?.host ?? host;

  return {
    verdict: final.verdict,
    reasonCode: final.reasonCode,
    ...(final.ruleId ? { ruleId: final.ruleId } : {}),
    toolId: req.toolId,
    argsHash: req.argsHash,
    localVerdict: base.verdict,
    sessionRisk: risk,
    host: resolvedHost,
    opaAllow: final.verdict === "ALLOW",
    opaReason: "OFFLINE_SAMPLE",
  };
}
