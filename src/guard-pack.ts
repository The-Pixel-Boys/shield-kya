/**
 * Guard pack: a second layer of local denies on top of the never-list input rules
 * (never-list-input.ts, owner approved, ids unchanged). It adds destructive shell commands that
 * list does not know (terraform destroy, SQL drops, docker volumes, cloud deletes, ...), reads of
 * more credential files, secret-shaped writes and secret exfiltration.
 *
 * Same stance as the never-list: a seatbelt, not a sandbox. Reuses its scanner, so wrappers,
 * `bash -c`, substitutions and same-command `NAME=value` are already unwrapped. Never throws: any
 * error is "no hit" (the local hook fails open).
 *
 * Config (`shellNeverList`, `secretsGuard`, `exfilGuard`, `guardAllow`) is read from the USER-level
 * `<home>/.kya/config.json` only. A project `.kya/config.json` ships with the repo and the agent can
 * write it, so it can never lift a deny.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import {
  Cmd, commandStrings, fieldsOf, gitSubInfo, hasCommand, isSecretPath, isShellTool, isWriteLike,
  normalizePath, parseShell, pathStrings, windowsOf, type Shell,
} from "./never-list-input.js";

export type GuardCode = "NEVER_SHELL" | "NEVER_SECRET_READ" | "NEVER_SECRET_WRITE" | "NEVER_EXFIL";

export interface GuardHit {
  readonly rule: string;
  readonly code: GuardCode;
  /** Absolute, normalized path the rule fired on, when it has one (matched by `guardAllow` `path`). */
  readonly target?: string;
}

