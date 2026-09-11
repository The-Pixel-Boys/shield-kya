/**
 * Clipped, redacted change preview for the activity receipt.
 * Never persists full patches — hard caps + redaction only.
 */
import { redactTrailText } from "./trail-summary.js";

export const DIFF_MAX_LINES = 8;
export const DIFF_MAX_LINE_CHARS = 72;
export const DIFF_MAX_TOTAL_CHARS = 480;
export const DIFF_MAX_INPUT_CHARS = 8 * 1024;

const WRITE_TOKENS = new Set([
  "write",
  "edit",
  "patch",
  "apply_diff",
  "applydiff",
  "applypatch",
  "apply_patch",
]);

const SHELL_TOKENS = new Set(["shell", "bash", "exec", "run", "command", "cmd"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function argString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function toolTokens(toolId: string): string[] {
  return toolId
    .toLowerCase()
    .split(/[./_-]+/)
    .filter(Boolean);
}

function isShellLike(toolId: string): boolean {
  return toolTokens(toolId).some((t) => SHELL_TOKENS.has(t));
}

function isWriteLike(toolId: string): boolean {
  const tokens = toolTokens(toolId);
  return tokens.some((t) => WRITE_TOKENS.has(t));
}

function isPatchTool(toolId: string): boolean {
  const id = toolId.toLowerCase();
  return (
    isWriteLike(toolId) ||
    /apply[_-]?diff|apply[_-]?patch/.test(id) ||
    toolTokens(toolId).includes("edit")
  );
}

function clipLine(line: string): string {
  const flat = line.replace(/\r/g, "").replace(/\t/g, " ");
  if (flat.length <= DIFF_MAX_LINE_CHARS) return flat;
  return `${flat.slice(0, DIFF_MAX_LINE_CHARS - 1)}…`;
}

/** Length-cap without flattening newlines (unlike dash `clip`). */
export function clipMultiline(text: string, max = DIFF_MAX_TOTAL_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function takeInput(s: string): string {
  if (s.length <= DIFF_MAX_INPUT_CHARS) return s;
  return s.slice(0, DIFF_MAX_INPUT_CHARS);
}

function containsPem(blob: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/i.test(
    blob,
  );
}

function prepareLines(rawLines: string[]): string {
  const out: string[] = [];
  let redactedCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    if (out.length >= DIFF_MAX_LINES) {
      const remaining = rawLines.length - i;
      const foot = `\n… (+${remaining} lines truncated)`;
      let text = out.join("\n");
      text = clipMultiline(text, DIFF_MAX_TOTAL_CHARS);
      if (redactedCount > 1) {
        text = `${text}\n… (+${redactedCount} redacted)`;
      }
      return `${text}${foot}`.trim();
    }
    const raw = rawLines[i] ?? "";
    let line = redactTrailText(clipLine(raw));
    if (!line.trim() || line.trim() === "[redacted]" || line.includes("[redacted")) {
      redactedCount += 1;
      if (out.some((l) => l.includes("[redacted]"))) {
        continue;
      }
      line = "[redacted]";
    }
    out.push(line);
  }

  let text = out.join("\n");
  text = clipMultiline(text, DIFF_MAX_TOTAL_CHARS);
  if (redactedCount > 1) {
    text = `${text}\n… (+${redactedCount} redacted)`;
  }
  return text.trim() ? text : "";
}

function snippetFromContent(content: string): string[] {
  const body = takeInput(content);
  const lines = body.split(/\n/);
  if (lines.length <= 4) {
    return lines.map((l) => `  ${l}`);
  }
  const head = lines.slice(0, 3).map((l) => `  ${l}`);
  const last = lines[lines.length - 1] ?? "";
  return [
    ...head,
    `  …`,
    `  ${last}`,
    `  (+${lines.length} lines, ${content.length} chars)`,
  ];
}

function hunkFromEdit(oldStr: string, newStr: string): string[] {
  const oldLines = takeInput(oldStr).split(/\n/).slice(0, 4);
  const newLines = takeInput(newStr).split(/\n/).slice(0, 4);
  const out: string[] = [];
  for (const l of oldLines) out.push(`-${l}`);
  for (const l of newLines) out.push(`+${l}`);
  return out;
}

function linesFromPatch(patch: string): string[] {
  const body = takeInput(patch);
  const lines = body
    .split(/\n/)
    .filter((l) => l.length > 0)
    .filter((l) => /^[+\-@ ]/.test(l) || l.startsWith("diff ") || l.startsWith("index "));
  if (lines.length === 0) {
    return ["[diff omitted: unrecognized format]"];
  }
  return lines.slice(0, DIFF_MAX_LINES + 4);
}

/**
 * Derive a clipped redacted preview for the receipt.
 * Returns undefined when there is nothing useful/safe to show.
 */
export function deriveDiffPreview(
  toolId: string,
  args?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const flag = (env.KYA_DIFF_PREVIEW ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return undefined;
  }
  if (args == null || !isPlainObject(args)) {
    return undefined;
  }
  // Shell/exec never get a change preview (even if a diff field is present).
  if (isShellLike(toolId)) {
    return undefined;
  }

  const oldStr = argString(args, "old_string", "oldString");
  const newStr = argString(args, "new_string", "newString");
  const diff = argString(args, "diff");
  const patch = argString(args, "patch");

  if (!isWriteLike(toolId) && !diff && !patch && !(oldStr && newStr)) {
    return undefined;
  }

  // Path-less create_todo / PutObject-style noise: require a path-like key for content snippets
  // unless we have an explicit edit/patch payload.
  const pathLike = argString(
    args,
    "path",
    "file",
    "filepath",
    "file_path",
    "filePath",
    "target",
  );

  let rawBlob = "";
  let rawLines: string[] | undefined;

  if (oldStr && newStr) {
    rawBlob = `${oldStr}\n${newStr}`;
    rawLines = hunkFromEdit(oldStr, newStr);
  } else if (diff && isPatchTool(toolId)) {
    rawBlob = diff;
    rawLines = linesFromPatch(diff);
  } else if (patch && isPatchTool(toolId)) {
    rawBlob = patch;
    rawLines = linesFromPatch(patch);
  } else if (isWriteLike(toolId) && pathLike) {
    const body = argString(args, "content", "text", "code", "body", "contents", "file_text", "new_contents");
    if (body) {
      rawBlob = body;
      rawLines = snippetFromContent(body);
    }
  } else if (diff || patch) {
    // Non-patch tools must not honor stray diff fields.
    return undefined;
  }

  if (!rawLines || rawLines.length === 0) return undefined;

  // Full-blob PEM collapse before per-line work.
  if (containsPem(rawBlob) || containsPem(rawLines.join("\n"))) {
    return "[redacted-pem]";
  }

  const prepared = prepareLines(rawLines);
  return prepared || undefined;
}
