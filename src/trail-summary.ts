/**
 * Short human summary for trail/receipt.
 * Picks safe fields (path / shell bin / size hint), runs redactEvidence, clips to 80 chars.
 * Never serializes full args or body/content values.
 */
import { redactEvidence } from "./orr/agentshield.js";

const MAX_LEN = 80;

const PATH_KEYS = [
  "path",
  "file",
  "filepath",
  "file_path",
  "filePath",
  "target",
  "uri",
  "url",
  "destination",
  "dest",
] as const;

const CMD_KEYS = ["command", "cmd", "script", "shell", "argv"] as const;

const OP_KEYS = ["op", "operation", "action", "method", "mode"] as const;

/** Exact keys we never surface as values (bodies + common secret names). */
const SKIP_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "content",
  "body",
  "data",
  "text",
  "code",
  "diff",
  "patch",
  "payload",
  "raw",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "client_secret",
  "clientsecret",
  "private_key",
  "privatekey",
  "credential",
  "credentials",
]);

const SENSITIVE_KEY_RE =
  /(secret|token|password|passwd|credential|authorization|apikey|api[_-]?key|private[_-]?key)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SKIP_KEYS.has(lower) || SENSITIVE_KEY_RE.test(lower);
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    if (isSensitiveKey(k)) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      const joined = v.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
    // Nested { file: { path: "..." } }
    if (isPlainObject(v)) {
      const nested = pickString(v, PATH_KEYS);
      if (nested) return nested;
    }
  }
  return undefined;
}