export interface GuardContext {
  readonly cwd: string;
  readonly home: string | undefined;
  /** Defaults to cwd. */
  readonly projectRoot?: string;
  /** Variables for `rm -rf "$X/"`. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface GuardAllow {
  readonly rule: string;
  readonly path?: string;
  readonly command?: string;
}

export interface GuardConfig {
  readonly shellNeverList: boolean;
  readonly secretsGuard: boolean;
  readonly exfilGuard: boolean;
  readonly guardAllow: readonly GuardAllow[];
}

export const GUARD_DEFAULTS: GuardConfig = { shellNeverList: true, secretsGuard: true, exfilGuard: true, guardAllow: [] };

/** Rule ids of the shell family, in match order. Listed in docs/guard-pack.md. */
export const GUARD_SHELL_RULES = [
  "rm-root-home", "terraform-destroy", "sql-drop", "git-force-push", "git-delete-default-branch", "git-hard-reset-clean",
  "docker-volumes", "k8s-delete-ns", "cloud-delete", "railway-volume-delete",
] as const;

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/** Home for the guard: an absolute `HOME` from the given env, else the OS home. */
export function guardContextFrom(cwd: string, env: NodeJS.ProcessEnv = process.env): GuardContext {
  const h = env.HOME?.trim();
  let home: string | undefined = h && h.startsWith("/") ? h : undefined;
  if (!home) {
    try {
      const o = homedir();
      home = o && o.startsWith("/") ? o : undefined;
    } catch { /* no home */ }
  }
  return { cwd, home, projectRoot: cwd, env };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Read the guard keys from `<home>/.kya/config.json`. A missing file is the defaults. A malformed
 * file or key falls back to the default for that key and reports `problem` (the hook writes one
 * trail line). Never throws.
 */
export function readGuardConfig(home: string | undefined): { readonly config: GuardConfig; readonly problem?: string } {
  if (!home) return { config: GUARD_DEFAULTS };
  let text: string;
  try {
    text = readFileSync(`${home}/.kya/config.json`, "utf8");
  } catch {
    return { config: GUARD_DEFAULTS };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: GUARD_DEFAULTS, problem: "unreadable config" };
  }
  if (!isObj(raw)) return { config: GUARD_DEFAULTS, problem: "config is not an object" };
  const bad: string[] = [];
  const flag = (k: "shellNeverList" | "secretsGuard" | "exfilGuard"): boolean => {
    const v = raw[k];
    if (v === undefined) return true;
    if (typeof v === "boolean") return v;
    bad.push(k);
    return true;
  };
  const allow: GuardAllow[] = [];
  const list = raw.guardAllow;
  if (list !== undefined && !Array.isArray(list)) bad.push("guardAllow");
  else {
    for (const e of (list ?? []) as unknown[]) {
      if (isObj(e) && typeof e.rule === "string" && e.rule && (typeof e.path === "string") !== (typeof e.command === "string")) {
        allow.push({ rule: e.rule, ...(typeof e.path === "string" ? { path: e.path } : { command: e.command as string }) });
      } else bad.push("guardAllow entry");
    }
  }
  const config: GuardConfig = { shellNeverList: flag("shellNeverList"), secretsGuard: flag("secretsGuard"), exfilGuard: flag("exfilGuard"), guardAllow: allow };
  return bad.length ? { config, problem: `invalid ${[...new Set(bad)].join(", ")}` } : { config };
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Shell glob match, segment by segment: a leading `*`, `?` or `[` does not match a name that starts with a dot. */
function dotGlobMatch(pattern: string, path: string): boolean {
  const ps = pattern.split("/");
  const ts = path.split("/");
  if (ps.length !== ts.length) return false;
  return ps.every((p, i) => {
    const t = ts[i]!;
    if (t.startsWith(".") && /^[*?[]/.test(p)) return false;
    return globToRegExp(p).test(t);
  });
}

function allowed(hit: GuardHit, cfg: GuardConfig, ctx: GuardContext, command: string | undefined): boolean {
  if (hit.rule === "guard-config-write") return false;
  for (const a of cfg.guardAllow) {
    if (a.rule !== hit.rule) continue;
    if (a.command !== undefined && command !== undefined && a.command === command.trim()) return true;
    if (a.path !== undefined && hit.target !== undefined) {
      const glob = normalizePath(a.path, ctx.home);
      if (globToRegExp(glob).test(hit.target)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Words {
  readonly pos: string[];
  readonly flags: string[];
}

/** Split args into operands and options. An option in `valueOpts` takes the next word as its value. */
function words(args: readonly string[], valueOpts: ReadonlySet<string> = new Set()): Words {
  const pos: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      flags.push(a);
      // A value option takes the next word, unless that word is itself an option (`prune -f --volumes`).
      if (valueOpts.has(a) && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const hasLong = (flags: readonly string[], ...names: string[]): boolean =>
  flags.some((f) => names.some((n) => f === n || f.startsWith(`${n}=`)));
/** A short flag letter in any cluster: `-fdx` has f, d and x. */
const hasShort = (flags: readonly string[], letter: string): boolean =>
  flags.some((f) => /^-[A-Za-z]+$/.test(f) && f.includes(letter));

function absPath(word: string, ctx: GuardContext): string {
  const w = expandVars(word, ctx).text;
  if (w.startsWith("/") || w === "~" || w.startsWith("~/") || /^~[A-Za-z]/.test(w)) return normalizePath(w, ctx.home);
  return normalizePath(posix.join(ctx.cwd, w), ctx.home);
}

/** `$NAME` and `${NAME}` from the hook's environment (HOME from the context). `unset` is true when one was missing or empty. */
function expandVars(word: string, ctx: GuardContext): { text: string; unset: boolean } {
  let unset = false;
  const env = ctx.env ?? process.env;
  const text = word.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    const v = name === "HOME" ? ctx.home : env[name];
    if (v === undefined || v === "") {
      unset = true;
      return "";
    }
    return v;
  });
  return { text, unset };
}

// ---------------------------------------------------------------------------------------------
// Shell rules
// ---------------------------------------------------------------------------------------------

/** A matcher returns undefined (no match), one target ("" when it has none), or every target it matched, so `guardAllow` can judge each one. */
type Matcher = (sh: Shell, ctx: GuardContext) => string | readonly string[] | undefined;
const NO: undefined = undefined;

const isRecursiveFlags = (flags: readonly string[]): boolean => hasLong(flags, "--recursive") || hasShort(flags, "r") || hasShort(flags, "R");
const isForceFlags = (flags: readonly string[]): boolean => hasLong(flags, "--force") || hasShort(flags, "f");

/** Root, home or one of its ancestors, or an ancestor of the project root. `/*` and `/.*` count as the directory. */
function rmTargetHit(word: string, ctx: GuardContext, assigned: ReadonlySet<string>): string | undefined {
  if (word.includes("$(") || word.includes("`")) return NO;
  // A variable the same command assigns at run time (`for d in a b; do rm -rf "$d"`, `read f`) has a value we cannot see.
  for (const m of word.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    if (assigned.has((m[1] ?? m[2])!)) return NO;
  }
  const { text, unset } = expandVars(word, ctx);
  // `rm -rf "$X"` with X unset runs `rm -rf ""`; `"$X/"` runs `rm -rf /`. Both are the bug this rule is for.
  if (unset && text === "") return "";
  let p = absPath(word, ctx);
  p = p.replace(/\/(\.\*|\*)$/, "") || "/";
  const root = ctx.projectRoot ?? ctx.cwd;
  const home = ctx.home;
  if (p === "/") return "/";
  if (home && (p === home || home.startsWith(`${p}/`))) return p;
  if (p !== root && root.startsWith(`${p}/`)) return p;
  return NO;
}

/** Names bound by `for NAME in`, `select NAME in` and `read [-opts] NAME...` in this command. */
function runtimeVars(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.matchAll(/\b(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) out.add(m[1]!);
  for (const m of raw.matchAll(/\bread\s+((?:-\S+\s+)*)((?:[A-Za-z_][A-Za-z0-9_]*\s*)+)/g)) for (const n of m[2]!.trim().split(/\s+/)) out.add(n);
  return out;
}

const rmRoot: Matcher = (sh, ctx) => {
  const assigned = runtimeVars(sh.raw);
  const targets: string[] = [];
  hasCommand(sh, (c) => {
    if (c.name !== "rm") return false;
    const { pos, flags } = words(c.args);
    if (!isRecursiveFlags(flags) || !isForceFlags(flags)) return false;
    for (const t of pos) {
      const hit = rmTargetHit(t, ctx, assigned);
      if (hit !== undefined) targets.push(hit);
    }
    return false; // keep scanning: every matching target is judged by guardAllow
  });
  return targets.length ? targets : NO;
};

const named = (...names: string[]) => (c: Cmd): boolean => names.includes(c.name);

const terraformDestroy: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (!named("terraform", "tofu")(c)) return false;
    const { pos, flags } = words(c.args);
    return pos[0] === "destroy" || (pos[0] === "apply" && flags.some((f) => /^-destroy(=true)?$/.test(f)));
  }) ? "" : NO;

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "clickhouse-client"]);
const SQL_DROP = /\b(?:drop\s+(?:table|database|schema)|truncate\s+(?:table\s+)?[\w"`[.])/i;
const sqlDrop: Matcher = (sh) => (hasCommand(sh, (c) => DB_CLIENTS.has(c.name)) && SQL_DROP.test(sh.raw) ? "" : NO);

const gitSub = (c: Cmd): { sub: string; rest: readonly string[] } => {
  const { idx } = gitSubInfo(c.args);
  return { sub: c.args[idx] ?? "", rest: c.args.slice(idx + 1) };
};

const gitForcePush: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (c.name !== "git") return false;
    const { sub, rest } = gitSub(c);
    if (sub !== "push") return false;
    const { pos, flags } = words(rest, new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]));
    // Force is `--force`, or a short cluster with f. `--force-with-lease` and `--force-if-includes` are the safe forms.
    const force = flags.some((f) => f === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(f));
    return force || pos.slice(1).some((r) => r.startsWith("+"));
  }) ? "" : NO;

const DEFAULT_BRANCH = /^(main|master)$/;
const branchName = (r: string): string => r.replace(/^\+/, "").replace(/^refs\/heads\//, "");

const gitDeleteDefaultBranch: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (c.name !== "git") return false;
    const { sub, rest } = gitSub(c);
    const { pos, flags } = words(rest);
    if (sub === "push") {
      const del = flags.some((f) => f === "--delete" || /^-[A-Za-z]*d[A-Za-z]*$/.test(f));
      return pos.slice(1).some((r) => (r.startsWith(":") && DEFAULT_BRANCH.test(branchName(r.slice(1)))) || (del && DEFAULT_BRANCH.test(branchName(r))));
    }
    if (sub === "branch") {
      const forced = hasShort(flags, "D") || (flags.some((f) => f === "--delete" || /^-[A-Za-z]*d[A-Za-z]*$/.test(f)) && isForceFlags(flags));
      return forced && pos.some((b) => DEFAULT_BRANCH.test(b));
    }
    return false;
  }) ? "" : NO;

const gitHardResetClean: Matcher = (sh) => {
  const hard = hasCommand(sh, (c) => c.name === "git" && gitSub(c).sub === "reset" && c.args.includes("--hard"));
  if (!hard) return NO;
  return hasCommand(sh, (c) => {
    if (c.name !== "git") return false;
    const { sub, rest } = gitSub(c);
    if (sub !== "clean") return false;
    const { flags } = words(rest);
    return hasShort(flags, "f") && hasShort(flags, "d") && hasShort(flags, "x");
  }) ? "" : NO;
};

const DOCKER_VALUE_OPTS = new Set(["-H", "--host", "--context", "-c", "-l", "--log-level", "--config", "-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"]);
const dockerVolumes: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (!named("docker", "podman", "docker-compose")(c)) return false;
    const { pos, flags } = words(c.args, DOCKER_VALUE_OPTS);
    if (c.name === "docker-compose") return pos[0] === "down" && (hasLong(flags, "--volumes") || hasShort(flags, "v"));
    if (pos[0] === "volume") return pos[1] === "rm" || pos[1] === "remove" || pos[1] === "prune";
    if (pos[0] === "system" && pos[1] === "prune") return hasLong(flags, "--volumes", "--all") || hasShort(flags, "a");
    if (pos[0] === "compose" && pos[1] === "down") return hasLong(flags, "--volumes") || hasShort(flags, "v");
    return false;
  }) ? "" : NO;

