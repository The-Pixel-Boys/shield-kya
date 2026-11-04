/**
 * Never-list rules on tool INPUT: shell command text and file paths.
 * matchesNeverList (offline-evaluate.ts) sees the tool name only, so a shell
 * tool was never blocked on its command. This file adds the input rules.
 *
 * One table (NEVER_LIST_INPUT_RULES) drives every caller: the offline evaluator,
 * the hook's normal path, its error fallback and the hosted hook. They cannot drift.
 *
 * A seatbelt, not a sandbox. Matching is a linear quote-aware scanner, not a full
 * shell parser. Fails open: unknown shapes and parse trouble are not matches.
 * Work is linear in the input size, with bounded nesting.
 */
import { homedir } from "node:os";
import { findHostToolTier } from "./host-tools.js";
import { mcpToolTier, parseMcpToolId } from "./mcp-servers.js";

/**
 * A field longer than this is scanned as two windows: its first and its last
 * MAX_SCAN_CHARS. Text in the middle of a longer field is not scanned (documented limit).
 */
export const MAX_SCAN_CHARS = 65536;
/** A JSON string tool input is parsed up to this size. Larger strings fail open. */
const MAX_JSON_CHARS = 1 << 20;
/** Nesting limit for substitutions, quoted code and heredoc bodies. */
const MAX_DEPTH = 4;

/** Tokens of one command, before variables are substituted. */
interface RawSeg {
  tokens: string[];
  /** True when a single `|` joins this segment to the one before it. */
  pipeIn: boolean;
}

export interface Segment {
  readonly tokens: readonly string[];
  readonly pipeIn: boolean;
  /** Candidate command words, in order. The last one is the real command (shells skipped). */
  readonly cmds: readonly Cmd[];
  /** The same candidates with shells kept (for pipes and `bash -c`), computed on first use. */
  kept?: readonly Cmd[];
}

/** Candidates with shells kept, computed once per segment. */
function keptCmds(seg: Segment): readonly Cmd[] {
  return (seg.kept ??= commandsAt(seg.tokens, true));
}

export interface Shell {
  readonly raw: string;
  readonly segments: readonly Segment[];
  readonly home: string | undefined;
  /** Absolute working directory of the call, when the host gave one (relative deletes above it are denied). */
  readonly cwd?: string;
}

/** A command word and the tokens after it. Copied once, when the segment is built. */
export class Cmd {
  private cached: readonly string[] | undefined;
  /** `raw` is the word as written (a download substitution is checked on it). */
  /** `coprocName` is true for the NAME of `coproc NAME { ... }`: it never runs, so the persistence rules skip it. */
  constructor(readonly name: string, readonly raw: string, private readonly tokens: readonly string[], private readonly start: number, readonly coprocName = false) {}
  /** Arguments, copied on first use: most candidate words are never asked for them. */
  get args(): readonly string[] {
    return (this.cached ??= this.tokens.slice(this.start));
  }
}

export interface NeverListInputRule {
  /** Stable id. Shown in the deny reason and listed in docs/guides/kya-never-list.md. */
  readonly id: string;
  /** Group a to e are the owner's list. f to h were added 2026-10-30 (persistence, tunnels, exfiltration). */
  readonly group: "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
  /** Checks a shell command. Only shell-like tools reach it. */
  readonly shell?: (sh: Shell) => boolean;
  /** Checks a file path. Only tools that are not write-like reach it. */
  readonly file?: (path: string, home: string | undefined) => boolean;
  /** Checks a file path that a write-like tool writes (Write, Edit, apply_patch). Only write-like tools reach it. */
  readonly writeFile?: (path: string, home: string | undefined) => boolean;
  /**
   * Checks the whole shell command text, unwindowed. Used only when the command is longer than MAX_SCAN_CHARS,
   * because the parsed windows miss the middle of a long command.
   */
  readonly fullText?: (text: string) => boolean;
}

