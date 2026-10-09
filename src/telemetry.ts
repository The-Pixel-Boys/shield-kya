/**
 * Opt-in anonymous usage telemetry (`kya telemetry`). Off until the user says yes.
 *
 * What it is: a start / heartbeat / end beacon from the LONG-LIVED KYA processes (MCP gate over
 * stdio or http, the report daemon, the gateway supervisor) so the maintainers can see how many
 * installs are live, which versions and platforms run, and how long sessions last.
 *
 * `kya hook` is spawn-per-tool-call and stays network-free: when the user opted in, it spawns a
 * detached helper (`kya telemetry ping`) at most once a day and returns immediately, so installs that
 * only use hooks still show up as active. The hook itself never waits on the network. The beacon is
 * not imported by the SDK surface (`src/sdk`), which promises no telemetry or network clients.
 *
 * Hard rules (see docs/telemetry.md):
 *  - consent is an explicit `y`/`yes` (default NO), asked once, interactive terminals only, on
 *    stderr, never in `--json` mode and never from an MCP stdio process (stdout is its protocol);
 *  - nothing is sent in CI or when DO_NOT_TRACK / KYA_TELEMETRY=0 is set;
 *  - the payload is a fixed allow-list (see {@link buildPayload}); no paths, names, args, prompts;
 *  - a failed send never affects the CLI: short timeout, errors swallowed on purpose, three
 *    consecutive failures stop the beacon for the rest of the process.
 *
 * `KYA_OFFLINE` deliberately does NOT block telemetry: it is documented as "sample evaluate", and
 * `kya connect` writes KYA_OFFLINE=1 into every MCP host config, so honouring it would silence every
 * session a connected host launches even for someone who answered yes.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { globalConfigDir, resolveGateMode } from "./config.js";
import { atomicWriteSync } from "./fs-atomic.js";
import { CLI_VERSION } from "./version.js";

export type TelemetrySurface = "mcp-stdio" | "mcp-http" | "report" | "gateway" | "hook";
export type TelemetryEventKind = "start" | "heartbeat" | "end" | "ping";

export interface TelemetryState {
  /** true = opted in, false = opted out, undefined = never answered. */
  readonly enabled?: boolean;
  /** Random UUID, created only when the user opts in. Never derived from the machine or user. */
  readonly installId?: string;
  /** When the question was answered; its presence means "do not ask again". */
  readonly askedAt?: string;
}

export interface TelemetryPayload {
  readonly schema: 1;
  readonly installId: string;
  readonly sessionId: string;
  readonly event: TelemetryEventKind;
  readonly surface: TelemetrySurface;
  readonly cliVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly nodeMajor: number;
  readonly hostId: string;
  readonly gateMode: string;
  readonly hostedLinked: boolean;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>;

export const DEFAULT_TELEMETRY_ENDPOINT = "https://shield-agent.com/api/v1/telemetry/kya";
const SEND_TIMEOUT_MS = 3_000;
const DEFAULT_HEARTBEAT_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFF_RE = /^(0|false|no|off)$/i;

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value.trim() !== "" && !OFF_RE.test(value.trim());

// ---------------------------------------------------------------------------------------------
// State (~/.kya/telemetry.json)
// ---------------------------------------------------------------------------------------------

export function telemetryStatePath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), "telemetry.json");
}

/** Tolerant read: a missing, corrupt or hand-edited file is "never asked", never an error. */
export function readTelemetryState(env: NodeJS.ProcessEnv): TelemetryState {
  try {
    const raw = JSON.parse(readFileSync(telemetryStatePath(env), "utf8")) as Record<string, unknown>;
    return {
      ...(typeof raw["enabled"] === "boolean" ? { enabled: raw["enabled"] } : {}),
      ...(typeof raw["installId"] === "string" && UUID_RE.test(raw["installId"])
        ? { installId: raw["installId"].toLowerCase() }
        : {}),
      ...(typeof raw["askedAt"] === "string" ? { askedAt: raw["askedAt"] } : {}),
    };
  } catch {
    return {};
  }
}

