/**
 * Generate the gateway YAML from `.kya/gateways.json` + the MCP server
 * registry tiers. The CEL authorization rules are always derived from the
 * registry - never hand-written:
 *
 *   - destructive names (drop|truncate|purge|transfer, word-boundary anchored
 *     so `dropdown_select` is untouched) are denied for every server, and
 *     this deny always wins (rules are OR-allow, so the deny is expressed as
 *     "allow … AND NOT matches(deny)");
 *   - the server's ADMIN-tier registry patterns join the deny set;
 *   - everything else on the target is allowed: READ → allow, WRITE → allow
 *     (observe mode - allowed calls are audited, not blocked), and unmatched
 *     tools follow the server's defaultTier, which for every registered
 *     server resolves to one of those two allows;
 *   - unknown servers get the destructive-name deny only.
 *
 * A tool whose name matches the deny set has no allow rule, so the gateway
 * denies the call (and filters it from tools/list).
 *
 * Listener hardening: the binary binds UNSPECIFIED with no config knob, so
 * exposure is cut at L4 - a frontend networkAuthorization allowlist permits
 * only loopback sources (127.0.0.0/8, ::1) - and the stats/readiness/admin
 * listeners are turned off entirely. Logging is pinned to warn so module
 * noise (and upstream build strings) stays out of gate.log.
 */
import {
  mcpServerAdminPatterns,
  mcpServerDefaultTier,
} from "../mcp-servers.js";
import type { GatewayServer, GatewaysConfig } from "./config.js";

const DESTRUCTIVE_VERBS = ["drop", "truncate", "purge", "transfer"] as const;

/**
 * Destructive-name family denied on every target, registry or not. The verb must be a whole
 * word of the name: snake_case, kebab-case, dotted and camelCase/PascalCase all split into
 * words (`drop_table`, `drop-table`, `dropTable`, `DropTable`, `DROP_TABLE`). The gateway
 * engine has no lookaround and no `(?i)`, so each verb is spelled lower, Capitalized and
 * UPPER. A verb inside a longer word (`dropdown`, `purgeable`, `transferable`) is not a word.
 */
export const DESTRUCTIVE_PATTERN = `(?:${DESTRUCTIVE_VERBS.flatMap((v) => {
  const cap = v[0]!.toUpperCase() + v.slice(1);
  return [
    `(?:^|[^A-Za-z])${v}(?:[^a-z]|$)`,
    `(?:^|[^A-Za-z]|[a-z])${cap}(?:[^a-z]|$)`,
    `(?:^|[^A-Za-z])${v.toUpperCase()}(?:[^A-Za-z]|$)`,
  ];
}).join("|")})`;

/**
 * Whole names that carry a destructive verb as a word but are not destructive: the UI
 * gesture `drag_and_drop` (with at most one prefix word: `appium_drag_and_drop`,
 * `appiumDragAndDrop`) and the ML term `transfer_learn(ing)` (no prefix). Exact match
 * only, so a second verb or any other suffix (`drag_and_drop_table`) stays denied. Lifts
 * the destructive family only, never a server's ADMIN rules.
 */
export const DESTRUCTIVE_SAFE_PATTERN =
  "^(?:(?:[A-Za-z0-9]+[_-]|[a-z0-9]+)?(?:[Dd]rag[_-]?[Aa]nd[_-]?[Dd]rop|DRAG[_-]?AND[_-]?DROP)|[Tt]ransfer[_-]?[Ll]earn(?:ing)?|TRANSFER[_-]?LEARN(?:ING)?)$";

/**
 * The prefix word of a drag-and-drop name must not be a destructive verb itself
 * (`drop_drag_and_drop`, `dropDragAndDrop`): the safe exception does not apply then.
 */
export const DESTRUCTIVE_PREFIX_PATTERN = `^(?:${DESTRUCTIVE_VERBS.flatMap((v) => [v, v[0]!.toUpperCase() + v.slice(1), v.toUpperCase()]).join("|")})(?:[^a-z].*)?(?:[Dd]rag|DRAG)`;

const safeException = (name: string): string =>
  `(${name}.matches(${celString(DESTRUCTIVE_SAFE_PATTERN)}) && !${name}.matches(${celString(DESTRUCTIVE_PREFIX_PATTERN)}))`;

/** Loopback-only L4 rule for the (wildcard-bound) MCP listener. */
export const LOOPBACK_RULE =
  'cidr("127.0.0.0/8").containsIP(source.address) || source.address == "::1"';

/** Deny patterns for one server: destructive family + its ADMIN registry rules. */
export function denyPatternsFor(serverId: string): readonly string[] {
  const admin = mcpServerAdminPatterns(serverId) ?? [];
  return [...new Set([DESTRUCTIVE_PATTERN, ...admin])];
}

