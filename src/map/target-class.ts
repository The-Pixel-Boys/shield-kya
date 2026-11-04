import { isSecretPath } from "../never-list-input.js";

/** A class string such as `secret:ssh-key` or `project:app/src/**`. Never a raw path, file name or argument. */
export type TargetClass = string;

/** `other` holds absolute paths that match no named class (schema 4.4 rule 9). */
export type TargetFamily = "network" | "secret" | "tmp" | "system" | "project" | "home" | "command" | "none" | "other";

export interface TargetInput {
  readonly toolId: string;
  readonly targetPath?: string;
  readonly summary?: string;
  readonly project?: string;
  /** Absolute working directory of the call. With it a path is "in the project" only when it is under this directory. */
  readonly cwd?: string;
  readonly home?: string;
}

/** Same shape as the redacted shell line written by `summarizeShellCommand`. Only the binary and the arg count survive. */
const SHELL_SUMMARY = /^shell (\S+?)( \(\+\d+ args\))?$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const TMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const SYSTEM_ROOTS = ["/private/etc", "/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/opt", "/boot", "/dev", "/proc"];

/** A path segment shown in a class. Anything that could carry a credential (`user:pass@`, `?x=`) becomes `(other)`. */
function seg(s: string): string {
  return s === "" || s === "." || s === ".." || s.length > 64 || /[:@?#=&%\u0000-\u001f]/.test(s) ? "(other)" : s;
}

const NET_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

/** Host of an absolute URL, or undefined. Only network schemes; the host must look like a host (no opaque text). */
function urlHost(s: string): string | undefined {
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    return NET_SCHEMES.has(u.protocol) && host.length <= 253 && HOST.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Local path of a file: URL, or undefined for any other scheme. The path stays inside this module: only a class leaves it. */
function fileUrlPath(s: string): string | undefined {
  if (!/^file:\/\//i.test(s)) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "file:") return undefined;
    try {
      return decodeURIComponent(u.pathname);
    } catch {
      return u.pathname;
    }
  } catch {
    return "/";
  }
}

/** Directory names that carry no personal data. Used when the working directory is unknown (rows written before `targetClass`). */
const COMMON_DIRS = new Set(["src", "lib", "test", "tests", "docs", "app", "web", "api", "scripts", "public", "dist", "build", "node_modules", ".github", ".kya", ".claude"]);
const RESERVED_PROJECT = new Set(["home", "Users", "root", "tmp", "var", "etc", "usr", "opt", "private"]);

/** `s` without trailing slashes. A loop, not `/\/+$/`: that regex is quadratic on a long run of slashes before another character. */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** Part of `t` inside the project, or undefined. Exact when `cwd` is known; a guarded guess from the project name otherwise. */
function projectRest(t: string, input: TargetInput): { rest: string; exact: boolean } | undefined {
  const project = input.project;
  if (!project || RESERVED_PROJECT.has(project)) return undefined;
  const cwd = input.cwd === undefined ? undefined : trimTrailingSlashes(input.cwd);
  if (cwd && cwd.startsWith("/")) {
    // A project folder that is the home folder or above it names a user: no project class.
    if (cwd === "" || (input.home && (cwd === input.home || input.home.startsWith(cwd + "/")))) return undefined;
    // Shaped like a home folder (another user, a container, a sandbox HOME): its name is a user name.
    if (/^\/(?:Users|home)\/[^/]+$/.test(cwd) || cwd === "/root") return undefined;
    if (t === cwd) return { rest: "", exact: true };
    return t.startsWith(cwd + "/") ? { rest: t.slice(cwd.length + 1), exact: true } : undefined;
  }
  const at = t.indexOf(`/${project}/`);
  return at > 0 ? { rest: t.slice(at + project.length + 2), exact: false } : undefined;
}

/** Secret family, a fixed label chosen from the path shape. `isSecretPath` decides whether it is secret. */
function secretLabel(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/(^|\/)\.ssh\//.test(p)) return "ssh-key";
  if (/(^|\/)\.aws\/|gcloud/.test(p)) return "cloud-credential";
  if (base.startsWith(".env")) return "env-file";
  if (/\.(pem|key)$/.test(base)) return "key-file";
  return "other";
}

/** Home-relative remainder of a path (`/.zshrc`, `/Documents/x`), or undefined when the path is not under a home. */
function homeRest(p: string, home: string | undefined): string | undefined {
  if (home && (p === home || p.startsWith(home + "/"))) return p.slice(home.length);
  if (p === "~" || p.startsWith("~/")) return p.slice(1);
  const user = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p);
  if (user) return user[1] ?? "";
  const root = /^\/root(\/.*)?$/.exec(p);
  return root ? (root[1] ?? "") : undefined;
}

/**
 * Maps one event's target to a class. Pure: no fs, no env, no clock. Rules run in schema 4.4 order, first match wins.
 * Output is a class only: a host for network, a binary for command, no path, file name or argument.
 */
export function classifyTarget(input: TargetInput): { class: TargetClass; family: TargetFamily } {
  let t = input.targetPath;
  if (t && URL_SCHEME.test(t)) {
    const file = fileUrlPath(t);
    if (file === undefined) {
      const host = urlHost(t);
      return { class: `network:${host ?? "other"}`, family: "network" };
    }
    t = file; // file:///home/a/.aws/credentials is a path: the secret, system and home rules decide
  }
  if (t && isSecretPath(t, input.home)) return { class: `secret:${secretLabel(t)}`, family: "secret" };
  if (t && TMP_ROOTS.some((r) => t === r || t.startsWith(r + "/"))) return { class: "tmp:/**", family: "tmp" };
  const sys = t && SYSTEM_ROOTS.find((r) => t === r || t.startsWith(r + "/"));
  if (sys) return { class: `system:${sys}/**`, family: "system" };
  const inProject = t ? projectRest(t, input) : undefined;
  if (t && inProject) {
    const name = seg(input.project ?? "");
    const slash = inProject.rest.indexOf("/");
    const dir = slash < 0 ? "" : inProject.rest.slice(0, slash);
    const shown = inProject.exact || COMMON_DIRS.has(dir) ? seg(dir) : "(other)";
    return { class: slash < 0 ? `project:${name}/*` : `project:${name}/${shown}/**`, family: "project" };
  }
  if (t && !t.startsWith("/") && !t.startsWith("~") && !t.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(t)) {
    const slash = t.indexOf("/");
    return { class: slash < 0 ? "project:(relative)/*" : `project:(relative)/${seg(t.slice(0, slash))}/**`, family: "project" };
  }
  const rest = t ? homeRest(t, input.home) : undefined;
  if (rest !== undefined) {
    const first = rest.replace(/^\/+/, "").split("/")[0] ?? "";
    return first.startsWith(".") ? { class: "home:dot/**", family: "home" } : { class: "home:other", family: "home" };
  }
  if (t) return { class: "absolute:other", family: "other" };
  const m = input.summary ? SHELL_SUMMARY.exec(input.summary) : null;
  if (m) {
    const token = m[1] ?? "";
    if (token.includes("://")) {
      const host = urlHost(token);
      return { class: `network:${host ?? "other"}`, family: "network" };
    }
    const bin = token.slice(token.lastIndexOf("/") + 1);
    return { class: `command:${BIN.test(bin) ? bin : "other"}`, family: "command" };
  }
  return { class: "none", family: "none" };
}