const KUBECTL_VALUE_OPTS = new Set(["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server", "--user", "-l", "--selector", "-f", "--filename", "-o", "--output"]);
const k8sDeleteNs: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (c.name !== "kubectl") return false;
    const { pos, flags } = words(c.args, KUBECTL_VALUE_OPTS);
    if (pos[0] !== "delete") return false;
    if ((pos[1] ?? "").split(",").some((r) => /^(namespaces?|ns)$/.test(r))) return true;
    return hasLong(flags, "--all") && (flags.includes("-A") || hasLong(flags, "--all-namespaces"));
  }) ? "" : NO;

const AWS_VALUE_OPTS = new Set(["--profile", "--region", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout"]);
const GCLOUD_VALUE_OPTS = new Set(["--project", "--account", "--format", "--configuration", "--impersonate-service-account", "--billing-project", "--verbosity"]);
const cloudDelete: Matcher = (sh) =>
  hasCommand(sh, (c) => {
    if (c.name === "aws") {
      const { pos, flags } = words(c.args, AWS_VALUE_OPTS);
      const [svc, op] = pos;
      if (svc === "ec2") return op === "terminate-instances";
      if (svc === "s3") return (op === "rb" && hasLong(flags, "--force")) || (op === "rm" && hasLong(flags, "--recursive"));
      if (svc === "rds") return op === "delete-db-instance" || op === "delete-db-cluster";
      return false;
    }
    if (c.name === "gcloud") {
      const { pos } = words(c.args, GCLOUD_VALUE_OPTS);
      const p = pos[0] === "alpha" || pos[0] === "beta" ? pos.slice(1) : pos;
      return (p[0] === "projects" && p[1] === "delete") || (p[0] === "sql" && p[1] === "instances" && p[2] === "delete");
    }
    if (c.name === "az") {
      const { pos } = words(c.args);
      return pos[0] === "group" && pos[1] === "delete";
    }
    return false;
  }) ? "" : NO;

const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "httpie"]);
const railwayVolumeDelete: Matcher = (sh) =>
  (hasCommand(sh, (c) => HTTP_CLIENTS.has(c.name)) && sh.raw.includes("volumeDelete")) ||
  hasCommand(sh, (c) => {
    if (c.name !== "railway") return false;
    const { pos } = words(c.args);
    return pos[0] === "volume" && pos[1] === "delete";
  }) ? "" : NO;