function toolVerb(toolId: string): string {
  const last = toolId.split(/[./]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  if (/^(write|edit|update|create|put|patch|delete|rm|remove|exec|run|shell|read|checkout)$/.test(last)) {
    return last === "exec" || last === "run" ? "shell" : last;
  }
  const id = toolId.toLowerCase();
  if (id.includes("shell") || id.includes("exec")) return "shell";
  if (id.includes("write") || id.includes("edit")) return "write";
  if (id.includes("delete") || /\.rm\b/.test(id)) return "delete";
  if (id.includes("read")) return "read";
  return "";
}

function contentHint(obj: Record<string, unknown>): string | undefined {
  for (const k of ["content", "body", "text", "code", "diff", "patch", "data"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return `${v.length} chars`;
    if (Buffer.isBuffer(v)) return `${v.length} bytes`;
  }
  return undefined;
}

/** Strip query/fragment from URLs before they enter the summary. */
export function scrubUrl(value: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      const u = new URL(value);
      u.search = "";
      u.hash = "";
      // Drop userinfo (user:pass@host)
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    /* not a URL */
  }
  return value.replace(/([?&#][^=\s]*=)[^&\s#]+/g, "$1[redacted]");
}

/**
 * Shell lines: keep bin + arg count only — never the full command
 * (env assignments, -p passwords, Basic auth headers).
 */
export function summarizeShellCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return "shell";
  // Space-free URL masquerading as a "command" — scrub query before binning.
  if (!/\s/.test(trimmed) && (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /[?&#].*=/.test(trimmed))) {
    return finalize([`shell`, pathLike(trimmed)]) ?? "shell";
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  // Skip leading ENV=value assignments
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  let bin = tokens[i] ?? "cmd";
  if (/^[a-z][a-z0-9+.-]*:/i.test(bin) || /[?&#].*=/.test(bin)) {
    bin = pathLike(bin);
  }
  const rest = Math.max(0, tokens.length - i - 1);
  const shortBin = bin.length > 48 ? `${bin.slice(0, 47)}…` : bin;
  return rest > 0 ? `shell ${shortBin} (+${rest} args)` : `shell ${shortBin}`;
}

/** Shared redaction for trail summary + diff preview lines. */
export function redactTrailText(s: string): string {
  let out = redactEvidence(s);
  // Collapse full PEM blocks before any line-oriented use.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    "[redacted-pem]",
  );
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=_-]{4,}/gi, "Basic [redacted]");
  out = out.replace(/\bCookie:\s*[^\s;]+(?:;\s*[^\s;]+)*/gi, "[redacted-cookie]");
  out = out.replace(/\bsession=[^\s;&]+/gi, "session=[redacted]");
  out = out.replace(
    /([?&#](?:access_token|api[_-]?key|token|secret|password|auth|sid)=)[^&\s#]+/gi,
    "$1[redacted]",
  );
  // Case-insensitive credential assignments (password=…, api_key: …, etc.)
  out = out.replace(
    /\b(password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\s*([:=])\s*([^\s#"']+)/gi,
    "$1$2[redacted]",
  );
  out = out.replace(/\b[A-Z][A-Z0-9_]{2,}=(('[^']*')|("[^"]*")|\S+)/g, (m) => {
    const name = m.split("=")[0] ?? "";
    if (SENSITIVE_KEY_RE.test(name) || /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(name)) {
      return `${name}=[redacted]`;
    }
    return m;
  });
  out = out.replace(/(?:^|\s)(-p|--password|--passwd|--token|--secret|--api-key)(\s+|=)\S+/gi, " $1=[redacted]");
  return out;
}

/** Keys allowed in the free-form string fallback (never header/env blobs). */
const SAFE_FALLBACK_KEYS = new Set([
  "name",
  "title",
  "label",
  "id",
  "ref",
  "branch",
  "repo",
  "message",
  "note",
  "description",
]);

function finalize(parts: string[]): string | undefined {
  const raw = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!raw) return undefined;
  const redacted = redactTrailText(raw).replace(/\r?\n/g, " ").trim();
  if (!redacted) return undefined;
  if (redacted.length <= MAX_LEN) return redacted;
  return `${redacted.slice(0, MAX_LEN - 1)}…`;
}

function pathLike(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /[?&#].*=/.test(value)) {
    return scrubUrl(value);
  }
  return value;
}

/**
 * Derive a one-line change summary for the activity feed.
 * Returns undefined when there is nothing safe/useful to show.
 */
export function deriveTrailSummary(toolId: string, args?: unknown): string | undefined {
  const verb = toolVerb(toolId);

  if (args == null) {
    return undefined;
  }

  if (typeof args === "string") {
    // Treat bare strings as opaque — only length, avoid dumping secrets.
    return finalize([verb || "args", `(${args.length} chars)`]);
  }

  if (typeof args === "number" || typeof args === "boolean") {
    return finalize([verb || "args", String(args)]);
  }

  if (Array.isArray(args)) {
    // Argv-style: summarize as shell bin + count
    if (args.every((x) => typeof x === "string")) {
      return finalize([summarizeShellCommand(args.join(" "))]);
    }
    return finalize([verb || "args", `(${args.length} items)`]);
  }

  if (!isPlainObject(args)) {
    return undefined;
  }

  const path = pickString(args, PATH_KEYS);
  const cmd = pickString(args, CMD_KEYS);
  const op = pickString(args, OP_KEYS);
  const hint = contentHint(args);

  if (cmd) {
    return finalize([summarizeShellCommand(cmd)]);
  }

  if (path) {
    const head = op || verb || "touch";
    const safePath = pathLike(path);
    return finalize(hint ? [head, safePath, `(${hint})`] : [head, safePath]);
  }

  for (const [k, v] of Object.entries(args)) {
    if (!SAFE_FALLBACK_KEYS.has(k.toLowerCase())) continue;
    if (isSensitiveKey(k)) continue;
    if (typeof v === "string" && v.trim() && v.length <= 120) {
      return finalize([verb || k, pathLike(v.trim())]);
    }
  }

  if (hint) {
    return finalize([verb || "args", hint]);
  }

  // Args present but nothing safe to show
  const keys = Object.keys(args);
  if (keys.length > 0) {
    return finalize(["(no safe summary)"]);
  }

  return undefined;
}