export function writeTelemetryState(env: NodeJS.ProcessEnv, state: TelemetryState): void {
  mkdirSync(globalConfigDir(env), { recursive: true, mode: 0o700 });
  atomicWriteSync(telemetryStatePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

/** Why telemetry is forced off for THIS process regardless of the saved answer, or undefined. */
export function telemetryDisabledReason(env: NodeJS.ProcessEnv): string | undefined {
  if (truthy(env["DO_NOT_TRACK"])) return "DO_NOT_TRACK is set";
  if (env["KYA_TELEMETRY"] !== undefined && OFF_RE.test(env["KYA_TELEMETRY"].trim())) {
    return "KYA_TELEMETRY is off";
  }
  if (truthy(env["CI"]) || env["GITHUB_ACTIONS"] === "true") return "running in CI";
  return undefined;
}

/** True only when the user opted in AND nothing overrides it for this process. */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  if (telemetryDisabledReason(env) !== undefined) return false;
  const state = readTelemetryState(env);
  return state.enabled === true && state.installId !== undefined;
}

/** https, or http on a loopback host (tests, self-hosting). Anything else falls back to the default. */
export function telemetryEndpoint(env: NodeJS.ProcessEnv): string {
  const raw = env["KYA_TELEMETRY_URL"]?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      const credentials = url.username !== "" || url.password !== "";
      if (!credentials && (url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
        return url.toString();
      }
    } catch {
      /* unparsable override: use the default */
    }
  }
  return DEFAULT_TELEMETRY_ENDPOINT;
}

function eraseEndpoint(env: NodeJS.ProcessEnv): string {
  return `${telemetryEndpoint(env).replace(/\/+$/, "")}/erase`;
}

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

/** Host registry slug from the session id `kya connect` writes (`mcp:<host>`), else "unknown". */
export function telemetryHostId(env: NodeJS.ProcessEnv): string {
  const match = /^mcp:([a-z][a-z0-9-]{0,31})$/.exec(env["KYA_SESSION_ID"] ?? "");
  return match?.[1] ?? "unknown";
}

/**
 * The ONLY fields that ever leave the machine. A test pins this exact key set; adding a field here
 * is a privacy change that needs the server validator, docs/telemetry.md and the privacy page updated.
 */