const SHELL_MATCHERS: ReadonlyArray<readonly [string, Matcher]> = [
  ["rm-root-home", rmRoot],
  ["terraform-destroy", terraformDestroy],
  ["sql-drop", sqlDrop],
  ["git-force-push", gitForcePush],
  ["git-delete-default-branch", gitDeleteDefaultBranch],
  ["git-hard-reset-clean", gitHardResetClean],
  ["docker-volumes", dockerVolumes],
  ["k8s-delete-ns", k8sDeleteNs],
  ["cloud-delete", cloudDelete],
  ["railway-volume-delete", railwayVolumeDelete],
];

// ---------------------------------------------------------------------------------------------
// Secrets: reads, writes, exfiltration
// ---------------------------------------------------------------------------------------------

/**
 * Credential files the never-list does not already cover (it has ssh keys, `~/.aws/credentials`, gcloud
 * credential files, npmrc, netrc, git-credentials, `.env`, `*.pem`, `*.key`). Returns the kind for the rule id.
 */
function secretKind(p: string, home: string | undefined): string | undefined {
  if (home) {
    const rel = p.startsWith(`${home}/`) ? p.slice(home.length + 1) : undefined;
    if (rel !== undefined) {
      if (rel === ".railway/config.json") return "railway";
      if (rel === ".docker/config.json") return "docker";
      if (rel === ".kube/config") return "kube";
      if (rel === ".pypirc") return "pypirc";
      if (rel === ".config/gh/hosts.yml") return "gh";
      if (rel.startsWith(".azure/")) return "azure";
      if (rel.startsWith(".config/gcloud/")) return "gcloud";
    }
  }
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(base) && !base.endsWith(".pub")) return "key";
  if (/^\/proc\/[^/]+\/environ$/.test(p)) return "environ";
  return NO;
}

