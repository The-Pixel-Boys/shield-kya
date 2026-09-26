/**
 * Offline sample policy evaluate for light-install demos.
 * Not a second production PEP — production injects HTTP evaluate against Shield.
 * Same sample tools as docs/dev/kya-custom-tools-sample.md (R8: packs off),
 * plus the well-known host tool vocabulary in host-tools.ts.
 */

import type { Host } from "./config.js";
import type { PolicyEvaluateRequest, PolicyEvaluateResponse } from "./client.js";
import { findHostToolTier } from "./host-tools.js";
import { mcpToolTier, parseMcpToolId } from "./mcp-servers.js";
import { findSampleTool, type ActionClass, type PolicyVerdict } from "./sample-tools.js";

export type SessionRisk = "LOW" | "MEDIUM" | "HIGH";

function baseTier(
  toolId: string,
  irreversible: boolean,
  actionClass?: string,
): { verdict: PolicyVerdict; reasonCode: string } {
  if (!toolId || toolId.trim() === "") {
    return { verdict: "DENY", reasonCode: "EMPTY_TOOL" };
  }

  const known = findSampleTool(toolId);
  if (known?.policyTier) {
    if (known.policyTier === "DENY") {
      return { verdict: "DENY", reasonCode: "NEVER_EVENT" };
    }
    if (known.policyTier === "REQUIRE_APPROVE") {
      return { verdict: "REQUIRE_APPROVE", reasonCode: "HIGH_STAKES_WRITE" };
    }
    return { verdict: "ALLOW", reasonCode: "ALLOW" };
  }

  // Clearly destructive admin names on a KNOWN MCP server deny outright, even
  // when the caller declared risk signals — mirroring sample-tool NEVER.
  const mcp = parseMcpToolId(toolId);
  if (mcp && /drop|truncate|purge|transfer/.test(mcp.tool)) {
    return { verdict: "DENY", reasonCode: "NEVER_EVENT" };
  }

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
  base: { verdict: PolicyVerdict; reasonCode: string },
  risk: SessionRisk | undefined,
): { verdict: PolicyVerdict; reasonCode: string } {
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
 * Local fixture evaluate — day-1 offline demo without paid cloud or full console.
 * Doctrine: sole production PEP remains Shield HTTP; this is demo/CT only.
 */
export function evaluateOffline(
  req: PolicyEvaluateRequest,
  host: Host = "ide",
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
  const base = baseTier(req.toolId, irreversible, req.actionClass);
  const risk = (req.sessionRisk as SessionRisk | undefined) ?? "LOW";
  const final = applySessionRisk(base, risk);
  const resolvedHost = req.env?.host ?? host;

  return {
    verdict: final.verdict,
    reasonCode: final.reasonCode,
    toolId: req.toolId,
    argsHash: req.argsHash,
    localVerdict: base.verdict,
    sessionRisk: risk,
    host: resolvedHost,
    opaAllow: final.verdict === "ALLOW",
    opaReason: "OFFLINE_SAMPLE",
  };
}
