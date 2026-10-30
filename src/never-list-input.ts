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

interface Segment {
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

interface Shell {
  readonly raw: string;
  readonly segments: readonly Segment[];
  readonly home: string | undefined;
}

/** A command word and the tokens after it. Copied once, when the segment is built. */
class Cmd {
  private cached: readonly string[] | undefined;
  /** `raw` is the word as written (a download substitution is checked on it). */
  constructor(readonly name: string, readonly raw: string, private readonly tokens: readonly string[], private readonly start: number) {}
  /** Arguments, copied on first use: most candidate words are never asked for them. */
  get args(): readonly string[] {
    return (this.cached ??= this.tokens.slice(this.start));
  }
}

export interface NeverListInputRule {
  /** Stable id. Shown in the deny reason and listed in docs/guides/kya-never-list.md. */
  readonly id: string;
  /** Group a to e, as in the owner's list. */
  readonly group: "a" | "b" | "c" | "d" | "e";
  /** Checks a shell command. Only shell-like tools reach it. */
  readonly shell?: (sh: Shell) => boolean;
  /** Checks a file path. Only tools that are not write-like reach it. */
  readonly file?: (path: string, home: string | undefined) => boolean;
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
      out.push(new Cmd(tokens[i + 1]!, tokens[i + 1]!, tokens, i + 2));
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

function hasCommand(sh: Shell, pred: (c: Cmd, sh: Shell) => boolean): boolean {
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
function normalizePath(w: string, home: string | undefined): string {
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

/** Root, home, home contents, or a top-level system directory (with optional `/*`). */
function isProtected(word: string, home: string | undefined): boolean {
  const p = normalizePath(word, home);
  if (ROOT_SET.has(p) || TOP_LEVEL.test(p) || USER_HOME.test(p)) return true;
  return home !== undefined && (p === home || p === `${home}/*` || p === `${home}/.*`);
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
  if (!starts.some((p) => isProtected(p, sh.home))) return false;
  if (c.args.includes("-delete")) return true;
  const exec = c.args.some((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
  return exec && c.args.includes("rm");
}

function rmRecursiveProtected(c: Cmd, sh: Shell): boolean {
  if (c.name !== "rm") return false;
  const flags = c.args.filter((t) => t.startsWith("-"));
  const paths = c.args.filter((t) => !t.startsWith("-"));
  return isRecursive(flags) && paths.some((p) => isProtected(p, sh.home));
}

function chmodChownRecursiveProtected(c: Cmd, sh: Shell): boolean {
  if (c.name !== "chmod" && c.name !== "chown") return false;
  const flags = c.args.filter((t) => t.startsWith("-"));
  const rest = c.args.filter((t) => !t.startsWith("-"));
  if (!isRecursive(flags)) return false;
  if (c.name === "chmod" && !rest.some((t) => /^0?777$/.test(t))) return false;
  return rest.some((p) => isProtected(p, sh.home));
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
function gitSubInfo(a: readonly string[]): { idx: number; known: boolean } {
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
function isSecretPath(raw: string, home: string | undefined): boolean {
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

function parseShell(cmd: string, home: string | undefined): Shell {
  return { raw: cmd, segments: segmentsOf(cmd, new Map(), 0), home };
}

/**
 * THE rule table. One row per rule, one comment per row. The owner approved this list
 * on 2026-10-29, with no changes. Changes to a row need owner approval. Matching is by
 * parsed command word and exact target, never by substring alone, so
 * `~/proj/node_modules`, `/tmp/x` and `.env.example` stay allowed.
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
  { id: "fork-bomb", group: "d", shell: (sh) => FORK_BOMB.test(sh.raw) },
  { id: "chmod-chown-recursive-root", group: "d", shell: (sh) => hasCommand(sh, chmodChownRecursiveProtected) },
  // e. Network download piped into a shell, or run as code through a substitution (`sh -c "$(curl ...)"`).
  { id: "pipe-network-to-shell", group: "e", shell: (sh) => pipeNetworkToShell(sh) || nestedNetExec(sh) },
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

function isShellTool(toolId: string): boolean {
  const last = lastSegment(toolId);
  return findHostToolTier(last) === "SHELL" || SHELL_NAME.test(last);
}

/** Tools that write. The file rule skips them: a write to `.env` is not a read of a secret. */
function isWriteLike(toolId: string): boolean {
  const last = lastSegment(toolId);
  if (findHostToolTier(last) === "WRITE" || WRITE_NAME.test(last)) return true;
  const mcp = parseMcpToolId(toolId);
  if (!mcp) return false;
  const tier = mcpToolTier(mcp.server, mcp.tool);
  return tier === "WRITE" || tier === "ADMIN";
}

function fieldsOf(toolInput: unknown): Record<string, unknown> | undefined {
  let v = toolInput;
  if (typeof v === "string") {
    if (v.length > MAX_JSON_CHARS) return undefined;
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** The first and last window of a long field. A short field is one window. */
function windowsOf(s: string): string[] {
  return s.length <= MAX_SCAN_CHARS ? [s] : [s.slice(0, MAX_SCAN_CHARS), s.slice(-MAX_SCAN_CHARS)];
}

function commandStrings(f: Record<string, unknown>): string[] {
  const v = f.command ?? f.cmd;
  let s: string | undefined;
  if (typeof v === "string") s = v;
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) s = (v as string[]).join(" ");
  return s === undefined ? [] : windowsOf(s);
}

function pathStrings(f: Record<string, unknown>, toolId: string): string[] {
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
): { readonly rule: string } | undefined {
  try {
    const f = fieldsOf(toolInput);
    if (!f) return undefined;
    if (isShellTool(toolId)) {
      for (const cmd of commandStrings(f)) {
        const sh = parseShell(cmd, home);
        for (const r of NEVER_LIST_INPUT_RULES) if (r.shell?.(sh)) return { rule: r.id };
      }
    }
    if (!isWriteLike(toolId)) {
      for (const p of pathStrings(f, toolId)) {
        for (const r of NEVER_LIST_INPUT_RULES) if (r.file?.(p, home)) return { rule: r.id };
      }
    }
  } catch {
    // Fail open: a parse problem never adds a deny.
  }
  return undefined;
}
