/**
 * Hook wiring — install `kya hook --host <id>` as a PreToolUse hook in a
 * coding host's user config. Same write discipline as connect.ts: merge-only
 * for host-owned files (claude settings.json, kimi config.toml), whole-file
 * ownership for the kya-managed grok hook file, all writes symlink-safe and
 * crash-safe via atomicWriteSync/writeTarget/createTarget.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
// imports from connect.ts are call-time only (shared fs/registry helpers) — safe cycle
import {
  atomicWriteSync,
  cliJsPath,
  CONNECT_REGISTRY,
  createTarget,
  writeTarget,
  type ConnectStatus,
} from "./connect.js";

export interface WireHookInput {
  readonly host: string;
  readonly home: string;
  readonly force?: boolean;
}

export interface WireHookResult {
  readonly host: string;
  readonly label: string;
  readonly path: string;
  readonly status: ConnectStatus;
}

export const HOOK_HOSTS = ["claude", "grok", "kimi"] as const;

type HookHostId = (typeof HOOK_HOSTS)[number];

/** Whether a host has verified PreToolUse hook wiring. */
export function hookSupported(hostId: string): boolean {
  return (HOOK_HOSTS as readonly string[]).includes(hostId.trim().toLowerCase());
}

const HOOK_TIMEOUT_SECONDS = 5;

/** Shell command a host's PreToolUse hook runs. JSON-quoted paths are safe to embed. */
export function hookCommand(hostId: string): string {
  return [process.execPath, cliJsPath()]
    .map((s) => JSON.stringify(s))
    .join(" ") + ` hook --host ${hostId}`;
}

function hookIdentity(hostId: string): string {
  return `hook --host ${hostId}`;
}

/** Claude/Grok JSON entry shape: matcher "" matches every tool. */
function preToolUseEntry(hostId: string): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      { type: "command", command: hookCommand(hostId), timeout: HOOK_TIMEOUT_SECONDS },
    ],
  };
}

interface ClaudeSettingsHookEntry {
  hooks?: Array<{ command?: unknown }>;
}

/**
 * Merge a PreToolUse hook entry into ~/.claude/settings.json. Merge-only,
 * never clobbers: unparseable JSON or a wrongly-shaped hooks key is refused
 * instead of rewritten. An existing kya entry (matched by command identity)
 * means skipped; --force replaces that one entry, preserving all others.
 */
function wireClaudeSettings(path: string, force: boolean): ConnectStatus {
  const entry = preToolUseEntry("claude");
  if (!existsSync(path)) {
    atomicWriteSync(
      createTarget(path),
      `${JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2)}\n`,
    );
    return "created";
  }
  const target = writeTarget(path);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    // Never rewrite a host's real config we cannot parse — that destroys settings.
    throw new UsageError(
      `${path} is not valid JSON — fix it by hand or back it up and delete it, then re-run the hook wiring`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UsageError(
      `${path} is valid JSON but not an object — refusing to clobber it`,
    );
  }
  const hooks = raw["hooks"];
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) {
    throw new UsageError(
      `${path} has "hooks" but it is not an object — refusing to clobber it`,
    );
  }
  const hooksObj = (hooks ?? {}) as Record<string, unknown>;
  const preToolUse = hooksObj["PreToolUse"];
  if (preToolUse !== undefined && !Array.isArray(preToolUse)) {
    throw new UsageError(
      `${path} has "hooks.PreToolUse" but it is not an array — refusing to clobber it`,
    );
  }
  const entries = (preToolUse ?? []) as ClaudeSettingsHookEntry[];
  const isKyaEntry = (e: ClaudeSettingsHookEntry): boolean =>
    e != null &&
    Array.isArray(e.hooks) &&
    e.hooks.some(
      (h) => typeof h.command === "string" && h.command.includes(hookIdentity("claude")),
    );
  const kyaIndex = entries.findIndex(isKyaEntry);
  if (kyaIndex !== -1 && !force) return "skipped";
  if (kyaIndex !== -1) {
    entries[kyaIndex] = entry as ClaudeSettingsHookEntry;
  } else {
    entries.push(entry as ClaudeSettingsHookEntry);
  }
  hooksObj["PreToolUse"] = entries;
  raw["hooks"] = hooksObj;
  atomicWriteSync(target, `${JSON.stringify(raw, null, 2)}\n`);
  return "wired";
}

/**
 * ~/.grok/hooks/shield-kya.json is wholly kya-managed: deterministic content,
 * so an identical file means skipped and anything else is overwritten.
 */
function wireGrokHooks(path: string): ConnectStatus {
  const content = `${JSON.stringify({ hooks: { PreToolUse: [preToolUseEntry("grok")] } }, null, 2)}\n`;
  if (!existsSync(path)) {
    atomicWriteSync(createTarget(path), content);
    return "created";
  }
  const target = writeTarget(path);
  if (readFileSync(target, "utf8") === content) return "skipped";
  atomicWriteSync(target, content);
  return "wired";
}

