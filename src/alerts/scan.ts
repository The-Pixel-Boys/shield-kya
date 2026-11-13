/**
 * Incident alert scan. Runs the deterministic detectors over the trail events of the last
 * `windowMinutes`, keeps incidents at or above the severity floor, drops the ones already alerted
 * (alerts-state.json) and sends `incident.opened` to the user-level webhooks and the desktop.
 * Optional local triage model: when installed, each new alert gets category, urgency, action and benign
 * (advisory text only). The model never decides whether an alert is sent: no model, a failed model and a
 * slow model all give the same alert with the detector severity.
 *
 * Callers: the detached `kya notify-flush` child and the report daemon. Both are off the hook path.
 * Advisory and fail open: nothing here throws, and a failed scan changes no verdict.
 * Receivers and settings come from the user-level config only; a project config is never read.
 */
import { kyaHome, readFileConfig } from "../config.js";
import { investigateTrail, type Incident, type Severity } from "../investigate/index.js";
import { notifyIncident, resolveIncidentWebhooks, type NotifyFileConfig } from "../notify/index.js";
import type { NotifyDeps } from "../notify/sender.js";
import { readGlobalTrail, type TrailEvent } from "../trail.js";
import { resolveAlertsConfig, severityRank } from "./config.js";
import { desktopNotify, type DesktopDeps } from "./desktop.js";
import { buildIncidentAlert, type IncidentAlert } from "./incident-alert.js";
import {
  incidentRef,
  needsAlert,
  readAlertsState,
  withStateLock,
  writeAlertsState,
  type AlertEntry,
} from "./state.js";
import { buildTriageInput, type TriageInput } from "./triage-input.js";
import type { IncidentTriage } from "./triage-model.js";
import { triageInstalled } from "./triage-status.js";

export interface AlertScanDeps extends NotifyDeps {
  /** Test seam: the clock. */
  readonly now?: () => Date;
  /** Test seam: triage of one incident input. Default: the local model when it is installed. */
  readonly triage?: (input: TriageInput) => Promise<IncidentTriage | undefined>;
  /** Test seam: the desktop notifier. */
  readonly desktop?: DesktopDeps;
  /** Test seam: shorter triage timeout. */
  readonly triageTimeoutMs?: number;
}

export interface AlertScanResult {
  /** Incidents that passed the floor and the dedupe check and were sent. */
  readonly alerted: readonly IncidentAlert[];
  readonly delivered: number;
}

const NONE: AlertScanResult = { alerted: [], delivered: 0 };

/** Model load plus one inference. Longer than this and the alert goes out without triage. */
export const TRIAGE_TIMEOUT_MS = 8_000;
/** One scan opens at most this many desktop notifications (an incident storm must not flood the screen). */
export const MAX_DESKTOP_PER_SCAN = 3;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** The model is loaded here, in the flush child or the report daemon, and only when an alert is new. Never in the hook. */
function defaultTriage(env: NodeJS.ProcessEnv): ((input: TriageInput) => Promise<IncidentTriage | undefined>) | undefined {
  if (!triageInstalled(env)) return undefined;
  return async (input) => (await import("./triage-model.js")).triageIncident(input, env);
}

interface Due {
  alert: IncidentAlert;
  readonly key: string;
  readonly inc: Incident;
  /** First delivery attempt of this alert. Triage and the desktop notification run on the first attempt only. */
  readonly first: boolean;
}

/**
 * Add triage to each claimed alert on its first attempt. A retry never loads the model again: a crash of the
 * model code (it is native code) must not be able to eat the retries of an alert. Any failure leaves the alert as it is.
 */
async function addTriage(due: Due[], events: readonly TrailEvent[], env: NodeJS.ProcessEnv, deps: AlertScanDeps): Promise<void> {
  const run = deps.triage ?? defaultTriage(env);
  const todo = due.filter((d) => d.first);
  if (!run || todo.length === 0) return;
  try {
    let slow = false;
    for (const d of todo) {
      if (slow) break; // no result (timeout or a failing model): the rest of this scan goes out without triage, at once
      try {
        const triage = await withTimeout(run(buildTriageInput(d.inc, events)), deps.triageTimeoutMs ?? TRIAGE_TIMEOUT_MS);
        if (triage) d.alert = { ...d.alert, triage };
        else slow = true;
      } catch {
        /* fail open: no triage, same alert */
      }
    }
  } finally {
    // The report daemon lives long: give the model memory back after each scan.
    if (!deps.triage) await (await import("./triage-model.js")).releaseTriageModel().catch(() => undefined);
  }
}

/** Events may be at most this far in the future (clock skew). Later ones are forged or broken. */
export const MAX_FUTURE_MS = 5 * 60_000;