function sensitive(word: string, ctx: GuardContext): boolean {
  if (word.length === 0 || word.startsWith("-")) return false;
  const abs = absPath(word, ctx);
  return isSecretPath(word, ctx.home) || isSecretPath(abs, ctx.home) || secretKind(abs, ctx.home) !== undefined;
}

const READ_CMDS = new Set([
  "cat", "less", "more", "head", "tail", "cp", "scp", "rsync", "base64", "xxd", "strings", "od", "hexdump", "tac", "nl", "bat",
  "jq", "yq", "sed", "awk", "cut", "sort", "tar", "zip",
]);
const COPY_CMDS = new Set(["cp", "scp", "rsync"]);

/** A read verb with a credential file the never-list does not know (or a redirect from one). */
function secretReadHits(sh: Shell, ctx: GuardContext): { rule: string; target: string }[] {
  const hits: { rule: string; target: string }[] = [];
  for (const seg of sh.segments) {
    const toks = seg.tokens;
    for (let i = 0; i + 1 < toks.length; i++) {
      if (toks[i] === "<") {
        const abs = absPath(toks[i + 1]!, ctx);
        const k = secretKind(abs, ctx.home);
        if (k) hits.push({ rule: `secret-read-${k}`, target: abs });
      }
    }
    for (const c of seg.cmds) {
      if (!READ_CMDS.has(c.name)) continue;
      const args = COPY_CMDS.has(c.name) ? c.args.slice(0, -1) : c.args;
      for (const a of args) {
        if (a.startsWith("-") || a.includes(":") && !a.startsWith("/") && !a.startsWith("~") && !a.startsWith(".")) continue;
        const abs = absPath(a, ctx);
        const k = secretKind(abs, ctx.home);
        if (k) hits.push({ rule: `secret-read-${k}`, target: abs });
      }
    }
  }
  return hits;
}

// Built from parts so this source file never contains a literal key header.
const KEY_HEADER = "-----BEGIN (RSA |OPENSSH |EC |DSA )?" + "PRIVATE KEY-----";
const SECRET_WRITE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["aws", /(AKIA|ASIA)[A-Z0-9]{16}/],
  ["privkey", new RegExp(KEY_HEADER)],
  ["github", /ghp_[A-Za-z0-9]{36}/],
  ["github-pat", /github_pat_[A-Za-z0-9_]{60,}/],
  ["slack", /xox[abpr]-[A-Za-z0-9-]{10,}/],
  ["stripe", /sk_live_[A-Za-z0-9]{20,}/],
];

function secretShape(text: string): string | undefined {
  for (const w of windowsOf(text)) {
    for (const [kind, re] of SECRET_WRITE_PATTERNS) if (re.test(w)) return kind;
  }
  return NO;
}