// Words that run another command: skip them to find the real command word.
// Shells are skipped too, except where a pipe needs the shell name itself.
const WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "coproc", "nice", "ionice",
  "stdbuf", "xargs", "eval", "busybox", "timeout", "if", "then", "else", "elif", "do", "while", "until", "!",
  "{", "}",
]);
/** Options that take their value in the next word, per wrapper (`sudo -u root`, `nice -n 5`). Other flags take none. */
const VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  timeout: new Set(["-s", "-k"]),
  xargs: new Set(["-I", "-d", "-P", "-L", "-n", "-E", "-s"]),
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Words that run their argument as code. */
const EXEC_WORDS = new Set([...SHELLS, "eval", "source", "."]);
const NET_CLIENTS = new Set(["curl", "wget"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "ruby", "perl", "php", "deno", "bun", "lua"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGN_FULL = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
/** A word that is a download substitution: `$(curl ...)`. */
const NET_SUBST = /^\$\(\s*(curl|wget)\b/;
/** A command word that contains a download substitution anywhere: `/bin/$(curl ...)` runs curl's output. */
const NET_SUBST_WORD = /\$\(\s*(curl|wget)\b/;
/** Option values that name a host or key, not a file to read: `scp -i KEY`, `rsync -e "ssh -i KEY"`. */
const OPTION_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  scp: new Set(["-i", "-F", "-o", "-P", "-S", "-J", "-c", "-l"]),
  sftp: new Set(["-i", "-F", "-o", "-P", "-S", "-J", "-b"]),
  rsync: new Set(["-e", "-M", "--rsh"]),
  ssh: new Set(["-i", "-F", "-o", "-l", "-p", "-J", "-E", "-b", "-c", "-D", "-L", "-R", "-S", "-W", "-w"]),
  // openssl writes its output to these files; they are not inputs.
  openssl: new Set(["-out", "-keyout", "-passout", "-config"]),
  // `-e PATTERN` names the pattern, not a file. `-f FILE` names a real file, so it is not listed.
  grep: new Set(["-e", "--regexp"]),
  egrep: new Set(["-e", "--regexp"]),
  fgrep: new Set(["-e", "--regexp"]),
};

/**
 * The word with each balanced `$(...)` group removed, so a `/` inside a substitution is not a path
 * separator. `ok` is false when the groups or quotes do not close cleanly (`x$(echo ")")`): the name
 * is then not known, and the scan keeps going.
 */
function stripSubst(t: string): { plain: string; ok: boolean } {
  if (!t.includes("$(")) return { plain: t, ok: true };
  let out = "";
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (depth === 0 && t[i] === "$" && t[i + 1] === "(") {
      depth = 1;
      i++;
    } else if (depth > 0) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
    } else {
      out += t[i];
    }
  }
  return { plain: out, ok: depth === 0 && !/[()'"`]/.test(out) };
}

/** The last path part of a command word, with substitutions removed (`/bin$(:)/rm` is `rm`). */
function wordName(t: string): string {
  const plain = stripSubst(t).plain;
  return plain.slice(plain.lastIndexOf("/") + 1);
}

/** `coproc NAME`: the word after `coproc` is a name when it is a plain identifier. */
const COPROC_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Words that make `coproc X` a named compound: `coproc X { ...`, `coproc X for ...`. */
const COPROC_BODY = new Set(["{", "if", "while", "until", "for", "case", "select"]);
/** A coproc NAME is a plain identifier that is not a wrapper, a shell or `function`. */
function isCoprocName(t: string): boolean {
  return COPROC_NAME.test(t) && !WRAPPERS.has(t) && !SHELLS.has(t) && t !== "function";
}

/**
 * Every candidate command word of one command, in order. The first real command word ends
 * the scan. Two constructs add candidates instead of hiding the body:
 * - `function NAME`: the raw word `function` is a candidate and NAME is skipped, so the body
 *   after NAME is scanned too. Repeated `function a function b` is peeled in this one pass.
 * - `coproc NAME`: NAME is a candidate, and the words after it are scanned too.
 * Fails closed: an unknown shape stays a candidate. `echo function` and `git log --grep
 * function` are arguments, not command starts, so they add nothing.
 */
function commandsAt(tokens: readonly string[], keepShells: boolean): Cmd[] {
  const out: Cmd[] = [];
  let wrapper = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (VALUE_OPTS[wrapper]?.has(t)) i++;
      continue;
    }
    if (ASSIGN.test(t) || DURATION.test(t)) continue;
    if (t === "function" && i + 1 < tokens.length) {
      out.push(new Cmd("function", t, tokens, i + 1));
      i++; // NAME is not a command
      continue;
    }
    // `coproc NAME { ...` or `coproc NAME for ...`: NAME is a candidate and the body is scanned too.
    // Otherwise coproc is a wrapper: `coproc sudo -u root rm ...` and `coproc git push ...` run the command.
    if (t === "coproc" && i + 2 < tokens.length && isCoprocName(tokens[i + 1]!) && COPROC_BODY.has(tokens[i + 2]!)) {
      out.push(new Cmd(tokens[i + 1]!, tokens[i + 1]!, tokens, i + 2, true));
      i++; // NAME is a candidate; the words after it are scanned next
      continue;
    }
    const name = wordName(t);
    if (WRAPPERS.has(name)) {
      wrapper = name;
      continue;
    }
    if (!keepShells && SHELLS.has(name)) continue;
    out.push(new Cmd(name, t, tokens, i + 1));
    // A word that starts with an expansion can expand to nothing (`$(:) rm -rf ~`, `$X rm -rf ~`), and a word
    // whose substitution does not strip cleanly has no known name. Both keep scanning: the next word is a candidate too.
    if (name !== "" && !t.startsWith("$") && stripSubst(t).ok) return out;
  }
  return out;
}

/** The real command of a command (its last candidate), or undefined. */
function commandAt(tokens: readonly string[], keepShells: boolean): Cmd | undefined {
  const cs = commandsAt(tokens, keepShells);
  return cs[cs.length - 1];
}

export function hasCommand(sh: Shell, pred: (c: Cmd, sh: Shell) => boolean): boolean {
  // Indexed loops: this runs once per rule per segment, so no iterator objects.
  const segs = sh.segments;
  for (let i = 0; i < segs.length; i++) {
    const cs = segs[i]!.cmds;
    for (let k = 0; k < cs.length; k++) if (pred(cs[k]!, sh)) return true;
  }
  return false;
}

const TOP_LEVEL = /^\/(bin|boot|etc|home|lib|lib64|opt|root|sbin|srv|usr|var|System|Library|Applications|private|Users)(\/\*)?$/;
const ROOT_SET = new Set(["/", "/*", "~", "~/*", "~/.*", "~/."]);
/** Another user's home directory on Linux or macOS, with optional contents glob. */
const USER_HOME = /^\/(home|Users)\/[^/]+(\/\*|\/\.\*)?$/;

/** Expand a leading `~` to the home directory when it is known. */
function expandHome(p: string, home: string | undefined): string {
  if (home && (p === "~" || p.startsWith("~/"))) return home + p.slice(1);
  return p;
}

/** Resolve `.` and `..` in an absolute path. Relative paths are returned as they are. */
function resolveDots(p: string): string {
  if (!p.startsWith("/")) return p;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/**
 * Canonical form for matching. Repeated slashes and `/.` go, `~`, `~user` and
 * `$HOME` are expanded when the home directory is known, and `..` is resolved.
 */
export function normalizePath(w: string, home: string | undefined): string {
  let p = w.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (p === "") p = "/";
  const named = /^~([A-Za-z0-9._-]+)(\/.*)?$/.exec(p);
  if (named) {
    const name = named[1]!;
    const rest = named[2] ?? "";
    const homeName = home ? home.slice(home.lastIndexOf("/") + 1) : undefined;
    const base = name === "root" ? "/root" : home && name === homeName ? home : `/home/${name}`;
    p = base + rest;
  } else {
    p = expandHome(p, home);
  }
  p = resolveDots(p.replace(/\/{2,}/g, "/"));
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * A relative path that, joined to the working directory, is a strict ancestor of it
 * (`..`, `../*`, `../../*`): the delete reaches above the project root. The project root
 * itself (`.`, `./*`, `*`) is not above it. Needs a known absolute cwd, else false.
 */
function aboveCwd(word: string, cwd: string | undefined): boolean {
  if (!cwd || !cwd.startsWith("/") || word.startsWith("/") || word.startsWith("~") || word.includes("$")) return false;
  const root = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  const target = resolveDots(`${root}/${word}`.replace(/\/{2,}/g, "/")).replace(/\/\.?\*$/, "") || "/";
  return target !== root && (target === "/" || root.startsWith(`${target}/`));
}

/** Root, home, home contents, a top-level system directory (with optional `/*`), or a path above the working directory. */
function isProtected(word: string, sh: Shell): boolean {
  const home = sh.home;
  const p = normalizePath(word, home);
  if (ROOT_SET.has(p) || TOP_LEVEL.test(p) || USER_HOME.test(p)) return true;
  if (home !== undefined && (p === home || p === `${home}/*` || p === `${home}/.*`)) return true;
  return aboveCwd(word, sh.cwd);
}

function isRecursive(flags: readonly string[]): boolean {
  return flags.some((f) => f === "--recursive" || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
}

/**
 * find with -delete, or -exec rm, on a protected start path. Filters do not help:
 * `find ~ -type f -delete` deletes under home just the same.
 */
function findDeleteProtected(c: Cmd, sh: Shell): boolean {
  if (c.name !== "find") return false;
  let i = 0;
  while (i < c.args.length && /^-[HLP]$/.test(c.args[i]!)) i++;
  const starts: string[] = [];
  for (; i < c.args.length; i++) {
    const t = c.args[i]!;
    if (t.startsWith("-") || t === "!" || t === "(") break;
    starts.push(t);
  }
  if (!starts.some((p) => isProtected(p, sh))) return false;
  if (c.args.includes("-delete")) return true;
  const exec = c.args.some((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
  return exec && c.args.includes("rm");
}

function rmRecursiveProtected(c: Cmd, sh: Shell): boolean {
  if (c.name !== "rm") return false;
  const flags = c.args.filter((t) => t.startsWith("-"));
  const paths = c.args.filter((t) => !t.startsWith("-"));
  return isRecursive(flags) && paths.some((p) => isProtected(p, sh));
}

function chmodChownRecursiveProtected(c: Cmd, sh: Shell): boolean {
  if (c.name !== "chmod" && c.name !== "chown") return false;
  const flags = c.args.filter((t) => t.startsWith("-"));
  const rest = c.args.filter((t) => !t.startsWith("-"));
  if (!isRecursive(flags)) return false;
  if (c.name === "chmod" && !rest.some((t) => /^0?777$/.test(t))) return false;
  return rest.some((p) => isProtected(p, sh));
}

const PROTECTED_BRANCH = (b: string): boolean => {
  const n = b.toLowerCase();
  return n === "main" || n === "master" || n.startsWith("release") || n.startsWith("prod");
};

/** Index of the git subcommand: global options are skipped, and `-C` and `-c` take a value. */
/** Git global options that take their value in the next word (`git -C dir`, `git --git-dir .git`). */
const GIT_GLOBAL_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--shallow-file",
]);
/** Git global options that take no value. Any other option before the subcommand is unknown. */
const GIT_GLOBAL_FLAG = new Set([
  "-p", "-P", "--paginate", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--version", "--help",
  "--html-path", "--man-path", "--info-path",
]);
/**
 * The subcommand index, and whether every option before it is known. An unknown option makes
 * `known` false, so no later word is exempted by the subcommand (fail closed).
 */
export function gitSubInfo(a: readonly string[]): { idx: number; known: boolean } {
  let i = 0;
  let known = true;
  while (i < a.length && a[i]!.startsWith("-")) {
    const t = a[i]!;
    if (GIT_GLOBAL_VALUE.has(t)) {
      i += 2;
      continue;
    }
    const name = t.split("=")[0]!;
    const attached = t.includes("=") && (GIT_GLOBAL_VALUE.has(name) || name === "--exec-path");
    if (!GIT_GLOBAL_FLAG.has(t) && !attached) known = false;
    i += 1;
  }
  return { idx: i, known };
}
function gitSubIndex(a: readonly string[]): number {
  return gitSubInfo(a).idx;
}

/**
 * Force push (flag or `+` refspec) whose destination is a protected branch. Covers
 * `-fu` bundles, `--force-with-lease`, `HEAD:main` and `refs/heads/main`. HEAD-based
 * pushes (no refspec) are not seen, and neither are git aliases.
 */
function gitForcePushProtected(c: Cmd): boolean {
  if (c.name !== "git") return false;
  const a = c.args;
  const i = gitSubIndex(a);
  if (a[i] !== "push") return false;
  const rest = a.slice(i + 1);
  const force = rest.some((t) => /^--force(-with-lease|-if-includes)?(=|$)/.test(t) || /^-[A-Za-z]*f/.test(t));
  const refspecs = rest.filter((t) => !t.startsWith("-")).slice(1);
  return refspecs.some((r) => {
    const plus = r.startsWith("+");
    if (!force && !plus) return false;
    const body = plus ? r.slice(1) : r;
    const dst = (body.includes(":") ? body.slice(body.lastIndexOf(":") + 1) : body).replace(/^refs\/heads\//, "");
    return dst !== "" && PROTECTED_BRANCH(dst);
  });
}

/** A `.env` name that ends in one of these is a template, not a secret (`.env.local.example`). Only the last suffix counts. */
const ENV_TEMPLATE = /\.(example|sample|template)$/;
const HOME_CREDENTIAL = /^(~|\/Users\/[^/]+|\/home\/[^/]+|\/root)\/\.(npmrc|netrc|git-credentials)$/;
const GCLOUD_CREDENTIAL = /(^|\/)\.config\/gcloud\/(application_default_credentials\.json|credentials\.db|access_tokens\.db|legacy_credentials(\/|$))/;
const BLOCK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|md|dm-|loop|mapper\/)/;

const GLOB_CHARS = /[*?[]/;
/** Secret names that a glob segment is tested against (fixed, short targets). */
const GLOB_ENV_NAMES = [".env", ".env.local"];
const GLOB_HOME_NAMES = [".npmrc", ".netrc", ".git-credentials"];
/** A directory that is a home directory: `~`, `/root`, `/home/<u>` or `/Users/<u>`. */
const HOME_DIR = /^(~|\/Users\/[^/]+|\/home\/[^/]+|\/root)$/;

interface GlobTok {
  readonly kind: "lit" | "any" | "star";
  readonly ch?: string;
  readonly test?: (c: string) => boolean;
}

/** Tokens of one glob segment. Linear: a `[` with no closing `]` is a literal, and a class is read once. */
function globTokens(pat: string): GlobTok[] {
  const out: GlobTok[] = [];
  const lastClose = pat.lastIndexOf("]");
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (out[out.length - 1]?.kind !== "star") out.push({ kind: "star" });
    } else if (c === "?") {
      out.push({ kind: "any", test: () => true });
    } else if (c === "[" && i < lastClose) {
      let j = i + 1;
      const neg = pat[j] === "!" || pat[j] === "^";
      if (neg) j++;
      const singles = new Set<string>();
      const ranges: [string, string][] = [];
      let end = -1;
      for (let p = j; p < pat.length; p++) {
        if (pat[p] === "]" && p > j) {
          end = p;
          break;
        }
        if (pat[p + 1] === "-" && p + 2 < pat.length && pat[p + 2] !== "]") {
          ranges.push([pat[p]!, pat[p + 2]!]);
          p += 2;
        } else {
          singles.add(pat[p]!);
        }
      }
      if (end < 0) {
        out.push({ kind: "lit", ch: "[" });
        continue;
      }
      out.push({ kind: "any", test: (ch) => (singles.has(ch) || ranges.some(([a, b]) => ch >= a && ch <= b)) !== neg });
      i = end;
    } else {
      out.push({ kind: "lit", ch: c });
    }
  }
  return out;
}

/**
 * Does a shell glob segment match a fixed name? Shell rule: a name that starts with a dot is
 * matched only by a pattern that starts with a literal dot, so `cat *.env` and `cat *` do not
 * reach `.env` (checked with bash and zsh). Cost is pattern length times name length.
 */
function globSegMatch(pat: string, name: string): boolean {
  if (!GLOB_CHARS.test(pat)) return pat === name;
  const toks = globTokens(pat);
  if (name[0] === "." && !(toks[0]?.kind === "lit" && toks[0].ch === ".")) return false;
  const n = name.length;
  let reach: boolean[] = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  for (const t of toks) {
    const next: boolean[] = new Array<boolean>(n + 1).fill(false);
    if (t.kind === "star") {
      for (let j = 0; j <= n; j++) next[j] = reach[j]! || (j > 0 && next[j - 1]!);
    } else {
      for (let j = 0; j < n; j++) {
        if (!reach[j]) continue;
        if (t.kind === "lit" ? name[j] === t.ch : t.test!(name[j]!)) next[j + 1] = true;
      }
    }
    reach = next;
  }
  return reach[n]!;
}

/**
 * Glob forms of the secret rules, for a path that has a glob. A segment counts when it could
 * match a secret name: `.e[n]v`, `.en?`, `.e?v.local` (`.env`, `.env.local`), `~/.n?mrc` (home credentials),
 * `~/.s?h/id_rsa` and `.a?s/credentials` (key or credentials under a credential directory), and any glob
 * name under `.ssh` or `.aws`, as the literal rule does for `~/.ssh/*`.
 */
function globSecret(p: string): boolean {
  const cut = p.lastIndexOf("/");
  const dir = cut < 0 ? "" : p.slice(0, cut);
  const base = p.slice(cut + 1);
  const dirName = dir.slice(dir.lastIndexOf("/") + 1);
  if (GLOB_ENV_NAMES.some((name) => globSegMatch(base, name))) return true;
  if (HOME_DIR.test(dir) && GLOB_HOME_NAMES.some((name) => globSegMatch(base, name))) return true;
  const ssh = globSegMatch(dirName, ".ssh");
  if (!ssh && !globSegMatch(dirName, ".aws")) return false;
  if (GLOB_CHARS.test(base)) return true;
  return ssh ? base.startsWith("id_") && !base.endsWith(".pub") : base === "credentials";
}

/** Private key, cloud or package credential, or a real `.env` file (templates are not secret). Globs that could match one count too. */
export function isSecretPath(raw: string, home: string | undefined): boolean {
  const p = normalizePath(raw, home);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/(^|\/)\.ssh\/id_/.test(p) && !base.endsWith(".pub")) return true;
  if (/(^|\/)\.(ssh|aws)\/[^/]*[*?[]/.test(p)) return true;
  if (/(^|\/)\.aws\/credentials$/.test(p)) return true;
  if (GCLOUD_CREDENTIAL.test(p)) return true;
  if (HOME_CREDENTIAL.test(p)) return true;
  if (base === ".env" || (base.startsWith(".env.") && !ENV_TEMPLATE.test(base))) return true;
  if (base.startsWith(".env") && /[*?[]/.test(base)) return true;
  if (GLOB_CHARS.test(p) && globSecret(p)) return true;
  return /\.(pem|key)$/.test(base);
}

/**
 * Options whose separate value is text (a message, a grep pattern, an author), not a path. A short
 * cluster that ends in m, S or G (`-m`, `-am`, `-S`) takes the next word too. Attached forms
 * (`--message=x`, `-mx`) are one option word, so they are skipped by the option check.
 */
const GIT_TEXT_CLUSTER = /^-[A-Za-z]*[mSG]$/;
/** Subcommands whose `-m`/`--message` takes text. In `git log`, `-m` is a flag, so its next word is checked. */
const MESSAGE_CMDS = new Set(["commit", "tag", "merge", "revert", "notes", "stash", "am", "cherry-pick"]);
/** Subcommands whose `-S`, `-G`, `--grep` and `--author` take a search pattern. */
const SEARCH_CMDS = new Set(["log", "whatchanged", "show", "shortlog", "rev-list", "reflog"]);
function takesText(sub: string, t: string): boolean {
  if (MESSAGE_CMDS.has(sub) && (t === "--message" || (GIT_TEXT_CLUSTER.test(t) && t.endsWith("m")))) return true;
  return SEARCH_CMDS.has(sub) && (t === "--grep" || t === "--author" || (GIT_TEXT_CLUSTER.test(t) && /[SG]$/.test(t)));
}
/** Git config from the environment that defines an alias (`GIT_CONFIG_KEY_0=alias.x`, `GIT_CONFIG_PARAMETERS=...`). */
const GIT_ENV_ALIAS = /^(GIT_CONFIG_KEY_\d+=alias\.|GIT_CONFIG_PARAMETERS=.*alias\.)/i;
/** The part after any colon of a word leaves a secret path: `HEAD:.env`, `:0:.env`, `HEAD@{1}:.env`. */
function colonPathSecret(t: string, home: string | undefined): boolean {
  for (let k = t.indexOf(":"); k >= 0; k = t.indexOf(":", k + 1)) {
    if (k + 1 < t.length && isSecretPath(t.slice(k + 1), home)) return true;
  }
  return false;
}
/**
 * Any git command, any subcommand (so unknown subcommands and `whatchanged` count as possible reads).
 * A word shaped like REF:PATH, or `-L<range>:<path>`, is checked by its colon parts. A text option
 * skips its value. `-F FILE` is a file, so it is checked as one. `-c alias.*` is denied: an alias can run
 * any command, and its text is not checked.
 */
function gitReadsSecret(c: Cmd, home: string | undefined): boolean {
  const a = c.args;
  const { idx, known } = gitSubInfo(a);
  const sub = a[idx] ?? "";
  for (let i = 0; i < a.length; i++) {
    const t = a[i]!;
    // Free text (message, search pattern, author) is skipped, and only then. Unknown options disable it.
    if (known && takesText(sub, t)) {
      i++;
      continue;
    }
    // `-F FILE` is a file: its value is checked as a file, and the value is still visited as a word.
    if (t === "-F" || t === "--file") {
      if (i + 1 < a.length && isSecretPath(a[i + 1]!, home)) return true;
      continue;
    }
    // An alias can run any command. The key is compared without case.
    if ((t === "-c" || t === "--config-env") && i + 1 < a.length && /^alias\./i.test(a[i + 1]!)) return true;
    if (/^--config-env=alias\./i.test(t)) return true;
    if (t.startsWith("-")) {
      if (t.startsWith("-L") && colonPathSecret(t, home)) return true;
      continue;
    }
    if (colonPathSecret(t, home)) return true;
  }
  return false;
}

/** A whole credential directory. Only shell copy or read verbs check it: listing it is not a read of a key. */
function isSecretDir(raw: string, home: string | undefined): boolean {
  return /(^|\/)\.(ssh|aws)$/.test(normalizePath(raw, home));
}

/** Verbs that read a file. Copy verbs check the sources only (the last argument is the destination). */
const READ_VERBS = new Set([
  "cat", "less", "more", "head", "tail", "cp", "scp", "rsync", "base64", "xxd", "od", "hexdump",
  "strings", "nl", "tac", "bat", "sed", "awk", "grep", "egrep", "cut", "sort", "tar", "zip", "gzip",
  "xz", "openssl", "curl", "wget", "nc", "ncat", "dd", "install", "diff", "cmp", "wc", "file", "jq",
  "yq", "column", "md5sum", "shasum", "sha256sum",
]);
const COPY_VERBS = new Set(["cp", "scp", "rsync", "install"]);
/** Shell redirection operators, as tokens. */
const REDIRECT_OPS = new Set(["<", "<<", "<<<", ">", ">>"]);
/** Verbs whose first operand is a pattern, not a file. */
const PATTERN_VERBS = new Set(["grep", "egrep", "fgrep"]);

/**
 * Code that reads a file by name, as a call: `open('.env')`, `readFileSync(".env")`, Ruby `File.read('.env')`,
 * PHP `file_get_contents('.env')`. Only the first quoted or bare name after the `(` counts.
 */
const READ_CALL = /\b(open|Path|readFileSync|readFile|read_text|read_bytes|File\.read|IO\.read|file_get_contents|fopen|readfile)\s*\(\s*(['"`]?)([^'"`)\s,]+)/g;

/** One pass over a shell's segments: redirects, read verbs and git object reads. */
function secretReadShell(sh: Shell): boolean {
  for (const seg of sh.segments) {
    const toks = seg.tokens;
    for (let i = 0; i + 1 < toks.length; i++) {
      if (toks[i] === "<" && isSecretPath(toks[i + 1]!, sh.home)) return true;
    }
    for (let k = 0; k < seg.cmds.length; k++) {
      const c = seg.cmds[k]!;
      if (c.name === "git") {
        if (gitReadsSecret(c, sh.home) || seg.tokens.some((t) => GIT_ENV_ALIAS.test(t))) return true;
        continue;
      }
      if (!READ_VERBS.has(c.name)) continue;
      const args = COPY_VERBS.has(c.name) ? c.args.slice(0, -1) : c.args;
      const valueOpts = OPTION_VALUES[c.name];
      // grep: the first operand is the pattern, unless -e or -f names the patterns.
      const namesPatterns = c.args.some((a) => /^-[A-Za-z]*[ef]/.test(a) || /^--(regexp|file)/.test(a));
      const patternIdx = PATTERN_VERBS.has(c.name) && !namesPatterns ? args.findIndex((a) => !a.startsWith("-")) : -1;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (i === patternIdx) continue;
        // Redirections are not operands: `> file` writes to file, and `<<` only starts a heredoc.
        if (REDIRECT_OPS.has(a)) {
          if (a === ">" || a === ">>") i++;
          continue;
        }
        // A value of an option is a host, key or command, not a file read: skip it by advancing the index.
        if (valueOpts?.has(a)) {
          i++;
          continue;
        }
        const prev = args[i - 1];
        if (c.name === "dd") {
          if (a.startsWith("if=") && isSecretPath(a.slice(3), sh.home)) return true;
        } else if (NET_CLIENTS.has(c.name)) {
          // Upload forms only: `-d @file`, `-F f=@file`, `-T file`, `--upload-file file`. Never `-o file`.
          const at = a.indexOf("@");
          if (at >= 0 && isSecretPath(a.slice(at + 1), sh.home)) return true;
          if ((prev === "-T" || prev === "--upload-file") && isSecretPath(a, sh.home)) return true;
        } else if (!a.startsWith("-") && (isSecretPath(a, sh.home) || isSecretDir(a, sh.home))) {
          // Options such as `--include=*.pem` are not file operands.
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Any command in a shell command that runs an interpreter, and a READ_CALL that names a secret
 * file anywhere in the raw text. The scan is over the whole command, not only the interpreter's
 * code: `python3 x.py; echo "open('.env')"` is denied.
 */
function interpreterReadsSecret(sh: Shell): boolean {
  if (!sh.segments.some((s) => s.cmds.some((c) => INTERPRETERS.has(c.name)))) return false;
  for (const m of sh.raw.matchAll(READ_CALL)) {
    if (isSecretPath(m[3]!, sh.home)) return true;
  }
  return false;
}

/** Does this stage download? A network client, or a shell whose `-c` code starts with one. */
function netStage(c: Cmd): boolean {
  if (NET_CLIENTS.has(c.name)) return true;
  if (!SHELLS.has(c.name)) return false;
  const i = c.args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  if (i < 0) return false;
  const inner = commandAt(c.args.slice(i + 1), true);
  return inner !== undefined && NET_CLIENTS.has(inner.name);
}

/** A network client's output piped (directly or through more pipes) into a shell. */
function pipeNetworkToShell(sh: Shell): boolean {
  let fetched = false;
  for (const seg of sh.segments) {
    if (!seg.pipeIn) fetched = false;
    // Cheap pre-check (necessary condition): a download needs a curl or wget word in this segment,
    // and a shell after a download needs fetched. Skips the candidate pass for the rest.
    if (!fetched && !seg.tokens.some((t) => t.includes("curl") || t.includes("wget") || t.includes("$("))) continue;
    const kept = keptCmds(seg);
    for (let k = 0; k < kept.length; k++) {
      const c = kept[k]!;
      if (fetched && SHELLS.has(c.name)) return true;
      if (netStage(c)) fetched = true;
    }
    // A download substitution in this segment (`echo $(curl ...)`, `cat <(curl ...)`, a backtick) is the
    // output that the next stage of a pipe reads. It is set after this segment's own commands, so
    // `bash -c "echo $(curl ...)"` (the download is only an argument) is not a pipe into a shell.
    if (seg.tokens.some((t) => NET_SUBST_WORD.test(t))) fetched = true;
  }
  return false;
}

/**
 * A download run as code: `sh -c "$(curl ...)"`, `bash <(curl ...)`, `source <(...)`,
 * `eval "$(curl ...)"`. Only the command word decides. A download used as a plain
 * argument (`docker build --build-arg V=$(curl ...)`, `cp $(curl ...) .`) does not match.
 */
function nestedNetExec(sh: Shell): boolean {
  for (let i = 0; i < sh.segments.length; i++) {
    const seg = sh.segments[i]!;
    // Necessary condition: a download substitution is a word that starts with `$(`.
    if (!seg.tokens.some((t) => t.includes("$("))) continue;
    const kept = keptCmds(seg);
    for (let k = 0; k < kept.length; k++) {
      const c = kept[k]!;
      if (NET_SUBST_WORD.test(c.raw)) return true;
      if (EXEC_WORDS.has(c.name) && c.args.some((a) => NET_SUBST.test(a))) return true;
    }
  }
  return false;
}

// Fork bomb: `:(){ :|:& };:` or any one-word name. The name is bounded so the scan stays linear.
const FORK_BOMB = /(^|[\s;&|(){}])(:|[A-Za-z_][\w.-]{0,63})\s*\(\s*\)\s*\{\s*\2\s*\|\s*\2\s*&/;
// ksh and bash `function NAME { NAME|NAME& }`, with or without the `()`.
const FORK_BOMB_FUNCTION = /(^|[\s;&|(){}])function\s+([A-Za-z_][\w.-]{0,63})\s*(?:\(\s*\)\s*)?\{\s*\2\s*\|\s*\2\s*&/;

/**
 * Tested on the whole text and on each token: quoted code given to `bash -c`, `sh -c`,
 * `eval` or `sudo bash -c` is one token, and the quote in front of it is not a boundary
 * for the raw text.
 */
function forkBomb(sh: Shell): boolean {
  const bomb = (t: string): boolean => FORK_BOMB.test(t) || FORK_BOMB_FUNCTION.test(t);
  return bomb(sh.raw) || sh.segments.some((seg) => seg.tokens.some((t) => t.includes("|") && bomb(t)));
}
const ANSI_ESC: Readonly<Record<string, string>> = {
  n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/** Decode the escapes of a `$'...'` word: `\xHH`, octal, and the simple C escapes. */
function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    if (e.length > 1 && e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ANSI_ESC[e] ?? e;
  });
}

/** Is this command word a shell or interpreter (for heredoc bodies)? */
function isCodeCommand(toks: readonly string[]): boolean {
  return commandsAt(toks, true).some((k) => SHELLS.has(k.name) || INTERPRETERS.has(k.name));
}

/** Index of the `)` that closes a `$(` whose text starts at `start`. Quoted text, escapes and comments do not count. */
function closeParen(text: string, start: number): number {
  const n = text.length;
  let level = 1;
  let j = start;
  while (j < n) {
    const ch = text[j]!;
    if (ch === "\\") j += 2;
    else if (ch === "'") {
      const e = text.indexOf("'", j + 1);
      j = e < 0 ? j + 1 : e + 1;
    } else if (ch === '"') j = skipDouble(text, j);
    else if (ch === "#" && (j === start || /\s/.test(text[j - 1]!))) {
      const e = text.indexOf("\n", j);
      j = e < 0 ? n : e;
    } else if (ch === "(") {
      level++;
      j++;
    } else if (ch === ")") {
      level--;
      if (level === 0) return j;
      j++;
    } else j++;
  }
  return n;
}

/** Index of the backtick that closes a backtick substitution starting at `start`. Quoted text does not count. */
function closeBacktick(text: string, start: number): number {
  const n = text.length;
  let j = start;
  while (j < n && text[j] !== "`") {
    const ch = text[j]!;
    if (ch === "\\") j += 2;
    else if (ch === "'") {
      const e = text.indexOf("'", j + 1);
      j = e < 0 ? j + 1 : e + 1;
    } else if (ch === '"') j = skipDouble(text, j);
    else j++;
  }
  return j;
}

/** Index after the closing quote of a double-quoted word that opens at `j`. An unterminated quote is a literal character. */
function skipDouble(text: string, j: number): number {
  let k = j + 1;
  while (k < text.length && text[k] !== '"') k += text[k] === "\\" ? 2 : 1;
  return k < text.length ? k + 1 : j + 1;
}

/**
 * Splits shell text into command segments. Quotes group words, so separators inside
 * quotes are text. `$(...)`, `<(...)`, `>(...)` and backticks become one word whose text
 * is `$(inner)`; the inner text is scanned as commands too. A heredoc body is text,
 * unless it is fed to a shell or interpreter (or piped into one), then it is code.
 */
function scanInto(text: string, out: RawSeg[], depth: number): void {
  const n = text.length;
  let i = 0;
  let tokens: string[] = [];
  let word = "";
  let inWord = false;
  let pipeIn = false;
  const pending: { delim: string; strip: boolean; code: boolean }[] = [];
  // Heredoc pipe check: the end of the current line, and whether that line pipes into a shell. Cached per line.
  let nextNl = -1;
  let pipeLine = -1;
  let pipeHere = false;

  const endWord = (): void => {
    if (inWord) {
      tokens.push(word);
      word = "";
      inWord = false;
    }
  };
  const endSeg = (nextPipe: boolean): void => {
    endWord();
    if (tokens.length > 0) out.push({ tokens, pipeIn });
    tokens = [];
    pipeIn = nextPipe;
  };
  // Adds a substitution to the word. `at` is the `$`, `<`, `>` or backtick. Returns the index after it.
  const subst = (at: number): number => {
    let end: number;
    let inner: string;
    if (text[at] === "`") {
      const close = Math.min(closeBacktick(text, at + 1), n);
      inner = text.slice(at + 1, close);
      end = close + 1;
    } else {
      const start = at + 2; // at+1 is the "("
      const close = Math.min(closeParen(text, start), n);
      inner = text.slice(start, close);
      end = close + 1;
    }
    word += `$(${inner})`;
    inWord = true;
    if (depth < MAX_DEPTH) scanInto(inner, out, depth + 1);
    return end;
  };
  // Reads the heredoc bodies that start after the current newline.
  const consumeHeredocs = (): void => {
    for (const h of pending) {
      let body = "";
      while (i < n) {
        let e = text.indexOf("\n", i);
        if (e < 0) e = n;
        const line = text.slice(i, e);
        i = e + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        body += line + "\n";
      }
      if (h.code && depth < MAX_DEPTH) scanInto(body, out, depth + 1);
    }
    pending.length = 0;
  };

  while (i < n) {
    const c = text[i]!;
    if (c === "'") {
      const e = text.indexOf("'", i + 1);
      if (e < 0) {
        // Unterminated quote: a literal character, so the text after it is still scanned.
        word += c;
        inWord = true;
        i++;
      } else {
        word += text.slice(i + 1, e);
        inWord = true;
        i = e + 1;
      }
    } else if (c === '"' && skipDouble(text, i) === i + 1) {
      word += c;
      inWord = true;
      i++;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        const d = text[j]!;
        if (d === "\\" && j + 1 < n) {
          // Backslash-newline is a line continuation: nothing is added.
          if (text[j + 1] !== "\n") word += text[j + 1];
          j += 2;
        } else if ((d === "$" && text[j + 1] === "(") || d === "`") {
          j = subst(j);
        } else {
          word += d;
          j++;
        }
      }
      i = j + 1;
    } else if (c === "#" && !inWord) {
      // A comment starts at the beginning of a word and runs to the end of the line.
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
    } else if (c === "$" && text[i + 1] === "'" && text.indexOf("'", i + 2) >= 0) {
      // $'...': the decoded text is part of this word. Its characters never act as quotes or separators.
      let j = i + 2;
      let body = "";
      while (j < n && text[j] !== "'") {
        if (text[j] === "\\" && j + 1 < n) {
          body += text[j]! + text[j + 1]!;
          j += 2;
        } else {
          body += text[j];
          j++;
        }
      }
      word += decodeAnsiC(body);
      inWord = true;
      i = j + 1;
    } else if (c === "\\" && text[i + 1] === "\n") {
      // Line continuation: the word goes on after it (`rm -rf \<LF>~` is `rm -rf ~`).
      i += 2;
    } else if (c === "\\") {
      if (i + 1 < n) word += text[i + 1];
      inWord = true;
      i += 2;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "\n") {
      endSeg(false);
      i++;
      if (pending.length > 0) consumeHeredocs();
    } else if (c === "&" && text[i - 1] === "|") {
      i++; // `|&`: the pipe was already recorded
    } else if (c === ";" || c === "&" || c === "|") {
      let step = 1;
      let pipe = false;
      if (text[i + 1] === c) step = 2; // && and ||
      else if (c === "|") pipe = true;
      endSeg(pipe);
      i += step;
    } else if (c === "(" || c === ")") {
      endSeg(false);
      i++;
    } else if (c === "`" || (c === "$" && text[i + 1] === "(")) {
      inWord = true;
      i = subst(i);
    } else if ((c === "<" || c === ">") && text[i + 1] === "(") {
      inWord = true;
      i = subst(i);
    } else if (c === "<" && text[i + 1] === "<") {
      endWord();
      if (text[i + 2] === "<") {
        tokens.push("<<<");
        i += 3;
      } else {
        if (nextNl < i) {
          const e = text.indexOf("\n", i);
          nextNl = e < 0 ? n : e;
        }
        if (pipeLine !== nextNl) {
          pipeLine = nextNl;
          pipeHere = /\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh)\b/.test(text.slice(i, nextNl));
        }
        const code = isCodeCommand(tokens) || pipeHere;
        // A heredoc is not an operand: no token is emitted, so many heredocs do not grow the command.
        let j = i + 2;
        const strip = text[j] === "-";
        if (strip) j++;
        while (j < n && (text[j] === " " || text[j] === "\t")) j++;
        let delim = "";
        while (j < n && !/[\s;&|()<>]/.test(text[j]!)) {
          const d = text[j]!;
          if (d === "'" || d === '"') {
            let e = text.indexOf(d, j + 1);
            if (e < 0) e = n;
            delim += text.slice(j + 1, e);
            j = e + 1;
          } else {
            delim += d;
            j++;
          }
        }
        pending.push({ delim, strip, code });
        i = j;
      }
    } else if (c === "<" || c === ">") {
      endWord();
      const dbl = c === ">" && text[i + 1] === ">";
      tokens.push(dbl ? ">>" : c);
      i += dbl ? 2 : 1;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endSeg(false);
}

/**
 * Segments of one piece of shell text: variables substituted, command words found, and
 * quoted code given to a shell, eval or source (`bash -c "rm -rf ~"`) scanned as commands too.
 */
function segmentsOf(text: string, scope: Map<string, string>, depth: number): Segment[] {
  const raw: RawSeg[] = [];
  scanInto(text, raw, depth);
  for (const s of raw) {
    for (const t of s.tokens) {
      const m = ASSIGN_FULL.exec(t);
      if (m) scope.set(m[1]!, m[2]!);
    }
  }
  const sub = (t: string): string => {
    if (!t.includes("$")) return t;
    let out = t.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, "~");
    if (scope.size > 0 && out.includes("$")) {
      out = out.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m: string, a?: string, b?: string) => scope.get((a ?? b)!) ?? m);
    }
    return out;
  };
  const segs: Segment[] = raw.map((s) => {
    const tokens = s.tokens.map(sub);
    return { tokens, pipeIn: s.pipeIn, cmds: commandsAt(tokens, false), kept: undefined };
  });
  if (depth < MAX_DEPTH) {
    const extra: Segment[] = [];
    for (const s of segs) {
      // `eval` and `env` are wrappers, so the command word can be past them: look for the exec word anywhere.
      const e0 = s.tokens.findIndex((t) => EXEC_WORDS.has(wordName(t)));
      if (e0 < 0) continue;
      for (const a of s.tokens.slice(e0 + 1)) {
        if (/[\s;&|()`]/.test(a)) {
          for (const e of segmentsOf(a, scope, depth + 1)) extra.push(e);
        }
      }
    }
    for (const e of extra) segs.push(e);
  }
  return segs;
}

let lastParsed: Shell | undefined;

/** One-entry memo: the never-list rules and the guard pack parse the same command back to back. */
export function parseShell(cmd: string, home: string | undefined, cwd?: string): Shell {
  if (lastParsed && lastParsed.raw === cmd && lastParsed.home === home && lastParsed.cwd === cwd) return lastParsed;
  return (lastParsed = { raw: cmd, segments: segmentsOf(cmd, new Map(), 0), home, cwd });
}

/**
 * Command operands: the words after the command word with redirections removed (`>`, `>>`, `<` and
 * their target, and an fd digit before a redirect). `cp k FILE 2>/dev/null` has the operands k and FILE.
 */
function operandsOf(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (REDIRECT_OPS.has(t)) {
      i++;
      continue;
    }
    if (/^\d+$/.test(t) && REDIRECT_OPS.has(tokens[i + 1] ?? "")) continue;
    out.push(t);
  }
  return out;
}

/** Persistence paths, matched on the normalized path (see normalizePath). */
// Case-insensitive (`i`): macOS file systems are case-insensitive by default, so `~/.SSH/Authorized_Keys` is the same file.
const AUTHORIZED_KEYS = /(^|\/)\.ssh\/authorized_keys2?$/i;
const CRON_PATH = /^\/(etc\/cron|var\/spool\/cron)/i;
// Directory forms end with `(\/|$)`: normalizePath drops a trailing slash, and `cp x ~/Library/LaunchAgents/` writes inside.
const LAUNCH_PATH = /(^|\/)Library\/Launch(Agents|Daemons)(\/|$)/i;
const SYSTEMD_USER_PATH = /(^|\/)\.config\/systemd\/user(\/|$)|^\/etc\/systemd\/user(\/|$)/i;
const SHELL_RC_PATH = /(^|\/)\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile)$/i;
/** A curl or wget word (not part of a longer name). Used on a whole command that writes a shell rc file. */
const NET_WORD = /(^|[^A-Za-z0-9_])(curl|wget)(?![A-Za-z0-9_])/;

/**
 * The candidates the persistence and tunnel rules read: the last MAX_CANDIDATES command words of a segment,
 * without coproc NAMEs. The real command is the last candidate, so it is always read. Earlier candidates come
 * from expansions (`$(:)tee`) and are bounded here, so a long run of them stays linear (`coproc tee {` repeated was quadratic).
 */
const MAX_CANDIDATES = 16;

/** Like hasCommand, over the bounded candidates. Allocates nothing: this runs for every rule on every command. */
function hasCandidate(sh: Shell, pred: (c: Cmd) => boolean): boolean {
  const segs = sh.segments;
  for (let i = 0; i < segs.length; i++) {
    const cs = segs[i]!.cmds;
    let n = 0;
    for (let k = cs.length - 1; k >= 0 && n < MAX_CANDIDATES; k--) {
      const c = cs[k]!;
      if (c.coprocName) continue;
      n++;
      if (pred(c)) return true;
    }
  }
  return false;
}

/**
 * Paths that a segment writes: redirect targets, tee operands, the destination of cp, mv and install,
 * the files of `sed -i`, and dd `of=`. Only the shapes named here count (a python `open(..., 'w')` does not).
 */
function writtenPaths(seg: Segment, out: string[]): void {
  const t = seg.tokens;
  for (let i = 0; i + 1 < t.length; i++) if (t[i] === ">" || t[i] === ">>") out.push(t[i + 1]!);
  const cs = seg.cmds;
  let n = 0;
  for (let k = cs.length - 1; k >= 0 && n < MAX_CANDIDATES; k--) {
    const c = cs[k]!;
    if (c.coprocName) continue;
    n++;
    if (c.name === "tee") {
      for (const a of operandsOf(c.args)) if (!a.startsWith("-")) out.push(a);
    } else if (c.name === "cp" || c.name === "mv" || c.name === "install") {
      copyTargets(c, out);
    } else if (c.name === "curl" || c.name === "wget") {
      downloadTargets(c, out);
    } else if (c.name === "sed") {
      if (c.args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
        out.push(...operandsOf(c.args).filter((a) => !a.startsWith("-")).slice(1));
      }
    } else if (c.name === "dd") {
      for (const a of c.args) if (a.startsWith("of=")) out.push(a.slice(3));
    }
  }
}

/** The last path part of a path, with trailing slashes removed (`~/.ssh/` gives `.ssh`). */
function baseName(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1);
}

/** Options of cp, mv and install that take a value (`install -m MODE`, `cp -S SUFFIX`): the value is not a path. */
const COPY_VALUE_LETTERS = "Smog";

/**
 * A long option named by `full`, or by a unique prefix of it of at least `min` characters (`--tar` for
 * `--target-directory`). The value is the text after `=`, or the next word (then `used` is true).
 */
function longOption(t: string, full: string, min: number, next: string | undefined): { value: string | undefined; used: boolean } | undefined {
  const eq = t.indexOf("=");
  const name = eq >= 0 ? t.slice(0, eq) : t;
  if (name.length < min || !full.startsWith(name)) return undefined;
  return eq >= 0 ? { value: t.slice(eq + 1), used: false } : { value: next, used: true };
}

/** `dir/base`, with one slash between them. */
function joinPath(dir: string, base: string): string {
  return dir.endsWith("/") ? dir + base : `${dir}/${base}`;
}

/**
 * cp, mv and install destinations. A destination that is a directory receives each source under its basename, so
 * both the destination and `DIR/basename` are tested. `-t DIR`, `-tDIR`, `--target-directory DIR`,
 * `--target-directory=DIR` and any unique prefix of the long option name the directory first.
 */
function copyTargets(c: Cmd, out: string[]): void {
  const ops = operandsOf(c.args);
  let target: string | undefined;
  const plain: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i]!;
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const t = longOption(a, "--target-directory", 3, ops[i + 1]);
      if (t !== undefined) {
        target = t.value;
        if (t.used) i++;
      }
      continue;
    }
    if (a.length > 1 && a.startsWith("-")) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        if (ch === "t") {
          if (k < a.length - 1) target = a.slice(k + 1);
          else {
            target = ops[i + 1];
            i++;
          }
          break;
        }
        if (COPY_VALUE_LETTERS.includes(ch)) {
          if (k === a.length - 1) i++;
          break;
        }
        if (!/[A-Za-z]/.test(ch)) break;
      }
      continue;
    }
    plain.push(a);
  }
  if (target !== undefined) pushDestination(out, target, plain);
  else if (plain.length >= 2) pushDestination(out, plain[plain.length - 1]!, plain.slice(0, -1));
}

function pushDestination(out: string[], dest: string, sources: readonly string[]): void {
  out.push(dest);
  for (const src of sources) {
    const base = baseName(src);
    if (base !== "") out.push(joinPath(dest, base));
  }
}

/**
 * Write targets of curl and wget. curl: `-o`/`--output`, and `--output-dir DIR` (with `-O`/`--remote-name`, the file
 * is the URL basename in that directory). wget: `-O`/`--output-document`, and `-P`/`--directory-prefix DIR` (wget
 * writes the URL basename in that directory unless -O is given). A value can be attached (`-o/path`, `-sSo~/x`,
 * `--output=/x`), and a long option can be a unique prefix (`--out`). Extra paths only add tests, so this fails closed.
 */
function downloadTargets(c: Cmd, out: string[]): void {
  const curl = c.name === "curl";
  const FILE_OPT = curl ? "--output" : "--output-document";
  const DIR_OPT = curl ? "--output-dir" : "--directory-prefix";
  const FILE_LETTER = curl ? "o" : "O";
  const DIR_LETTER = curl ? "" : "P";
  const a = c.args;
  const files: string[] = [];
  const urls: string[] = [];
  let dir: string | undefined;
  let remote = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i]!;
    if (t.startsWith("--")) {
      const name = t.split("=")[0]!;
      if (curl && name.length >= 4 && ("--remote-name".startsWith(name) || "--remote-name-all".startsWith(name) || "--remote-header-name".startsWith(name) || "--content-disposition".startsWith(name))) remote = true;
      const f = longOption(t, FILE_OPT, 3, a[i + 1]);
      const d = longOption(t, DIR_OPT, 3, a[i + 1]);
      if (f?.value !== undefined) files.push(f.value);
      if (d?.value !== undefined) dir = d.value;
      if (f?.used || d?.used) i++;
      continue;
    }
    if (t.length > 1 && t.startsWith("-")) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k]!;
        if (ch === FILE_LETTER || (DIR_LETTER !== "" && ch === DIR_LETTER)) {
          const used = k === t.length - 1;
          const v = used ? a[i + 1] : t.slice(k + 1);
          if (ch === FILE_LETTER) {
            if (v !== undefined) files.push(v);
          } else {
            dir = v;
          }
          if (used) i++;
          break;
        }
        if (curl && (ch === "O" || ch === "J")) remote = true;
        if (!/[A-Za-z]/.test(ch)) break;
      }
      continue;
    }
    urls.push(t); // any operand: a scheme-less host is a URL too
  }
  for (const f of files) {
    out.push(f);
    if (dir !== undefined && dir !== "") out.push(joinPath(dir, f));
  }
  const named = curl ? remote : files.length === 0;
  if (named) {
    // The server can choose the file name, so the directory is a write target. `authorized_keys` is joined onto it
    // too: the rule then tests the normalized path, so `~/.SSH`, `$HOME/.ssh`, `./../.ssh` all resolve to a .ssh
    // directory. Each name is pushed bare and joined onto the directory (extra paths only add tests).
    const d = dir ?? "";
    if (d !== "") {
      out.push(d);
      out.push(joinPath(d, "authorized_keys"));
    }
    for (const u of urls) {
      const base = baseName(u.replace(/[?#].*$/, ""));
      if (base === "") continue;
      out.push(base);
      if (d !== "") out.push(joinPath(d, base));
    }
  }
}

/** Normalized written paths of one command, computed once for all rules that ask (they all read the same list). */
const WRITTEN_CACHE = new WeakMap<Shell, string[]>();
function writtenIn(sh: Shell): string[] {
  let out = WRITTEN_CACHE.get(sh);
  if (out === undefined) {
    const raw: string[] = [];
    const segs = sh.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      // `>|` and `>&` end the segment at the operator, so the target is the first word of the next segment.
      const prev = i > 0 ? segs[i - 1]!.tokens : undefined;
      const last = prev?.[prev.length - 1];
      if (seg.tokens.length > 0 && (last === ">" || last === ">>")) raw.push(seg.tokens[0]!);
      writtenPaths(seg, raw);
    }
    out = raw.map((w) => normalizePath(w, sh.home));
    WRITTEN_CACHE.set(sh, out);
  }
  return out;
}

/** True when a segment of the command writes to a path that `pred` accepts (after normalizePath). */
function writesTo(sh: Shell, pred: (p: string) => boolean): boolean {
  for (const p of writtenIn(sh)) if (pred(p)) return true;
  return false;
}

/** crontab that installs a table: `crontab -`, `crontab -e` or `crontab FILE`. `-l` and `-r` do not. */
function cronWrites(c: Cmd): boolean {
  if (c.name !== "crontab") return false;
  const ops = operandsOf(c.args);
  for (let i = 0; i < ops.length; i++) {
    const t = ops[i]!;
    if (t === "-u") {
      i++;
      continue;
    }
    if (t === "-" || t === "-e" || !t.startsWith("-")) return true;
  }
  return false;
}

/** `at TIME` or `at -f FILE` schedules a job. `at -l` (list) and `at -d` or `-r` (remove) do not. */
function atSchedules(c: Cmd): boolean {
  if (c.name !== "at") return false;
  const ops = operandsOf(c.args);
  if (ops.includes("-d") || ops.includes("-r")) return false;
  return ops.includes("-f") || ops.some((t) => !t.startsWith("-"));
}

/** The first operand that is not an option (the subcommand of launchctl and systemctl). */
function firstSubcommand(c: Cmd): string | undefined {
  return operandsOf(c.args).find((t) => !t.startsWith("-"));
}

/** `launchctl load` or `launchctl bootstrap` starts a LaunchAgent or LaunchDaemon. `launchctl list` does not. */
function launchLoads(c: Cmd): boolean {
  if (c.name !== "launchctl") return false;
  const sub = firstSubcommand(c);
  return sub === "load" || sub === "bootstrap";
}

/** `systemctl --user enable` or `link` makes a user unit start at login. `--user status` does not. */
function systemdUserEnables(c: Cmd): boolean {
  if (c.name !== "systemctl") return false;
  const ops = operandsOf(c.args);
  if (!ops.includes("--user")) return false;
  const sub = firstSubcommand(c);
  return sub === "enable" || sub === "link";
}

/** Option letters that take a value in ssh (`-p 22`, `-oKey=val`, `-L 8080:x:80`). */
const SSH_VALUE_LETTERS = "BbcDEeFIiJLlmOopQRSWw";
/**
 * Every ssh option in the command, wherever it stands. OpenSSH parses options after the destination too
 * (`ssh host -R 9000:localhost:22 -N`), so every operand is read until `--`. Returns the option letters, the
 * values of `-o` options (`RemoteForward=...`), the `-F` config files, and the destination (the first operand
 * that is not an option). A value option takes the rest of its word, or the next word: `-fNR host`, `-R8080:...`,
 * `-oRemoteForward=...`, `-F~/x`.
 */
function sshShape(c: Cmd): { letters: Set<string>; opts: string[]; configs: string[]; libs: string[]; dest: string | undefined } {
  const ops = operandsOf(c.args);
  const letters = new Set<string>();
  const opts: string[] = [];
  const configs: string[] = [];
  const libs: string[] = [];
  let dest: string | undefined;
  let noMoreOptions = false;
  for (let i = 0; i < ops.length; i++) {
    const t = ops[i]!;
    if (!noMoreOptions && t === "--") {
      noMoreOptions = true;
      continue;
    }
    if (noMoreOptions || !t.startsWith("-") || t === "-") {
      if (dest === undefined) dest = t;
      continue;
    }
    for (let k = 1; k < t.length; k++) {
      const ch = t[k]!;
      letters.add(ch);
      if (SSH_VALUE_LETTERS.includes(ch)) {
        const attached = k < t.length - 1;
        const value = attached ? t.slice(k + 1) : ops[i + 1];
        if (!attached) i++;
        if (ch === "o" && value !== undefined) opts.push(value);
        if (ch === "F" && value !== undefined) configs.push(value);
        if (ch === "I" && value !== undefined) libs.push(value);
        break;
      }
    }
  }
  return { letters, opts, configs, libs, dest };
}

/** The two jump shapes allowed as a ProxyCommand: `ssh -W %h:%p HOST` and `nc %h %p`. */
const SSH_JUMP = /^(ssh -W %h:%p [A-Za-z0-9._@:-]+|nc %h %p)$/;

/**
 * One -o option value: the keyword is the text before the first `=` or whitespace, lower-cased. Double quotes are
 * removed first, the way OpenSSH reads `-o "ProxyCommand=nc x 22"` and `-o '"ProxyCommand" nc x 22'`.
 * Undefined when no keyword can be read.
 */
function sshOptionKeyValue(v: string): { key: string; value: string } | undefined {
  const m = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*([\s\S]*)$/.exec(v.replace(/"/g, "").trim());
  return m ? { key: m[1]!.toLowerCase(), value: m[2]!.trim() } : undefined;
}

/**
 * A -o option that runs a command and whose value is not one of the two jump shapes (`SSH_JUMP`), or a -o option
 * that cannot be read (fail closed). Gated keys: every keyword that ends in `command` (ProxyCommand, LocalCommand,
 * KnownHostsCommand, RemoteCommand), except PermitLocalCommand, a yes/no switch. This is an allowlist of the value,
 * not a word list. IdentityAgent names a socket and is not gated.
 */
function sshOptionDenied(v: string): boolean {
  const kv = sshOptionKeyValue(v);
  if (!kv) return true;
  if (!kv.key.endsWith("command") || kv.key === "permitlocalcommand") return false;
  return !SSH_JUMP.test(kv.value);
}

/** -o keys that load a shared library (a provider) into ssh: only `none` or an empty value is allowed. */
const CODE_PROVIDER_KEYS = new Set(["pkcs11provider", "securitykeyprovider"]);
function providerValueDenied(value: string): boolean {
  const v = value.replace(/"/g, "").trim().toLowerCase();
  return v !== "" && v !== "none";
}
function sshCodeLoadingDenied(c: Cmd): boolean {
  const shape = sshShape(c);
  if (shape.libs.some(providerValueDenied)) return true;
  return shape.opts.some((v) => {
    const kv = sshOptionKeyValue(v);
    return kv !== undefined && CODE_PROVIDER_KEYS.has(kv.key) && providerValueDenied(kv.value);
  });
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Octets of a dotted IPv4 literal, or undefined. */
function ipv4Octets(s: string): number[] | undefined {
  const m = IPV4.exec(s);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : undefined;
}
/** A dotted IPv4 host, with an optional `user@` in front. A name such as `1.2.3.4.nip.io` is not one. */
function isIpv4Host(d: string | undefined): boolean {
  if (d === undefined) return false;
  return ipv4Octets(d.slice(d.lastIndexOf("@") + 1)) !== undefined;
}
/** Public IPv4: not loopback (127), private (10, 172.16/12, 192.168), link-local (169.254), or 0. */
function isPublicIpv4(s: string): boolean {
  const [a = -1, b = -1] = ipv4Octets(s) ?? [];
  if (a < 0) return false;
  return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}
const IPV4_IN_TEXT = /(?:^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g;
/** True when a word holds a public dotted IPv4 literal (a URL `http://8.8.8.8:80/x` counts). */
function hasPublicIpv4(s: string): boolean {
  for (const m of s.matchAll(IPV4_IN_TEXT)) if (isPublicIpv4(m[1]!)) return true;
  return false;
}

/** `ssh -R` (any destination, any position, or `RemoteForward` in an option): a reverse tunnel into this machine. */
function sshReverseForward(c: Cmd): boolean {
  if (c.name !== "ssh") return false;
  const { letters, opts } = sshShape(c);
  return letters.has("R") || opts.some((v) => /^remoteforward/i.test(v));
}
/** `ssh -L ... -N` (or `-o LocalForward`) to a dotted IPv4 address. A tunnel to a host name is allowed (a normal dev tunnel). */
function sshLocalToRawIp(c: Cmd): boolean {
  if (c.name !== "ssh") return false;
  const { letters, opts, dest } = sshShape(c);
  const forward = letters.has("L") || opts.some((v) => /^localforward/i.test(v));
  return forward && letters.has("N") && isIpv4Host(dest);
}
/** `ssh -w` opens a layer 3 tunnel device on both ends. Denied: it is a tunnel with no host check. */
function sshTunnelDevice(c: Cmd): boolean {
  return c.name === "ssh" && sshShape(c).letters.has("w");
}
/** `ssh -o ProxyCommand=...` that runs a shell, netcat, socat, an interpreter or a download: a command run on connect. */
function sshProxyExec(c: Cmd): boolean {
  return c.name === "ssh" && sshShape(c).opts.some(sshOptionDenied);
}
/**
 * `ssh -F FILE` when this same command writes FILE (a redirect, tee, cp and so on): the config can carry a
 * ProxyCommand that was written in the same call. A config written by an earlier call is not seen (documented limit).
 */
function sshConfigWritten(sh: Shell): boolean {
  const written = writtenIn(sh);
  if (written.length === 0) return false;
  return hasCandidate(sh, (c) => c.name === "ssh" && sshShape(c).configs.some((f) => written.includes(normalizePath(f, sh.home))));
}

const NC_NAMES = new Set(["nc", "ncat", "netcat"]);
/**
 * A netcat or socat listener or client that runs a program. For nc, ncat and netcat, `-e`, `-c` or `--exec`,
 * `--sh-exec` (also inside a short cluster such as `-nve`). `nc -z`, `nc -l PORT`, and `nc host port < file` are not matches.
 */
function netcatExec(c: Cmd): boolean {
  if (NC_NAMES.has(c.name)) {
    return operandsOf(c.args).some((a) => /^-[A-Za-z]*[ec]/.test(a) || a === "--exec" || a === "--sh-exec");
  }
  if (c.name === "socat") return operandsOf(c.args).some((a) => /(^|[,:])(EXEC|SYSTEM):/i.test(a));
  return false;
}

const DEV_TCP = /^\/dev\/(tcp|udp)\//;
const REDIRECT_IN_OUT = new Set(["<", ">", ">>"]);
/**
 * A bash network redirect: `/dev/tcp/HOST/PORT` as the target of `<`, `>` or `>>`, or as the first word of a
 * segment (`bash -i >& /dev/tcp/...` splits at the `&`, so the target starts the next segment). Text that
 * only names the path (`git commit -m "/dev/tcp"`) does not count.
 */
function devTcpRedirect(sh: Shell): boolean {
  if (!sh.raw.includes("/dev/")) return false;
  for (const seg of sh.segments) {
    const t = seg.tokens;
    if (t.length > 0 && DEV_TCP.test(t[0]!)) return true;
    for (let i = 0; i + 1 < t.length; i++) {
      if (REDIRECT_IN_OUT.has(t[i]!) && DEV_TCP.test(t[i + 1]!)) return true;
    }
  }
  return false;
}

/**
 * True when the words of one command dump the environment: `env` or `printenv` with no command after it,
 * bare `set` (no operands), `export -p`, `declare -p` and `compgen -e`. `set -e` and `env FOO=1 node x` are not dumps.
 */
function isEnvDump(tokens: readonly string[]): boolean {
  let dump = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-") || ASSIGN.test(t)) continue;
    const name = wordName(t);
    if (name === "printenv") return true;
    if (name === "env") {
      dump = true;
      continue;
    }
    if (WRAPPERS.has(name)) continue;
    if (name === "set") return i === tokens.length - 1;
    if (name === "export" || name === "declare") return tokens.slice(i + 1).includes("-p");
    if (name === "compgen") return tokens.slice(i + 1).includes("-e");
    return false;
  }
  return dump;
}

const RAW_IP_CLIENTS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet"]);
const VAR_REF = /\$\{?[A-Za-z_]/;
/**
 * Environment names or values sent to a public raw IPv4 address. The command must have a client
 * (curl, wget, nc, socat, telnet) with a public IPv4 operand, and either an environment dump
 * (`env | ...`, `printenv`, bare `set`, `$(env)`) or a `$NAME` reference anywhere in the same command.
 * Linear: the client check runs first and stops most commands; then one scan for the dump, one for the reference.
 * Loopback and private addresses are allowed on purpose.
 */
function envToPublicIp(sh: Shell): boolean {
  if (!hasCandidate(sh, (c) => RAW_IP_CLIENTS.has(c.name) && operandsOf(c.args).some(hasPublicIpv4))) return false;
  for (const seg of sh.segments) if (isEnvDump(seg.tokens)) return true;
  for (const seg of sh.segments) if (seg.tokens.some((t) => VAR_REF.test(t))) return true;
  return false;
}

/** Path of one line of an apply_patch body (Codex): Add File, Update File, Delete File or Move to. */
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)$/gm;

/**
 * Words of the persistence, tunnel and exfiltration rules, searched in a whole command longer than MAX_SCAN_CHARS.
 * One alternation with no nested repeats, so the search is linear. It is coarse on purpose: a long command that
 * names one of these tools is denied.
 */
const LONG_INPUT_WORDS =
  /authorized_keys|LaunchAgents|LaunchDaemons|systemd\/user|\/etc\/cron|\/var\/spool\/cron|crontab|launchctl|systemctl|schtasks|ssh-copy-id|autossh|RemoteForward|LocalForward|ProxyCommand|\/dev\/(tcp|udp)\/|\bssh\b|\bnc\b|ncat|netcat|socat|\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|bash_login|profile)\b/i;

/**
 * THE rule table. One row per rule, one comment per row. The owner approved groups a to e
 * on 2026-10-29, with no changes. Groups f to h were added on 2026-10-30 and wait for owner
 * review. Changes to a row need owner approval. Matching is by parsed command word and exact
 * target, never by substring alone, so `~/proj/node_modules`, `/tmp/x` and `.env.example` stay allowed.
 */
export const NEVER_LIST_INPUT_RULES: readonly NeverListInputRule[] = [
  // a. Recursive delete of home, root or a top-level system dir (also find -delete / -exec rm on those).
  { id: "rm-recursive-home-or-system", group: "a", shell: (sh) => hasCommand(sh, rmRecursiveProtected) },
  { id: "find-delete-home-or-system", group: "a", shell: (sh) => hasCommand(sh, findDeleteProtected) },
  // b. Force push (flag or +refspec) to main, master, release* or prod*.
  { id: "git-force-push-protected-branch", group: "b", shell: (sh) => hasCommand(sh, (c) => gitForcePushProtected(c)) },
  // c. Read or copy of a private key, cloud or package credential, or a real .env file.
  { id: "secret-read-shell", group: "c", shell: (sh) => secretReadShell(sh) || interpreterReadsSecret(sh) },
  { id: "secret-read-file", group: "c", file: isSecretPath },
  // d. Disk and system destroyers.
  { id: "mkfs", group: "d", shell: (sh) => hasCommand(sh, (c) => c.name.startsWith("mkfs")) },
  {
    id: "dd-to-block-device",
    group: "d",
    shell: (sh) => hasCommand(sh, (c) => c.name === "dd" && c.args.some((a) => a.startsWith("of=") && BLOCK_DEVICE.test(a.slice(3)))),
  },
  {
    id: "redirect-to-block-device",
    group: "d",
    shell: (sh) => sh.segments.some((seg) => seg.tokens.some((t, i) => (t === ">" || t === ">>") && BLOCK_DEVICE.test(seg.tokens[i + 1] ?? ""))),
  },
  { id: "fork-bomb", group: "d", shell: forkBomb },
  { id: "chmod-chown-recursive-root", group: "d", shell: (sh) => hasCommand(sh, chmodChownRecursiveProtected) },
  // e. Network download piped into a shell, or run as code through a substitution (`sh -c "$(curl ...)"`).
  { id: "pipe-network-to-shell", group: "e", shell: (sh) => pipeNetworkToShell(sh) || nestedNetExec(sh) },
  // f. Agent-driven persistence (added 2026-10-30). A write rule also runs on Write, Edit and apply_patch paths.
  { id: "ssh-authorized-keys-write", group: "f", shell: (sh) => writesTo(sh, (p) => AUTHORIZED_KEYS.test(p)), writeFile: (p, home) => AUTHORIZED_KEYS.test(normalizePath(p, home)) },
  { id: "ssh-copy-id", group: "f", shell: (sh) => hasCandidate(sh, (c) => c.name === "ssh-copy-id") },
  { id: "persistence-cron", group: "f", shell: (sh) => hasCandidate(sh, cronWrites) || writesTo(sh, (p) => CRON_PATH.test(p)), writeFile: (p, home) => CRON_PATH.test(normalizePath(p, home)) },
  { id: "persistence-at-job", group: "f", shell: (sh) => hasCandidate(sh, atSchedules) },
  { id: "persistence-launchd", group: "f", shell: (sh) => hasCandidate(sh, launchLoads) || writesTo(sh, (p) => LAUNCH_PATH.test(p)), writeFile: (p, home) => LAUNCH_PATH.test(normalizePath(p, home)) },
  { id: "persistence-systemd-user", group: "f", shell: (sh) => hasCandidate(sh, systemdUserEnables) || writesTo(sh, (p) => SYSTEMD_USER_PATH.test(p)), writeFile: (p, home) => SYSTEMD_USER_PATH.test(normalizePath(p, home)) },
  { id: "persistence-schtasks-create", group: "f", shell: (sh) => hasCandidate(sh, (c) => c.name === "schtasks" && c.args.some((a) => a.toLowerCase() === "/create")) },
  // A download (curl, wget) in a command that writes a shell rc file: it runs at every shell start.
  { id: "shell-rc-download-append", group: "f", shell: (sh) => NET_WORD.test(sh.raw) && writesTo(sh, (p) => SHELL_RC_PATH.test(p)) },
  // g. Reverse tunnels and reverse shells (added 2026-10-30).
  { id: "ssh-reverse-forward", group: "g", shell: (sh) => hasCandidate(sh, sshReverseForward) },
  { id: "ssh-local-forward-raw-ip", group: "g", shell: (sh) => hasCandidate(sh, sshLocalToRawIp) },
  { id: "reverse-shell-netcat-exec", group: "g", shell: (sh) => hasCandidate(sh, netcatExec) },
  { id: "reverse-shell-dev-tcp", group: "g", shell: devTcpRedirect },
  { id: "autossh-tunnel", group: "g", shell: (sh) => hasCandidate(sh, (c) => c.name === "autossh") },
  { id: "ssh-tunnel-device", group: "g", shell: (sh) => hasCandidate(sh, sshTunnelDevice) },
  { id: "ssh-proxy-command-exec", group: "g", shell: (sh) => hasCandidate(sh, sshProxyExec) },
  { id: "ssh-config-written", group: "g", shell: sshConfigWritten },
  { id: "ssh-code-loading-option", group: "g", shell: (sh) => hasCandidate(sh, sshCodeLoadingDenied) },
  // Long command (over MAX_SCAN_CHARS): the parsed windows skip the middle, so the whole text is searched for these words.
  { id: "long-input-persistence-words", group: "f", fullText: (text) => LONG_INPUT_WORDS.test(text) },
  // h. Exfiltration of environment names or values to a public raw IPv4 address (added 2026-10-30).
  { id: "env-dump-to-raw-ip", group: "h", shell: envToPublicIp },
];

const WRITE_NAME = /write|edit|create|update|delete|remove|move|rename|patch|replace|save|append|mkdir|touch/;
const SHELL_NAME = /bash|shell|terminal|exec|command/;
/** Single path fields of read tools (Claude, Codex, Gemini `read_file` uses file_path, `absolute_path` is its fallback). */
const PATH_FIELDS = ["file_path", "filePath", "path", "target_file", "notebook_path", "absolute_path"] as const;
/** Path list fields of read tools (Gemini `read_many_files` takes `include`, glob patterns). */
const PATH_LIST_FIELDS = ["include", "paths"] as const;

/** Last name segment (after `mcp__server__`), lower case. */
function lastSegment(toolId: string): string {
  return toolId.split("__").pop()!.trim().toLowerCase();
}

export function isShellTool(toolId: string): boolean {
  const last = lastSegment(toolId);
  return findHostToolTier(last) === "SHELL" || SHELL_NAME.test(last);
}

/** Tools that write. The file rule skips them: a write to `.env` is not a read of a secret. */
export function isWriteLike(toolId: string): boolean {
  const last = lastSegment(toolId);
  if (findHostToolTier(last) === "WRITE" || WRITE_NAME.test(last)) return true;
  const mcp = parseMcpToolId(toolId);
  if (!mcp) return false;
  const tier = mcpToolTier(mcp.server, mcp.tool);
  return tier === "WRITE" || tier === "ADMIN";
}

export function fieldsOf(toolInput: unknown): Record<string, unknown> | undefined {
  let v = toolInput;
  if (typeof v === "string") {
    if (v.length > MAX_JSON_CHARS) return undefined;
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** The first and last window of a long field. A short field is one window. */
export function windowsOf(s: string): string[] {
  return s.length <= MAX_SCAN_CHARS ? [s] : [s.slice(0, MAX_SCAN_CHARS), s.slice(-MAX_SCAN_CHARS)];
}

export function commandStrings(f: Record<string, unknown>): string[] {
  const v = f.command ?? f.cmd;
  let s: string | undefined;
  if (typeof v === "string") s = v;
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) s = (v as string[]).join(" ");
  return s === undefined ? [] : windowsOf(s);
}

export function pathStrings(f: Record<string, unknown>, toolId: string): string[] {
  const out: string[] = [];
  for (const k of PATH_FIELDS) {
    const v = f[k];
    if (typeof v === "string" && v.length > 0) out.push(...windowsOf(v));
  }
  if (/read/.test(lastSegment(toolId))) {
    for (const k of PATH_LIST_FIELDS) {
      const v = f[k];
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        if (typeof item === "string" && item.length > 0) out.push(...windowsOf(item));
      }
    }
  }
  return out;
}

/** Paths that a write-like tool writes: its path fields, and for Codex apply_patch the paths named in the patch body. */
function writePathStrings(f: Record<string, unknown>, toolId: string): string[] {
  const out = pathStrings(f, toolId);
  if (lastSegment(toolId) === "apply_patch") {
    // The patch is one string, or an argv array whose items are lines or chunks. Each item is scanned on its own
    // (a joined array does not hide a line start), and the whole item is scanned, not a window: the header regex is
    // linear, and a long patch must not hide a header in its middle.
    const v = f.command ?? f.cmd;
    const items = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    for (const item of items) for (const m of item.matchAll(PATCH_PATH)) out.push(m[1]!.trim());
  }
  return out;
}

/** The whole shell command text, unwindowed (the same join as commandStrings), or undefined when there is none. */
function fullCommandText(f: Record<string, unknown>): string | undefined {
  const v = f.command ?? f.cmd;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).join(" ");
  return undefined;
}

/** Home directory for `~` and absolute home paths. Undefined when the OS has none. */
function safeHome(): string | undefined {
  try {
    const h = homedir();
    return h && h.startsWith("/") ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First matching input rule for this tool call, or undefined (allow). The caller
 * denies with reasonCode NEVER_EVENT. Never throws: any error is an undefined result.
 */
export function neverListInputMatch(
  toolId: string,
  toolInput: unknown,
  home: string | undefined = safeHome(),
  cwd?: string,
): { readonly rule: string } | undefined {
  try {
    const f = fieldsOf(toolInput);
    if (!f) return undefined;
    if (isShellTool(toolId)) {
      // Long command: the parsed windows do not cover the middle, so the whole text gets the word search first.
      const full = fullCommandText(f);
      if (full !== undefined && full.length > MAX_SCAN_CHARS) {
        for (const r of NEVER_LIST_INPUT_RULES) if (r.fullText?.(full)) return { rule: r.id };
      }
      for (const cmd of commandStrings(f)) {
        const sh = parseShell(cmd, home, cwd);
        for (const r of NEVER_LIST_INPUT_RULES) if (r.shell?.(sh)) return { rule: r.id };
      }
    }
    if (isWriteLike(toolId)) {
      // Write tools: only the writeFile rules (persistence files). A write to `.env` is not a read of a secret.
      for (const p of writePathStrings(f, toolId)) {
        for (const r of NEVER_LIST_INPUT_RULES) if (r.writeFile?.(p, home)) return { rule: r.id };
      }
    } else {
      for (const p of pathStrings(f, toolId)) {
        for (const r of NEVER_LIST_INPUT_RULES) if (r.file?.(p, home)) return { rule: r.id };
      }
    }
  } catch {
    // Fail open: a parse problem never adds a deny.
  }
  return undefined;
}