/** Events inside the window. A ts that does not parse, or lies more than 5 minutes ahead, is dropped. */
export function windowEvents(events: readonly TrailEvent[], now: Date, windowMinutes: number): TrailEvent[] {
  const from = now.getTime() - windowMinutes * 60_000;
  const to = now.getTime() + MAX_FUTURE_MS;
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= from && t <= to;
  });
}

/** Pure core: events in, incidents at or above the floor out. */
export function incidentsAboveFloor(
  events: readonly TrailEvent[],
  minSeverity: Severity,
): { incidents: Incident[]; briefs: ReadonlyMap<string, string> } {
  const result = investigateTrail(events);
  return {
    incidents: result.incidents.filter((i) => severityRank(i.severity) >= severityRank(minSeverity)),
    briefs: result.briefs,
  };
}

async function saveTriage(env: NodeJS.ProcessEnv, claimed: readonly Due[]): Promise<void> {
  await withStateLock(env, () => {
    const byKey = new Map(claimed.map((c) => [c.key, c.alert.triage]));
    writeAlertsState(
      env,
      readAlertsState(env).map((e) => {
        const triage = byKey.get(e.key);
        return triage ? { ...e, triage } : e;
      }),
    );
  });
}

export async function runAlertScan(
  _cwd: string,
  env: NodeJS.ProcessEnv,
  deps: AlertScanDeps = {},
): Promise<AlertScanResult> {
  try {
    const cfg = resolveAlertsConfig(env);
    if (!cfg.enabled) return NONE;
    const now = (deps.now ?? (() => new Date()))();
    // User-level trail only (tail-capped): a project trail ships with a cloned repo and could be forged.
    const events = windowEvents(readGlobalTrail(env), now, cfg.windowMinutes);
    if (events.length === 0) return NONE;
    const { incidents, briefs } = incidentsAboveFloor(events, cfg.minSeverity);
    if (incidents.length === 0) return NONE;

    const targets = resolveIncidentWebhooks(readFileConfig(kyaHome(env)) as NotifyFileConfig);

    // Claim under the lock so two flush children never send the same alert.
    const claimed = await withStateLock(env, () => {
      const entries = readAlertsState(env);
      const due: Due[] = [];
      for (const inc of incidents) {
        const ref = incidentRef(inc.id);
        if (!needsAlert(entries, { ref, severity: inc.severity, firstTs: inc.firstTs, lastTs: inc.lastTs }, now.getTime())) continue;
        const alert = buildIncidentAlert(inc, events, briefs.get(inc.id));
        const key = `${ref}:${inc.severity}`;
        const prev = entries.find((e) => e.key === key);
        // A pending entry is a retry of the same alert (delivery failed). A sent one means this is a new occurrence.
        const retry = prev?.status === "pending";
        const entry: AlertEntry = {
          key,
          ref,
          severity: inc.severity,
          ts: now.toISOString(),
          lastTs: inc.lastTs,
          title: alert.title,
          detectors: [...alert.detectorIds],
          delivered: 0,
          attempts: (prev?.attempts ?? 0) + 1,
          ...(retry && prev?.triage ? { triage: prev.triage } : {}),
          // No receiver: the alert shows in the report only, nothing more to retry.
          status: targets.length === 0 ? "sent" : "pending",
        };
        if (prev) entries.splice(entries.indexOf(prev), 1);
        entries.push(entry);
        due.push({ alert: retry && prev?.triage ? { ...alert, triage: prev.triage } : alert, key, inc, first: !retry });
      }
      if (due.length > 0) writeAlertsState(env, entries);
      return due;
    });
    if (!claimed || claimed.length === 0) return NONE;

    // Desktop first: its text holds no triage, and a crash of the model code (native) must not take the notification with it.
    if (cfg.desktop) {
      const fresh = claimed.filter((c) => c.first).slice(0, MAX_DESKTOP_PER_SCAN);
      for (const { alert } of fresh) await desktopNotify(alert, env, deps.desktop);
    }

    await addTriage(claimed, events, env, deps);
    // Keep the triage before anything is sent: a retry then reuses it and never needs the model.
    if (claimed.some((c) => c.first && c.alert.triage)) await saveTriage(env, claimed);

    let delivered = 0;
    const results = new Map<string, number>();
    if (targets.length > 0) {
      for (const { alert, key } of claimed) {
        const n = await notifyIncident(alert, targets, env, deps);
        results.set(key, n);
        delivered += n;
      }
    }
    if (targets.length > 0) {
      await withStateLock(env, () => {
        const next = readAlertsState(env).map((e) => {
          const n = results.get(e.key);
          return n === undefined ? e : { ...e, delivered: n, status: n > 0 ? ("sent" as const) : ("pending" as const) };
        });
        writeAlertsState(env, next);
      });
    }
    return { alerted: claimed.map((c) => c.alert), delivered };
  } catch {
    return NONE;
  }
}