export function buildPayload(input: {
  readonly installId: string;
  readonly sessionId: string;
  readonly event: TelemetryEventKind;
  readonly surface: TelemetrySurface;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): TelemetryPayload {
  return {
    schema: 1,
    installId: input.installId,
    sessionId: input.sessionId,
    event: input.event,
    surface: input.surface,
    cliVersion: CLI_VERSION,
    os: process.platform,
    arch: process.arch,
    nodeMajor: Number.parseInt(process.versions.node, 10),
    hostId: telemetryHostId(input.env),
    gateMode: resolveGateMode({ cwd: input.cwd, env: input.env }),
    hostedLinked: (input.env["KYA_API_KEY"] ?? "").trim() !== "",
  };
}

/**
 * POST one JSON body. Returns whether the server accepted it. Never throws: telemetry must not be
 * able to change what the CLI does, so every failure (network, timeout, redirect, non-2xx) is just
 * `false`. The deliberate swallow is the whole point of this function.
 */
export async function postTelemetry(
  url: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `shield-agent-kya-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Session beacon (start / heartbeat / end)
// ---------------------------------------------------------------------------------------------

export interface SessionBeacon {
  /** Sends `end` (bounded by the send timeout) and stops the heartbeat. Idempotent. */
  stop(): Promise<void>;
}

const NOOP_BEACON: SessionBeacon = { stop: async () => {} };

function heartbeatMs(env: NodeJS.ProcessEnv, override: number | undefined): number {
  if (override !== undefined) return override;
  // Test/diagnostic knob, clamped so a typo cannot turn the beacon into a flood.
  const raw = Number(env["KYA_TELEMETRY_INTERVAL_MS"]);
  return Number.isFinite(raw) && raw >= 100 && raw <= 3_600_000 ? raw : DEFAULT_HEARTBEAT_MS;
}

/**
 * Start reporting for one long-lived process. A no-op unless the user opted in and nothing overrides
 * it. Writes NOTHING to stdout or stderr (an MCP stdio process owns stdout as its protocol channel).
 */
export function startSessionBeacon(
  surface: TelemetrySurface,
  deps: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly fetchImpl?: FetchLike;
    readonly intervalMs?: number;
  },
): SessionBeacon {
  if (!isTelemetryEnabled(deps.env)) return NOOP_BEACON;
  const installId = readTelemetryState(deps.env).installId as string;
  const sessionId = randomUUID();
  const url = telemetryEndpoint(deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let failures = 0;
  let stopped = false;

  const send = async (event: TelemetryEventKind): Promise<void> => {
    if (failures >= MAX_CONSECUTIVE_FAILURES) return;
    const ok = await postTelemetry(
      url,
      buildPayload({ installId, sessionId, event, surface, env: deps.env, cwd: deps.cwd }),
      fetchImpl,
    );
    failures = ok ? 0 : failures + 1;
  };

  void send("start");
  const timer = setInterval(() => {
    void send("heartbeat");
  }, heartbeatMs(deps.env, deps.intervalMs));
  timer.unref();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await send("end");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Hook ping (hook-only installs have no long-lived process to heartbeat from)
// ---------------------------------------------------------------------------------------------

/** At most one ping per this window, however many tool calls fire the hook. */
export const HOOK_PING_INTERVAL_MS = 24 * 60 * 60_000;

/** Its mtime is the time of the last ping attempt. Content is empty: nothing to leak or corrupt. */
export function hookPingStampPath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), "telemetry-ping");
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean },
) => { unref(): void; on(event: "error", listener: () => void): unknown };

/**
 * Claims today's ping slot: true for exactly one caller per interval. A fresh stamp means someone
 * already did; a stale one is removed and re-created with an exclusive create (`wx`), so of several
 * hooks racing on a stale stamp only the one whose create succeeds gets the slot.
 */
export function claimHookPingSlot(env: NodeJS.ProcessEnv, nowMs: number = Date.now()): boolean {
  const stamp = hookPingStampPath(env);
  try {
    if (nowMs - statSync(stamp).mtimeMs < HOOK_PING_INTERVAL_MS) return false;
    unlinkSync(stamp);
  } catch {
    /* no stamp yet, or another hook removed it first: fall through to the exclusive create */
  }
  mkdirSync(globalConfigDir(env), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(stamp, "", { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST: another hook won the race
  }
}

/**
 * Called by `kya hook` after it has produced its answer. Cheap on the hot path: when telemetry is off
 * or a ping already went out today this is one file read and one stat. Otherwise it claims the day's
 * slot (see {@link claimHookPingSlot}) and starts the helper detached with ignored stdio, so the
 * hook's stdout, stderr and exit code are untouched and it never waits. `host` is the hook's `--host`
 * (claude, grok, ...), handed to the helper so the host mix stays meaningful for hook-only installs.
 * A failed ping is not retried until tomorrow: a spawn storm while offline would be worse than a gap.
 * Never throws. Returns whether a helper was started.
 */
export function maybeSpawnHookPing(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly host?: string;
  readonly entry?: string;
  readonly spawnImpl?: SpawnLike;
  readonly nowMs?: number;
}): boolean {
  try {
    if (!isTelemetryEnabled(deps.env)) return false;
    const entry = deps.entry ?? process.argv[1];
    if (entry === undefined) return false; // before claiming: a skipped spawn must not burn the day's slot
    if (!claimHookPingSlot(deps.env, deps.nowMs)) return false;
    const helperEnv =
      deps.host !== undefined && /^[a-z][a-z0-9-]{0,31}$/.test(deps.host) && deps.env["KYA_SESSION_ID"] === undefined
        ? { ...deps.env, KYA_SESSION_ID: `mcp:${deps.host}` } // the form telemetryHostId reads
        : deps.env;
    const child = (deps.spawnImpl ?? (spawn as unknown as SpawnLike))(
      process.execPath,
      [entry, "telemetry", "ping"],
      { detached: true, stdio: "ignore", env: helperEnv, cwd: deps.cwd, windowsHide: true },
    );
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The helper's job (`kya telemetry ping`): one `ping` as surface `hook`, same gates as every beacon. */
export async function sendHookPing(
  env: NodeJS.ProcessEnv,
  cwd: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  if (!isTelemetryEnabled(env)) return false;
  const installId = readTelemetryState(env).installId as string;
  return postTelemetry(
    telemetryEndpoint(env),
    buildPayload({ installId, sessionId: randomUUID(), event: "ping", surface: "hook", env, cwd }),
    fetchImpl,
  );
}

// ---------------------------------------------------------------------------------------------
// Consent prompt
// ---------------------------------------------------------------------------------------------

export interface ConsentIo {
  readonly error: (msg: string) => void;
  /** Test seam: force interactive / non-interactive. Defaults to "stdin and stderr are TTYs". */
  readonly isTty?: boolean;
  /** Test seam: returns the raw answer line. Defaults to a readline prompt on stdin/stderr. */
  readonly ask?: (question: string) => Promise<string>;
}

export const CONSENT_NOTICE = [
  "Share anonymous usage stats to help improve KYA?",
  "  Sends: a random install ID, KYA version, OS/arch, Node version, which KYA part is running.",
  "  Never: file paths, repo names, prompts, tool arguments, or code.",
  "  See exactly what is sent with `kya telemetry show`; change your mind any time with `kya telemetry off`.",
];

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

/**
 * Ask once, on an interactive terminal, in the setup commands (`start`, `init`, `connect`). Strict
 * opt-in: only an explicit `y` / `yes` enables; empty input, anything else, or closing the prompt is No.
 * Skipped when already answered, when an override forces telemetry off, and when not interactive
 * (nothing is saved then, so the next interactive run can ask).
 */
export async function maybePromptConsent(
  io: ConsentIo,
  env: NodeJS.ProcessEnv,
): Promise<"yes" | "no" | "skipped"> {
  if (telemetryDisabledReason(env) !== undefined) return "skipped";
  if (readTelemetryState(env).askedAt !== undefined) return "skipped";
  const interactive = io.isTty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive) return "skipped";

  for (const line of CONSENT_NOTICE) io.error(line);
  const answer = await (io.ask ?? defaultAsk)("Share anonymous usage stats? [y/N]");
  const yes = /^y(es)?$/i.test(answer.trim());
  try {
    writeTelemetryState(env, {
      enabled: yes,
      ...(yes ? { installId: randomUUID() } : {}),
      askedAt: new Date().toISOString(),
    });
  } catch {
    io.error("(could not save your telemetry choice; nothing will be sent)");
    return "no";
  }
  io.error(
    yes
      ? "Thanks. Telemetry is on. Turn it off any time: kya telemetry off"
      : "No problem, nothing will be sent. Turn it on later: kya telemetry on",
  );
  return yes ? "yes" : "no";
}

// ---------------------------------------------------------------------------------------------
// `kya telemetry [status|on|off|show|reset]`
// ---------------------------------------------------------------------------------------------

export interface TelemetryCommandIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
}

const NEVER_SENT =
  "Never sent: file paths, repo names, host or user names, environment variables, command arguments, " +
  "tool names, prompts, code, trail contents, API keys, or email addresses.";

export async function runTelemetryCommand(
  input: { readonly sub: string | undefined; readonly purge: boolean; readonly json: boolean },
  io: TelemetryCommandIo,
  env: NodeJS.ProcessEnv,
  cwd: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const state = readTelemetryState(env);
  const reason = telemetryDisabledReason(env);

  switch (input.sub ?? "status") {
    case "status": {
      const effective = isTelemetryEnabled(env);
      if (input.json) {
        io.log(
          JSON.stringify(
            {
              enabled: state.enabled ?? null,
              effective,
              installId: state.installId ?? null,
              endpoint: telemetryEndpoint(env),
              overriddenBy: reason ?? null,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      io.log(`Telemetry: ${state.enabled === true ? "on" : state.enabled === false ? "off" : "not asked yet"}`);
      if (state.enabled === true && reason !== undefined) {
        io.log(`Overridden for this process: ${reason}. Nothing is sent from here.`);
      }
      io.log(`Install ID: ${state.installId ?? "none"}`);
      io.log(`Endpoint: ${telemetryEndpoint(env)}`);
      io.log("See exactly what is sent: kya telemetry show");
      return 0;
    }

    case "on": {
      writeTelemetryState(env, {
        enabled: true,
        installId: state.installId ?? randomUUID(),
        askedAt: state.askedAt ?? new Date().toISOString(),
      });
      io.log("Telemetry is on. See what is sent: kya telemetry show. Turn off: kya telemetry off");
      if (reason !== undefined) io.log(`Note: ${reason}, so nothing is sent from this shell.`);
      return 0;
    }

    case "off": {
      // One timestamp for every write below: a purge must not drop the "already asked" marker, or the
      // next interactive setup command would ask the consent question again after an explicit erase.
      const askedAt = state.askedAt ?? new Date().toISOString();
      writeTelemetryState(env, {
        enabled: false,
        ...(state.installId !== undefined ? { installId: state.installId } : {}),
        askedAt,
      });
      io.log("Telemetry is off. Nothing will be sent.");
      if (!input.purge) return 0;
      if (state.installId === undefined) {
        io.log("No install ID on this machine, so there is nothing to erase.");
        return 0;
      }
      const erased = await postTelemetry(eraseEndpoint(env), { installId: state.installId }, fetchImpl);
      if (!erased) {
        io.error("Could not reach the server to erase your data. Your install ID is kept so you can retry: kya telemetry off --purge");
        return 1;
      }
      writeTelemetryState(env, { enabled: false, askedAt });
      io.log("Erased everything stored for this install and removed the local install ID.");
      return 0;
    }

    case "ping": {
      // Internal: started detached by `kya hook`. Silent, always exit 0 (nothing waits on the result).
      await sendHookPing(env, cwd, fetchImpl);
      return 0;
    }

    case "show": {
      const sample = buildPayload({
        installId: state.installId ?? "<random id, created only when you opt in>",
        sessionId: "<random per process>",
        event: "heartbeat",
        surface: "mcp-stdio",
        env,
        cwd,
      });
      if (input.json) {
        io.log(JSON.stringify(sample, null, 2));
        return 0;
      }
      io.log("Sent about every 5 minutes while a KYA process (MCP gate, report, gateway) is running,");
      io.log('and as one `event: "ping"`, `surface: "hook"` message per day when only `kya hook` is used:');
      io.log(JSON.stringify(sample, null, 2));
      io.log(NEVER_SENT);
      io.log(`Endpoint: ${telemetryEndpoint(env)}`);
      return 0;
    }

    case "reset": {
      if (state.enabled !== true && state.installId === undefined) {
        io.log("Nothing to reset: telemetry is off and there is no install ID.");
        return 0;
      }
      writeTelemetryState(env, {
        ...(state.enabled !== undefined ? { enabled: state.enabled } : {}),
        installId: randomUUID(),
        askedAt: state.askedAt ?? new Date().toISOString(),
      });
      io.log("Generated a new random install ID. The old one is no longer linked to this machine.");
      return 0;
    }

    default:
      io.error("Usage: kya telemetry [status|on|off [--purge]|show|reset] [--json]");
      return 2;
  }
}