/**
 * Whether an unmatched tool on this server is allowed: the registry
 * defaultTier - READ and WRITE both map to allow (WRITE is observed, not
 * blocked); an ADMIN default would deny. Unknown servers allow (local
 * observe gateway), subject to the destructive deny.
 */
export function unmatchedAllowed(serverId: string): boolean {
  return mcpServerDefaultTier(serverId) !== "ADMIN";
}

function celString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Whether the generated gateway policy denies this tool name on this server (same rule as
 * the CEL below, for the report and tests). A bad pattern never denies.
 */
export function gatewayDenies(serverId: string, toolName: string): boolean {
  try {
    const [, ...admin] = denyPatternsFor(serverId);
    if (admin.length > 0 && new RegExp(admin.join("|")).test(toolName)) return true;
    if (!new RegExp(DESTRUCTIVE_PATTERN).test(toolName)) return false;
    return !new RegExp(DESTRUCTIVE_SAFE_PATTERN).test(toolName) || new RegExp(DESTRUCTIVE_PREFIX_PATTERN).test(toolName);
  } catch {
    return false;
  }
}

/** The OR-allow CEL rule for one server target. */
export function celAllowRule(server: GatewayServer): string {
  const target = `mcp.tool.target == ${celString(server.id)}`;
  if (!unmatchedAllowed(server.id)) {
    // ADMIN defaultTier: only explicitly non-denied, non-admin tools may run -
    // allow nothing unmatched (no registered server has this today).
    return `${target} && false`;
  }
  const [, ...admin] = denyPatternsFor(server.id);
  const name = "mcp.tool.name";
  const destructive = `(!${name}.matches(${celString(DESTRUCTIVE_PATTERN)}) || ${safeException(name)})`;
  return admin.length > 0
    ? `${target} && ${destructive} && !${name}.matches(${celString(admin.join("|"))})`
    : `${target} && ${destructive}`;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function indent(lines: string[], pad: string): string[] {
  return lines.map((l) => (l ? pad + l : l));
}

function targetYaml(server: GatewayServer): string[] {
  const lines: string[] = [`- name: ${q(server.id)}`];
  if (server.transport === "stdio") {
    const [cmd, ...args] = server.cmd!;
    lines.push("  stdio:");
    lines.push(`    cmd: ${q(cmd!)}`);
    if (args.length > 0) {
      lines.push("    args:");
      lines.push(...args.map((a) => `      - ${q(a)}`));
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push("    env:");
      for (const [k, v] of Object.entries(server.env)) {
        lines.push(`      ${q(k)}: ${q(v)}`);
      }
    }
  } else {
    lines.push("  mcp:");
    lines.push(`    host: ${q(server.url!)}`);
    if (server.headers && Object.keys(server.headers).length > 0) {
      // Transport policy on the http target: static auth headers.
      lines.push("  policies:");
      lines.push("    requestHeaderModifier:");
      lines.push("      set:");
      for (const [k, v] of Object.entries(server.headers)) {
        lines.push(`        ${q(k)}: ${q(v)}`);
      }
    }
  }
  return lines;
}

/**
 * Standalone gateway YAML: one listener multiplexing every server as an MCP
 * target behind a loopback-only L4 allowlist, generated CEL authorization,
 * OTLP/HTTP traces to the local receiver. `failureMode` (gateways.json,
 * default failOpen) decides whether one broken target takes the gateway down.
 */
export function generateGatewayYaml(config: GatewaysConfig): string {
  const lines: string[] = [
    "# Generated by kya gate - regenerate with `kya gate run` (do not edit).",
    "config:",
    '  statsAddr: "off"',
    '  readinessAddr: "off"',
    '  adminAddr: "off"',
    "  logging:",
    '    level: "warn"',
    "  tracing:",
    `    otlpEndpoint: ${q(`http://127.0.0.1:${config.otlpPort}`)}`,
    `    otlpProtocol: "http"`,
    "    randomSampling: true",
    "frontendPolicies:",
    "  networkAuthorization:",
    "    rules:",
    `      - allow: ${q(LOOPBACK_RULE)}`,
    "binds:",
    `  - port: ${config.port}`,
    "    listeners:",
    "      - routes:",
    "          - backends:",
    "              - mcp:",
    `                  failureMode: ${q(config.failureMode)}`,
  ];
  if (config.servers.length === 0) {
    lines.push("                  targets: []");
    return `${lines.join("\n")}\n`;
  }
  lines.push("                  targets:");
  for (const server of config.servers) {
    lines.push(...indent(targetYaml(server), "                    "));
  }
  // Backend-level policies: sibling of `mcp`, applies to the whole target set
  // (per-target rules match on mcp.tool.target inside the CEL).
  lines.push("                policies:");
  lines.push("                  mcpAuthorization:");
  lines.push("                    rules:");
  for (const server of config.servers) {
    lines.push(`                      - ${q(celAllowRule(server))}`);
  }
  return `${lines.join("\n")}\n`;
}
