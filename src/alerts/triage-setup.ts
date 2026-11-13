/**
 * One-time offer of security alerts with local triage, made by `kya start` (same pattern as
 * receipt/semantic-setup.ts). Alerts tell you when KYA detects a security incident (destructive change,
 * secret access, exfiltration, repeated denies). The optional local model adds a category, an urgency and a
 * suggested action to each alert. It runs offline after one download. Advisory: it never blocks anything.
 *
 * Asks once, in a terminal. Yes: installs the runtime and the model, turns alerts on in the USER-level config,
 * sends one test alert. No: remembered (alerts-choice.json), never asked again. Without a terminal: one hint line.
 * `KYA_ALERTS=on` installs without asking (scripts, images). `KYA_ALERTS=off` never asks.
 * Never fails `kya start`: any problem prints the manual command and moves on. Without the model, alerts still
 * work with the detector severity.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { kyaHome, globalConfigDir, readFileConfig } from "../config.js";
import { notifyIncident, resolveIncidentWebhooks, type NotifyFileConfig } from "../notify/index.js";
import { resolveAlertsConfig, writeAlertsEnabled } from "./config.js";
import { desktopNotify } from "./desktop.js";
import { buildTestIncidentAlert } from "./incident-alert.js";
import {
  TRIAGE_MODEL_HOST,
  TRIAGE_MODEL_MAX_BYTES,
  TRIAGE_MODEL_MB,
  TRIAGE_MODEL_SHA256,
  TRIAGE_MODEL_URL,
  TRIAGE_RUNTIME_PACKAGE,
  triageInstallCommand,
  triageInstalled,
  triageModelInstallPath,
  triageModelPresent,
  triageRuntimeDir,
  triageRuntimeInstalled,
} from "./triage-status.js";

const CHOICE_FILE = "alerts-choice.json";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Time to the response headers (connect and first byte). */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 10_000;
/** Longest silence while the body streams. */
const DOWNLOAD_READ_TIMEOUT_MS = 60_000;
/** A model file smaller than this is not a model (error page, empty body). */
const MIN_MODEL_BYTES = 1_000_000;

export interface TriageSetupIo {
  readonly error: (msg: string) => void;
  /** Test seam: force interactive / non-interactive. Defaults to "stdin and stderr are TTYs". */
  readonly isTty?: boolean;
  /** Test seam: returns the raw answer line. Defaults to a readline prompt on stdin/stderr. */
  readonly ask?: (question: string) => Promise<string>;
  /** Test seam: runtime install. Defaults to `npm install --prefix <dir> onnxruntime-node@<pinned>`. */
  readonly installRuntime?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail?: string }>;
  /** Test seam: model download. Defaults to the pinned object on models.shield-agent.com, sha256 checked. */
  readonly downloadModel?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail?: string }>;
  /** Test seam: the test alert. Defaults to a desktop notification plus the configured webhooks. */
  readonly testAlert?: (env: NodeJS.ProcessEnv) => Promise<{ desktop: boolean; webhooks: number }>;
}

/** installed: all on. partial: alerts on, local model missing (alerts use the detector severity). */
export type TriageSetupResult = "already" | "installed" | "partial" | "declined" | "skipped" | "hinted";

const NOTICE = [
  "Security alerts (optional).",
  "KYA tells you when it detects a security incident: a destructive change, secret access, data exfiltration or repeated denies.",
  `A small local model adds a category, an urgency and a next step to each alert. It runs fully offline after one download: about ${TRIAGE_MODEL_MB} MB for the model and about 100 MB for a local runtime. Nothing leaves this machine.`,
  "Alerts are advisory: local KYA never blocks because of them.",
];

function choicePath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), CHOICE_FILE);
}

function declinedBefore(env: NodeJS.ProcessEnv): boolean {
  try {
    return (JSON.parse(readFileSync(choicePath(env), "utf8")) as { answer?: unknown }).answer === "no";
  } catch {
    return false;
  }
}

