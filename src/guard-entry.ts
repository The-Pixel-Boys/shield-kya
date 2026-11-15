/**
 * Entry point of plugins/kya-guard/dist/guard.mjs.
 *   node guard.mjs --host claude   hook mode: PreToolUse JSON on stdin, verdict on stdout/stderr, exit 0 or 2
 *   --host codex|cursor|copilot|gemini   same bundle for those hosts: their payload in, their deny body out, ask becomes deny
 *   node guard.mjs --status        text for /kya-guard:status
 *   node guard.mjs --card [--id x] write the near-miss card (SVG) for the last denied call and print its caption (/kya-guard:share)
 * The hook never exits 1: any failure lets the call through (see guard-lite.ts).
 */
import { guardCard, guardStatus, runGuard } from "./guard-lite.js";

/** The host never closing stdin would hold the hook: decide on what arrived. Under the host's 5 s limit. */
const STDIN_TIMEOUT_MS = 3_000;

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("error", done);
    process.stdin.on("end", done);
  });
}

async function main(): Promise<void> {
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  if (process.argv.includes("--status")) {
    process.stdout.write(guardStatus(process.env));
    return;
  }
  if (process.argv.includes("--card")) {
    const i = process.argv.indexOf("--id");
    const r = guardCard(process.env, i > 0 ? process.argv[i + 1] : undefined);
    await new Promise<void>((ok) => process.stdout.write(r.text, () => ok()));
    process.exitCode = r.exitCode;
    return;
  }
  const at = process.argv.indexOf("--host");
  const r = runGuard({ stdinText: await readStdin(), env: process.env, cwd: process.cwd(), host: at > 0 ? process.argv[at + 1] : undefined });
  if (r.stdout) await new Promise<void>((ok) => process.stdout.write(r.stdout, () => ok()));
  if (r.stderr) await new Promise<void>((ok) => process.stderr.write(r.stderr, () => ok()));
  process.exitCode = r.exitCode;
}

main().then(
  () => process.exit(),
  () => process.exit(0),
);