const OLD_TEXT_KEYS = new Set(["old_string", "old_str", "oldString", "old_text", "oldText"]);
/** Every string in the input except the text an edit removes and its path. Bounded depth and count. */
function writtenStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 64 || depth > 4) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) writtenStrings(x, out, depth + 1);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (!OLD_TEXT_KEYS.has(k) && !/path$/i.test(k)) writtenStrings(x, out, depth + 1);
  return out;
}

/** `echo`, `printf`, `cat` or `tee` that puts secret-shaped text into a file (redirect, heredoc or tee). */
function shellSecretWrite(sh: Shell): string | undefined {
  if (!hasCommand(sh, (c) => ["echo", "printf", "cat", "tee"].includes(c.name))) return NO;
  if (!/>|\btee\b/.test(sh.raw)) return NO;
  return secretShape(sh.raw);
}

const NET_SINKS = new Set(["curl", "wget", "nc", "ncat", "socat", "scp", "rsync"]);
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

function hostOf(token: string): string | undefined {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(token);
  if (url) return url[1]!;
  return NO;
}

const SINK_VALUE_OPTS = new Set([
  "-p", "-s", "-w", "-i", "-o", "-e", "-u", "-X", "-H", "-d", "-F", "-T", "-A", "-x", "-b", "-c", "-m",
  "--data", "--data-binary", "--data-raw", "--data-urlencode", "--header", "--output", "--request", "--form", "--upload-file",
  "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--proxy", "--write-out", "--max-time", "--connect-timeout",
  "--post-data", "--post-file", "--body-data", "--body-file", "--output-document",
]);

/**
 * Destination hosts named in a sink command. Empty when none could be read. For curl and wget every operand
 * counts (scheme URLs, `--url X` and bare hostnames), so one loopback URL cannot vouch for a second target.
 */
function sinkHosts(c: Cmd): string[] {
  const hosts: string[] = [];
  const { pos } = words(c.args, SINK_VALUE_OPTS);
  for (const a of c.args) {
    const h = hostOf(a);
    if (h) hosts.push(h);
  }
  if (c.name === "curl" || c.name === "wget") {
    for (const p of pos) if (!hostOf(p)) hosts.push(p.replace(/[:/].*$/, ""));
    return hosts;
  }
  if (hosts.length) return hosts;
  if (c.name === "nc" || c.name === "ncat") return pos[0] ? [pos[0]] : [];
  if (c.name === "socat") {
    for (const a of pos) {
      const m = /^(?:TCP|TCP4|TCP6|UDP|SSL)[:-]([^:]+)/i.exec(a);
      if (m) hosts.push(m[1]!);
    }
    return hosts;
  }
  if (c.name === "scp" || c.name === "rsync") {
    for (const a of pos) {
      const m = /^(?:[^@/:]+@)?([^:/@]+):/.exec(a);
      if (m && !a.startsWith("/") && !a.startsWith(".")) hosts.push(m[1]!);
    }
    return hosts;
  }
  return hosts;
}

/** Options that send the traffic somewhere other than the URL's host. Their presence voids the loopback exception. */
const REDIRECTING_OPT = /^(-x|--proxy|--preproxy|--connect-to|--resolve|--socks[45]?(-hostname)?|--proxy-.*|--no-check-certificate|-e|--execute)(=|$)/;

const isLoopbackOnly = (c: Cmd): boolean => {
  if (c.args.some((a) => REDIRECTING_OPT.test(a))) return false;
  const hosts = sinkHosts(c);
  return hosts.length > 0 && hosts.every((h) => LOOPBACK.test(h));
};

/** A segment that starts a pipeline with the process environment: `env`, `printenv`, bare `set`. */
function envSource(toks: readonly string[]): boolean {
  const first = toks.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (first === "printenv") return true;
  if (first === "env" || first === "set") return toks.slice(toks.indexOf(first) + 1).every((t) => t.startsWith("-"));
  return false;
}