function recordChoice(env: NodeJS.ProcessEnv, answer: "yes" | "no"): void {
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
    writeFileSync(choicePath(env), `${JSON.stringify({ answer, askedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    /* a lost answer only means we may ask again */
  }
}

/** Other platforms' native binaries are dead weight (about 200 MB). Removes them from our own runtime dir. */
function pruneOtherPlatforms(env: NodeJS.ProcessEnv): void {
  try {
    const bin = join(triageRuntimeDir(env), "node_modules", "onnxruntime-node", "bin");
    for (const napi of readdirSync(bin)) {
      for (const plat of readdirSync(join(bin, napi))) {
        if (plat !== process.platform) rmSync(join(bin, napi, plat), { recursive: true, force: true });
      }
    }
  } catch {
    /* pruning is only a size saving */
  }
}

/** `npm install --prefix <dir> onnxruntime-node@1.30.0`. Fixed arguments, no user text. */
export function installTriageRuntime(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail?: string }> {
  const dir = triageRuntimeDir(env);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return Promise.resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  const win = process.platform === "win32";
  return new Promise((resolve) => {
    execFile(
      win ? "npm.cmd" : "npm",
      // --ignore-scripts: the only install script of onnxruntime-node downloads CUDA binaries on Linux x64 (hundreds of MB). The CPU binary is bundled.
      ["install", "--prefix", win ? `"${dir}"` : dir, "--no-audit", "--no-fund", "--ignore-scripts", TRIAGE_RUNTIME_PACKAGE],
      { env: { ...env, ONNXRUNTIME_NODE_INSTALL: "skip" }, timeout: INSTALL_TIMEOUT_MS, windowsHide: true, shell: win },
      (err, _stdout, stderr) => {
        if (err) return resolve({ ok: false, detail: (String(stderr).trim().split("\n").pop() || err.message).slice(0, 200) });
        pruneOtherPlatforms(env);
        resolve({ ok: triageRuntimeInstalled(env) });
      },
    );
  });
}

/**
 * What `downloadModelFrom` needs. The product never builds this from the environment: `downloadTriageModel` passes the
 * pinned URL and nothing else. The other fields exist so tests can drive the download with a loopback server, a fake
 * fetch, a small cap and short timeouts.
 */
export interface DownloadSource {
  readonly url: string;
  /** Default: `modelUrlRefusal` (https, the one host). A test passes its own to reach a loopback server. */
  readonly refusal?: (url: string) => string | undefined;
  readonly fetch?: typeof fetch;
  /** Default: the pinned sha256. */
  readonly sha256?: string;
  readonly maxBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly readTimeoutMs?: number;
}

/** https, exactly the model host, default port, no credentials. No exception for any other host or scheme. */
export function modelUrlRefusal(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "model URL is not valid";
  }
  if (u.protocol !== "https:") return "model URL must use https";
  if (u.hostname !== TRIAGE_MODEL_HOST || u.port !== "" || u.username !== "" || u.password !== "") return `model URL must be on ${TRIAGE_MODEL_HOST}`;
  return undefined;
}

/**
 * Download the pinned model once. The URL is a constant: no environment variable or option changes it
 * (`KYA_TRIAGE_MODEL_URL` is ignored).
 */
export function downloadTriageModel(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail?: string }> {
  return downloadModelFrom(env, { url: TRIAGE_MODEL_URL });
}

/**
 * The download, for any source (tests). Rules: https only, one host, redirects are never followed (a 3xx is a failure), the
 * response must declare a Content-Length of at most 200 MB, the stream is cut off past the cap, the bytes are
 * hashed while they are written to a temp file next to the target, and only a file with the pinned sha256 is
 * renamed into place (atomic). The temp file is removed on any failure. Timeouts: 10 s to the headers, 60 s of
 * silence while streaming.
 */
export async function downloadModelFrom(env: NodeJS.ProcessEnv, deps: DownloadSource): Promise<{ ok: boolean; detail?: string }> {
  const target = triageModelInstallPath(env);
  const tmp = `${target}.${randomBytes(8).toString("hex")}.part`;
  const abort = new AbortController();
  const cap = deps.maxBytes ?? TRIAGE_MODEL_MAX_BYTES;
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number, what: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error(what)), ms);
  };
  try {
    const url = deps.url;
    const refusal = (deps.refusal ?? modelUrlRefusal)(url);
    if (refusal) return { ok: false, detail: refusal };
    mkdirSync(dirname(target), { recursive: true });
    arm(deps.connectTimeoutMs ?? DOWNLOAD_CONNECT_TIMEOUT_MS, "download timed out (no answer in 10 s)");
    const res = await (deps.fetch ?? fetch)(url, { redirect: "manual", signal: abort.signal });
    if (res.status >= 300 && res.status < 400) return { ok: false, detail: `download refused: redirect (HTTP ${res.status}) is not followed` };
    if (!res.ok || !res.body) return { ok: false, detail: `download failed (HTTP ${res.status})` };
    const declared = res.headers.get("content-length");
    if (declared === null || !/^\d{1,12}$/.test(declared)) return { ok: false, detail: "download refused: no Content-Length" };
    if (Number(declared) > cap) return { ok: false, detail: "download refused: file is larger than 200 MB" };
    const hash = createHash("sha256");
    let bytes = 0;
    // pipeline closes both ends and passes any stream error on, so a broken write cannot crash the process.
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > cap) return cb(new Error("download aborted: more than 200 MB"));
          arm(deps.readTimeoutMs ?? DOWNLOAD_READ_TIMEOUT_MS, "download timed out (no data for 60 s)");
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp, { mode: 0o600 }),
      { signal: abort.signal },
    );
    const want = (deps.sha256 ?? TRIAGE_MODEL_SHA256).toLowerCase();
    if (hash.digest("hex") !== want) {
      rmSync(tmp, { force: true });
      return { ok: false, detail: "sha256 does not match the pinned value: file refused" };
    }
    if (bytes < MIN_MODEL_BYTES) {
      rmSync(tmp, { force: true });
      return { ok: false, detail: "model file is too small: refused" };
    }
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    const reason = abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : err;
    return { ok: false, detail: (reason instanceof Error ? reason.message : String(reason)).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(tmp, { force: true });
  }
}

/** Desktop notification plus every configured incident webhook, marked as a test. */
export async function sendTestAlert(env: NodeJS.ProcessEnv): Promise<{ desktop: boolean; webhooks: number }> {
  const alert = buildTestIncidentAlert();
  const desktop = resolveAlertsConfig(env).desktop ? await desktopNotify(alert, env) : false;
  const targets = resolveIncidentWebhooks(readFileConfig(kyaHome(env)) as NotifyFileConfig);
  const webhooks = targets.length > 0 ? await notifyIncident(alert, targets, env) : 0;
  return { desktop, webhooks };
}

function defaultAsk(question: string): Promise<string> {
  return new Promise((resolve) => {
    // Prompt on stderr so stdout stays clean for anything piping the command's output.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runInstall(io: TriageSetupIo, env: NodeJS.ProcessEnv): Promise<TriageSetupResult> {
  io.error("Turning on security alerts. The local model download can take a few minutes...");
  const wasOn = (readFileConfig(kyaHome(env)) as { alerts?: { enabled?: unknown } }).alerts?.enabled === true;
  let modelOk = true;
  let installedNow = false;
  if (!triageRuntimeInstalled(env)) {
    const r = await (io.installRuntime ?? installTriageRuntime)(env);
    if (!r.ok) {
      modelOk = false;
      io.error(`Could not install the local runtime${r.detail ? ` (${r.detail})` : ""}.`);
    } else installedNow = true;
  }
  if (modelOk && !triageModelPresent(env)) {
    const r = await (io.downloadModel ?? downloadTriageModel)(env);
    if (!r.ok) {
      modelOk = false;
      io.error(`Could not get the local model${r.detail ? ` (${r.detail})` : ""}.`);
    } else installedNow = true;
  }
  try {
    writeAlertsEnabled(env, true);
  } catch (err) {
    io.error(`Could not write the alerts setting (${err instanceof Error ? err.message : String(err)}). Try later: ${triageInstallCommand()}`);
    return "partial";
  }
  if (modelOk) io.error("Security alerts are on, with local triage.");
  else io.error(`Security alerts are on with the detector severity only. Add the local model later: ${triageInstallCommand()}`);
  // KYA_ALERTS=on runs this on every start while the model is missing: send the test alert only when this run changed something.
  if (wasOn && !installedNow) return modelOk ? "installed" : "partial";
  try {
    const t = await (io.testAlert ?? sendTestAlert)(env);
    const where = [t.desktop ? "a desktop notification" : "", t.webhooks > 0 ? `${t.webhooks} webhook(s)` : ""].filter(Boolean);
    io.error(where.length > 0 ? `Sent a test alert: ${where.join(" and ")}.` : "No desktop notifier found and no webhook set: alerts show in the report only.");
  } catch {
    /* a failed test alert does not change anything else */
  }
  return modelOk ? "installed" : "partial";
}

export async function maybeOfferTriageAlerts(io: TriageSetupIo, env: NodeJS.ProcessEnv): Promise<TriageSetupResult> {
  const mode = env.KYA_ALERTS?.trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return "skipped";
  if (triageInstalled(env)) return "already";
  if (mode === "on" || mode === "1" || mode === "true") return runInstall(io, env);
  // An explicit user-level choice (`kya alerts on|off`) is a decision: do not ask.
  if (resolveAlertsConfig(env).source === "config" || declinedBefore(env)) return "skipped";

  const interactive = io.isTty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive) {
    io.error(`Security alerts are off. Turn them on: ${triageInstallCommand()}`);
    return "hinted";
  }

  for (const line of NOTICE) io.error(line);
  const answer = await (io.ask ?? defaultAsk)("Turn on security alerts? [Y/n]");
  const no = /^n(o)?$/i.test(answer.trim());
  recordChoice(env, no ? "no" : "yes");
  if (no) {
    io.error(`No problem. Turn it on later: ${triageInstallCommand()}`);
    return "declined";
  }
  return runInstall(io, env);
}