const KIMI_HOOKS_HEADER_RE = /^[^\S\n]*\[\[hooks\]\][^\S\n]*(?:#.*)?$/m;

// A plain [hooks] table or a top-level `hooks = …` scalar cannot coexist with
// an appended [[hooks]] array — the result would be invalid TOML.
const KIMI_PLAIN_HOOKS_TABLE_RE = /^[^\S\n]*\[hooks\]/m;
// Deliberately stricter than its sibling: an indented `hooks = …` at top level
// is rare, and a false-positive refusal is the safe direction here.
const KIMI_TOP_LEVEL_HOOKS_RE = /^hooks\s*=/m;

/**
 * Build the [[hooks]] TOML block for a command string. The command goes into
 * a TOML literal string (single quotes) so the embedded JSON-quoted paths are
 * safe — but a literal string cannot hold a single quote or a newline, so
 * refuse those instead of writing invalid TOML into the user's config.
 */
export function kimiHooksBlockText(command: string): string {
  if (command.includes("'") || command.includes("\n") || command.includes("\r")) {
    throw new UsageError(
      `the kya hook command contains a single quote or newline and cannot be embedded in Kimi's TOML config — move the kya install to a path without quotes and re-run the hook wiring`,
    );
  }
  return [
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = '${command}'`,
    `timeout = ${HOOK_TIMEOUT_SECONDS}`,
    "",
  ].join("\n");
}

function kimiHooksBlock(hostId: string): string {
  return kimiHooksBlockText(hookCommand(hostId));
}

function assertKimiAppendable(path: string, text: string): void {
  if (KIMI_PLAIN_HOOKS_TABLE_RE.test(text) || KIMI_TOP_LEVEL_HOOKS_RE.test(text)) {
    throw new UsageError(
      `${path} already has a [hooks] table or a top-level hooks key — appending [[hooks]] would produce invalid TOML; fix the config by hand, then re-run the hook wiring`,
    );
  }
}

/**
 * Minimal TOML wiring for Kimi: append a [[hooks]] array element at EOF, skip
 * when the command identity already appears anywhere in the file (idempotent
 * by substring — quoted variants of our own block still match), --force
 * replaces the containing block (header line through the next table header or
 * EOF). Writes exactly the fields Kimi's config loader accepts.
 */
function wireKimiToml(path: string, force: boolean): ConnectStatus {
  const block = kimiHooksBlock("kimi");
  if (!existsSync(path)) {
    atomicWriteSync(createTarget(path), block);
    return "created";
  }
  const target = writeTarget(path);
  const text = readFileSync(target, "utf8");
  const identityIndex = text.indexOf(hookIdentity("kimi"));
  if (identityIndex !== -1 && !force) return "skipped";
  if (identityIndex === -1) {
    assertKimiAppendable(path, text);
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    atomicWriteSync(target, `${text}${sep}${block}`);
    return "wired";
  }
  // --force: replace the [[hooks]] block that contains the identity, from its
  // header line to the next table header or EOF.
  const beforeIdentity = text.slice(0, identityIndex);
  const headers = [...beforeIdentity.matchAll(new RegExp(KIMI_HOOKS_HEADER_RE.source, "gm"))];
  const start = headers.length === 0 ? -1 : headers[headers.length - 1]!.index;
  if (start === -1) {
    // Identity outside any [[hooks]] block — not ours to rewrite.
    assertKimiAppendable(path, text);
    const sep = text.endsWith("\n") ? "" : "\n";
    atomicWriteSync(target, `${text}${sep}${block}`);
    return "wired";
  }
  const lineEnd = text.indexOf("\n", start);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const nextHeader = text.slice(bodyStart).search(/^[^\S\n]*\[/m);
  const end = nextHeader === -1 ? text.length : bodyStart + nextHeader;
  atomicWriteSync(target, `${text.slice(0, start)}${block}${text.slice(end)}`);
  return "wired";
}

/** Wire `kya hook` into one host's user config. Unknown host → UsageError. */
export function wireHook(input: WireHookInput): WireHookResult {
  const key = input.host.trim().toLowerCase();
  const force = Boolean(input.force);
  let label: string;
  let path: string;
  let status: ConnectStatus;
  switch (key as HookHostId) {
    case "claude":
      label = CONNECT_REGISTRY["claude"]!.label;
      path = join(input.home, ".claude", "settings.json");
      status = wireClaudeSettings(path, force);
      break;
    case "grok":
      label = CONNECT_REGISTRY["grok"]!.label;
      path = join(input.home, ".grok", "hooks", "shield-kya.json");
      status = wireGrokHooks(path);
      break;
    case "kimi":
      label = CONNECT_REGISTRY["kimi"]!.label;
      path = join(input.home, ".kimi-code", "config.toml");
      status = wireKimiToml(path, force);
      break;
    default:
      throw new UsageError(
        `unknown hook host "${input.host}" — supported: ${HOOK_HOSTS.join(", ")}`,
      );
  }
  return { host: key, label, path, status };
}

/** Wire every supported host (or an explicit subset) under one home dir. */
export function wireHooks(input: {
  readonly home: string;
  readonly force?: boolean;
  readonly hosts?: readonly string[];
}): WireHookResult[] {
  const hosts = input.hosts ?? HOOK_HOSTS;
  return hosts.map((host) =>
    wireHook({ host, home: input.home, force: input.force }),
  );
}