const ENV_SUBST = /\$\(\s*(?:env|printenv)\b|`\s*(?:env|printenv)\b/;

/** A sensitive file passed to a sink as data: `-d @f`, `-F f=@f`, `-T f`, `< f`, or the source of scp/rsync. */
function sinkTakesFile(c: Cmd, toks: readonly string[], ctx: GuardContext): boolean {
  const a = c.args;
  for (let i = 0; i < a.length; i++) {
    const t = a[i]!;
    const at = t.indexOf("@");
    if ((c.name === "curl" || c.name === "wget") && at >= 0 && t.slice(at + 1) !== "-" && sensitive(t.slice(at + 1), ctx)) return true;
    if ((t === "-T" || t === "--upload-file") && i + 1 < a.length && sensitive(a[i + 1]!, ctx)) return true;
  }
  for (let i = 0; i + 1 < toks.length; i++) if (toks[i] === "<" && sensitive(toks[i + 1]!, ctx)) return true;
  if (c.name === "scp" || c.name === "rsync") {
    return a.slice(0, -1).some((t) => !t.startsWith("-") && !/^[^/.~][^/]*:/.test(t) && sensitive(t, ctx));
  }
  return false;
}

function exfilHit(sh: Shell, ctx: GuardContext): string | undefined {
  let tainted = false;
  for (const seg of sh.segments) {
    if (!seg.pipeIn) tainted = false;
    const toks = seg.tokens;
    const sink = seg.cmds.find((c) => NET_SINKS.has(c.name));
    if (sink) {
      const flowing = tainted || sinkTakesFile(sink, toks, ctx) || toks.some((t) => ENV_SUBST.test(t));
      if (flowing && !isLoopbackOnly(sink)) return sink.name;
      continue;
    }
    if (envSource(toks)) tainted = true;
    else if (seg.cmds.some((c) => READ_CMDS.has(c.name) && c.args.some((a) => sensitive(a, ctx)))) tainted = true;
  }
  return NO;
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

const WRITE_CMDS = new Set(["tee", "cp", "mv", "rm", "ln", "dd", "install", "truncate", "touch", "rsync", "scp", "chmod", "chown"]);

/** The user-level guard config. An agent that can edit it can lift its own deny, so writes to it are always denied. */
function guardConfigPath(ctx: GuardContext): string | undefined {
  return ctx.home ? `${ctx.home}/.kya/config.json` : undefined;
}

/** A shell command that writes, moves, deletes or redirects into the user-level guard config (or its folder). */
function shellWritesGuardConfig(sh: Shell, ctx: GuardContext): boolean {
  const target = guardConfigPath(ctx);
  if (!target) return false;
  const dir = target.slice(0, target.lastIndexOf("/"));
  for (const seg of sh.segments) {
    const toks = seg.tokens;
    const writes = seg.cmds.some((c) => WRITE_CMDS.has(c.name) || (c.name === "sed" && c.args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))));
    for (let i = 0; i < toks.length; i++) {
      if (!writes && toks[i - 1] !== ">" && toks[i - 1] !== ">>") continue;
      const t = toks[i]!;
      const abs = absPath(t.startsWith("of=") ? t.slice(3) : t, ctx);
      // A glob that can expand to the config or its folder counts (`~/.k*/config.json`).
      const hit = /[*?[]/.test(abs) ? dotGlobMatch(abs, target) || dotGlobMatch(abs, dir) : abs === target || abs === dir;
      if (hit) return true;
    }
  }
  return false;
}

function* shellHits(sh: Shell, ctx: GuardContext, cfg: GuardConfig): Generator<GuardHit> {
  // Always on, no switch and no allowlist: the config cannot be used to relax itself.
  if (shellWritesGuardConfig(sh, ctx)) yield { rule: "guard-config-write", code: "NEVER_SHELL" };
  if (cfg.shellNeverList) {
    for (const [rule, m] of SHELL_MATCHERS) {
      const t = m(sh, ctx);
      if (t === undefined) continue;
      const targets = typeof t === "string" ? [t] : t;
      for (const target of targets) yield { rule, code: "NEVER_SHELL", ...(target ? { target } : {}) };
    }
  }
  if (cfg.secretsGuard) {
    for (const r of secretReadHits(sh, ctx)) yield { rule: r.rule, code: "NEVER_SECRET_READ", target: r.target };
    const kind = shellSecretWrite(sh);
    if (kind) yield { rule: `secret-write-${kind}`, code: "NEVER_SECRET_WRITE" };
  }
  if (cfg.exfilGuard) {
    const tool = exfilHit(sh, ctx);
    if (tool) yield { rule: `exfil-${tool}`, code: "NEVER_EXFIL" };
  }
}

/**
 * First guard-pack hit for this tool call that `guardAllow` does not skip, or undefined (allow).
 * Shell tools: the command. Tools that read: the path. Tools that write: the written text.
 * Never throws.
 */
export function guardPackMatch(
  toolId: string,
  toolInput: unknown,
  ctx: GuardContext,
  cfg: GuardConfig = GUARD_DEFAULTS,
): GuardHit | undefined {
  try {
    const f = fieldsOf(toolInput);
    if (!f) return NO;
    if (isShellTool(toolId)) {
      for (const cmd of commandStrings(f)) {
        const sh = parseShell(cmd, ctx.home);
        for (const hit of shellHits(sh, ctx, cfg)) if (!allowed(hit, cfg, ctx, cmd)) return hit;
      }
    }
    const path = typeof f.file_path === "string" ? f.file_path : typeof f.path === "string" ? f.path : undefined;
    const gcp = guardConfigPath(ctx);
    if (gcp && isWriteLike(toolId)) {
      // Every path field, and the symlink-resolved path when the file exists.
      for (const p of pathStrings(f, toolId)) {
        const abs = absPath(p, ctx);
        let real = abs;
        try { real = realpathSync(abs); } catch { /* not there yet */ }
        if (abs === gcp || real === gcp) return { rule: "guard-config-write", code: "NEVER_SHELL", target: gcp };
      }
    }
    if (!cfg.secretsGuard) return NO;
    if (isWriteLike(toolId)) {
      for (const text of writtenStrings(f)) {
        const kind = secretShape(text);
        if (!kind) continue;
        const hit: GuardHit = { rule: `secret-write-${kind}`, code: "NEVER_SECRET_WRITE", ...(path ? { target: absPath(path, ctx) } : {}) };
        if (!allowed(hit, cfg, ctx, undefined)) return hit;
      }
    } else {
      for (const p of pathStrings(f, toolId)) {
        const abs = absPath(p, ctx);
        const kind = secretKind(abs, ctx.home);
        if (!kind) continue;
        const hit: GuardHit = { rule: `secret-read-${kind}`, code: "NEVER_SECRET_READ", target: abs };
        if (!allowed(hit, cfg, ctx, undefined)) return hit;
      }
    }
  } catch {
    // Fail open: a parse problem never adds a deny.
  }
  return NO;
}

/**
 * Rule id of the first shell-family rule that matches a command, or null. Shell rules only
 * (no secrets, no allowlist), so a caller can ask the one question the spec names.
 */
export function matchesShellNeverList(command: string, ctx: { cwd: string; home: string; projectRoot: string }): string | null {
  try {
    const sh = parseShell(command, ctx.home);
    for (const hit of shellHits(sh, ctx, { ...GUARD_DEFAULTS, secretsGuard: false, exfilGuard: false })) return hit.rule;
  } catch { /* fail open */ }
  return null;
}

const HINTS: Readonly<Record<string, string>> = {
  "rm-root-home": "Delete the specific project folder instead, with an exact path.",
  "terraform-destroy": "Run terraform plan -destroy and ask the user to run the destroy themselves.",
  "sql-drop": "Do not drop or truncate through the agent. Ask the user to run it, after a backup.",
  "git-force-push": "Use git push --force-with-lease, or ask the user to force push.",
  "git-delete-default-branch": "Never delete main or master through the agent. Ask the user.",
  "git-hard-reset-clean": "git reset --hard with git clean -fdx wipes uncommitted work. Ask the user, or stash first.",
  "docker-volumes": "Volumes hold data. List them with docker volume ls and ask the user to remove one.",
  "k8s-delete-ns": "Deleting a namespace or everything in all namespaces needs the user to run it.",
  "cloud-delete": "Cloud deletes are not reversible. Ask the user to run this.",
  "railway-volume-delete": "Volume deletes are not reversible. Ask the user to run this.",
  "guard-config-write": "Do not edit the KYA guard settings. Ask the user.",
};

/** Actionable text for a deny, from the rule id alone (no command text, no matched secret). */
export function guardHint(rule: string): string {
  const fixed = HINTS[rule];
  if (fixed) return fixed;
  if (rule.startsWith("secret-read-")) return "Do not read credential files. Ask the user for the specific value you need.";
  if (rule.startsWith("secret-write-")) return "Do not write secrets into files. Read the value from an environment variable instead.";
  if (rule.startsWith("exfil-")) return "Do not send environment variables or credential files over the network.";
  return "";
}
