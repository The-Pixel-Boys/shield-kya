/**
 * Hook wiring - install `kya hook --host <id>` as a PreToolUse hook in a
 * coding host's user config. Same write discipline as connect.ts: merge-only
 * for host-owned files (claude settings.json, kimi config.toml), whole-file
 * ownership for the kya-managed grok hook file, all writes symlink-safe and
 * crash-safe via atomicWriteSync/writeTarget/createTarget.
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageError } from "../errors.js";
import { atomicWriteSync, projectWritePath, writeProjectFile } from "../fs-atomic.js";
import { journalIsDry, journalMkdir } from "../write-journal.js";
// imports from connect.ts are call-time only (shared fs/registry helpers) - safe cycle
import {
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
  /** Hosted-plane hook (preview, claude only): flags appended to the command. Never the key. */
  readonly hosted?: HostedHookWiring;
  /** "project" writes `<cwd>/.claude/settings.json` (claude only) instead of the home config. */
  readonly scope?: "global" | "project";
  readonly cwd?: string;
}

export interface HostedHookWiring {
  /** Absolute path of the 0600 plane config file (validated by the caller). */
  readonly configPath: string;
  readonly strict?: boolean;
  readonly shadow?: boolean;
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

export const PROJECT_HOOK_CLAUDE_ONLY = (host: string): string =>
  `--project hook wiring is claude only; ${host} hooks live in the user config (drop --project)`;

/** The stable launcher the OSS hook runs: <home>/.kya/bin/kya-hook (POSIX shell). */
export function launcherPath(home: string): string {
  return join(home, ".kya", "bin", "kya-hook");
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Launcher text. It prefers the node and cli.js recorded at start, falls back
 * to node on PATH and to `kya` on PATH (after a Node version switch), and
 * fails open with one stderr line when neither works: it never blocks a tool call.
 */
export function launcherScript(node: string, cli: string): string {
  return [
    "#!/bin/sh",
    "# Written by kya start. Runs `kya hook`. Fails open: never blocks a tool call when node or kya is missing.",
    "# Check it with: kya doctor. Remove it with: kya uninstall.",
    `KYA_NODE=${shSingleQuote(node)}`,
    `KYA_CLI=${shSingleQuote(cli)}`,
    "# First executable under an absolute PATH entry (a relative entry such as . or an empty one is skipped).",
    "kya_find() { kya_ifs=$IFS; IFS=:; for kya_d in $PATH; do case \"$kya_d\" in /*) if [ -x \"$kya_d/$1\" ] && [ ! -d \"$kya_d/$1\" ]; then IFS=$kya_ifs; printf '%s' \"$kya_d/$1\"; return 0; fi;; esac; done; IFS=$kya_ifs; return 1; }",
    'if [ ! -x "$KYA_NODE" ]; then KYA_NODE=$(kya_find node) || KYA_NODE=""; fi',
    'if [ -n "$KYA_NODE" ] && [ -f "$KYA_CLI" ]; then exec "$KYA_NODE" "$KYA_CLI" "$@"; fi',
    'KYA_BIN=$(kya_find kya) && exec "$KYA_BIN" "$@"',
    'echo "kya: hook skipped because node or kya was not found (run: kya doctor)" >&2',
    "exit 0",
    "",
  ].join("\n");
}

/** Write the launcher when missing or stale. Skipped on win32 (the hook keeps absolute paths there). */
export function ensureLauncher(home: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const path = launcherPath(home);
  const content = launcherScript(process.execPath, cliJsPath());
  if (existsSync(path) && readFileSync(path, "utf8") === content) return path;
  journalMkdir(dirname(path));
  atomicWriteSync(createTarget(path), content);
  if (!journalIsDry()) chmodSync(path, 0o755);
  return path;
}

/**
 * Shell command a host's PreToolUse hook runs. JSON-quoted paths are safe to
 * embed. The OSS hook (no `hosted`) goes through the launcher when `home` is
 * given; the hosted hook keeps direct paths so it stays fail-closed.
 */
export function hookCommand(hostId: string, hosted?: HostedHookWiring, home?: string): string {
  const useLauncher = !hosted && home !== undefined && process.platform !== "win32";
  const paths = useLauncher ? [launcherPath(home!)] : [process.execPath, cliJsPath()];
  // Inside double quotes the shell still expands $ and backticks: a path that holds one cannot be embedded.
  const hostile = paths.find((x) => /[$`"\n\r]/.test(x));
  if (hostile !== undefined) {
    throw new UsageError(`the hook command cannot embed ${hostile}: the path holds $, a backtick, a quote or a newline. Move kya or KYA_HOME to a plain path and re-run.`);
  }
  const base = `${paths.map((x) => JSON.stringify(x)).join(" ")} hook --host ${hostId}`;
  if (!hosted) return base;
  // Inside double quotes the shell still expands $ and backticks: refuse them.
  if (/[$`"\\\n\r]/.test(hosted.configPath)) {
    throw new UsageError("--plane-config path must not contain $, backtick, quote, backslash or newline");
  }
  return `${base} --plane-config ${JSON.stringify(hosted.configPath)}` +
    (hosted.strict ? " --strict" : "") +
    (hosted.shadow ? " --plane-shadow" : "");
}

function hookIdentity(hostId: string): string {
  return `hook --host ${hostId}`;
}

/**
 * Claude/Grok JSON entry shape: matcher "" matches every tool. The hosted hook
 * also sets onFailure "block" (Claude Code 2.1.295+), so a crash or host
 * timeout blocks the call instead of letting it through.
 */
function preToolUseEntry(hostId: string, hosted?: HostedHookWiring, home?: string): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCommand(hostId, hosted, home),
        timeout: HOOK_TIMEOUT_SECONDS,
        ...(hosted ? { onFailure: "block" } : {}),
      },
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
function wireClaudeSettings(path: string, force: boolean, hosted: HostedHookWiring | undefined, root: string | undefined, home: string): ConnectStatus {
  const entry = preToolUseEntry("claude", hosted, home);
  // Project scope (root set): never follow a link out of the project; home scope keeps the dotfiles behaviour.
  const write = (t: string, content: string) =>
    root ? writeProjectFile(path, content, root) : atomicWriteSync(t, content);
  if (!existsSync(path)) {
    write(
      root ? path : createTarget(path),
      `${JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2)}\n`,
    );
    return "created";
  }
  const target = root ? projectWritePath(path, root) : writeTarget(path);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    // Never rewrite a host's real config we cannot parse - that destroys settings.
    throw new UsageError(
      `${path} is not valid JSON - fix it by hand or back it up and delete it, then re-run the hook wiring`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UsageError(
      `${path} is valid JSON but not an object - refusing to clobber it`,
    );
  }
  const hooks = raw["hooks"];
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) {
    throw new UsageError(
      `${path} has "hooks" but it is not an object - refusing to clobber it`,
    );
  }
  const hooksObj = (hooks ?? {}) as Record<string, unknown>;
  const preToolUse = hooksObj["PreToolUse"];
  if (preToolUse !== undefined && !Array.isArray(preToolUse)) {
    throw new UsageError(
      `${path} has "hooks.PreToolUse" but it is not an array - refusing to clobber it`,
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
  const existingHosted = kyaIndex !== -1 &&
    (entries[kyaIndex]!.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("--plane-config"));
  if (existingHosted && !hosted) {
    // Never silently swap a fail-closed hosted hook for the fail-open OSS one.
    throw new UsageError(
      `${path} already has the hosted-plane kya hook; re-run with --hosted to change it, or remove that entry by hand to go back to the local hook`,
    );
  }
  // Hosted always replaces the kya entry: keeping the OSS copy next to it would
  // leave a second, fail-open hook (and two plane calls) per tool call.
  if (kyaIndex !== -1 && !force && !hosted) return "skipped";
  if (kyaIndex !== -1) {
    entries[kyaIndex] = entry as ClaudeSettingsHookEntry;
  } else {
    entries.push(entry as ClaudeSettingsHookEntry);
  }
  hooksObj["PreToolUse"] = entries;
  raw["hooks"] = hooksObj;
  write(target, `${JSON.stringify(raw, null, 2)}\n`);
  return "wired";
}

/**
 * ~/.grok/hooks/shield-kya.json is wholly kya-managed: deterministic content,
 * so an identical file means skipped and anything else is overwritten.
 */
function wireGrokHooks(path: string, home: string): ConnectStatus {
  const content = `${JSON.stringify({ hooks: { PreToolUse: [preToolUseEntry("grok", undefined, home)] } }, null, 2)}\n`;
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
// an appended [[hooks]] array - the result would be invalid TOML.
const KIMI_PLAIN_HOOKS_TABLE_RE = /^[^\S\n]*\[hooks\]/m;
// Deliberately stricter than its sibling: an indented `hooks = …` at top level
// is rare, and a false-positive refusal is the safe direction here.
const KIMI_TOP_LEVEL_HOOKS_RE = /^hooks\s*=/m;

/**
 * Build the [[hooks]] TOML block for a command string. The command goes into
 * a TOML literal string (single quotes) so the embedded JSON-quoted paths are
 * safe - but a literal string cannot hold a single quote or a newline, so
 * refuse those instead of writing invalid TOML into the user's config.
 */
export function kimiHooksBlockText(command: string): string {
  if (command.includes("'") || command.includes("\n") || command.includes("\r")) {
    throw new UsageError(
      `the kya hook command contains a single quote or newline and cannot be embedded in Kimi's TOML config - move the kya install to a path without quotes and re-run the hook wiring`,
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

function kimiHooksBlock(hostId: string, home: string): string {
  return kimiHooksBlockText(hookCommand(hostId, undefined, home));
}

function assertKimiAppendable(path: string, text: string): void {
  if (KIMI_PLAIN_HOOKS_TABLE_RE.test(text) || KIMI_TOP_LEVEL_HOOKS_RE.test(text)) {
    throw new UsageError(
      `${path} already has a [hooks] table or a top-level hooks key - appending [[hooks]] would produce invalid TOML; fix the config by hand, then re-run the hook wiring`,
    );
  }
}

/**
 * Minimal TOML wiring for Kimi: append a [[hooks]] array element at EOF, skip
 * when the command identity already appears anywhere in the file (idempotent
 * by substring - quoted variants of our own block still match), --force
 * replaces the containing block (header line through the next table header or
 * EOF). Writes exactly the fields Kimi's config loader accepts.
 */
function wireKimiToml(path: string, force: boolean, home: string): ConnectStatus {
  const block = kimiHooksBlock("kimi", home);
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
    // Identity outside any [[hooks]] block - not ours to rewrite.
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

/** True when the (already wired) host config runs the hook through the launcher, so a missing launcher must be rewritten. */
function existingUsesLauncher(path: string, home: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(launcherPath(home));
  } catch {
    return false;
  }
}

/** Wire `kya hook` into one host's user config. Unknown host → UsageError. */
export function wireHook(input: WireHookInput): WireHookResult {
  const key = input.host.trim().toLowerCase();
  const force = Boolean(input.force);
  if (input.hosted && key !== "claude") {
    throw new UsageError(
      `--hosted hook wiring is claude only in this preview (needs the host's onFailure "block"); ${input.host} is not supported`,
    );
  }
  const project = input.scope === "project";
  if (project && key !== "claude") {
    throw new UsageError(PROJECT_HOOK_CLAUDE_ONLY(input.host));
  }
  let label: string;
  let path: string;
  let status: ConnectStatus;
  switch (key as HookHostId) {
    case "claude":
      label = CONNECT_REGISTRY["claude"]!.label;
      if (project) {
        if (!input.cwd) throw new UsageError("--project hook wiring needs a project directory");
        path = join(input.cwd, ".claude", "settings.json");
        status = wireClaudeSettings(path, force, input.hosted, input.cwd, input.home);
      } else {
        path = join(input.home, ".claude", "settings.json");
        status = wireClaudeSettings(path, force, input.hosted, undefined, input.home);
      }
      break;
    case "grok":
      label = CONNECT_REGISTRY["grok"]!.label;
      path = join(input.home, ".grok", "hooks", "shield-kya.json");
      status = wireGrokHooks(path, input.home);
      break;
    case "kimi":
      label = CONNECT_REGISTRY["kimi"]!.label;
      path = join(input.home, ".kimi-code", "config.toml");
      status = wireKimiToml(path, force, input.home);
      break;
    default:
      throw new UsageError(
        `unknown hook host "${input.host}" - supported: ${HOOK_HOSTS.join(", ")}`,
      );
  }
  // The hook now points at the launcher: make sure it exists (never for a skipped, already-wired host).
  if (!input.hosted && (status !== "skipped" || existingUsesLauncher(path, input.home))) ensureLauncher(input.home);
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
