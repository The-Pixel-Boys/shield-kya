/**
 * kya alerts - security alerts for detected incidents (optional local triage model, advisory, off by default).
 *   status [--json]   enabled?, severity floor, receivers of incident alerts, last 10 alerts
 *   test              send one synthetic incident, marked as a test, to the desktop and to each receiver
 *   on | off          write alerts.enabled to the user-level config (~/.kya/config.json)
 * Receivers are the user-level notify.webhooks whose events include "incident.opened" (or have no filter).
 */
import { kyaHome, readFileConfig } from "../config.js";
import { resolveAlertsConfig, writeAlertsEnabled } from "../alerts/config.js";
import { buildTestIncidentAlert } from "../alerts/incident-alert.js";
import { readAlertsState } from "../alerts/state.js";
import { desktopNotify } from "../alerts/desktop.js";
import { triageInstalled, TRIAGE_MODEL_ID } from "../alerts/triage-status.js";
import { notifyIncident, notifyTargetLabel, resolveIncidentWebhooks, type NotifyFileConfig } from "../notify/index.js";
import type { NotifyDeps } from "../notify/sender.js";

export interface AlertsIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface AlertsInput {
  readonly io: AlertsIo;
  readonly env: NodeJS.ProcessEnv;
  readonly sub: string | undefined;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly deps?: NotifyDeps;
  /** Test seam: the desktop notifier. */
  readonly desktop?: import("../alerts/desktop.js").DesktopDeps;
}

const USAGE = [
  "Usage: kya alerts status [--json] | test | on | off",
  "Security alerts: kya sends an alert when it detects an incident (for example a never-list tool tried again and again).",
  "Off by default. Advisory. No raw arguments leave this machine.",
];

function receivers(env: NodeJS.ProcessEnv) {
  return resolveIncidentWebhooks(readFileConfig(kyaHome(env)) as NotifyFileConfig);
}

export async function runAlerts(input: AlertsInput): Promise<number> {
  const { io, env } = input;
  switch (input.sub) {
    case "status": {
      const cfg = resolveAlertsConfig(env);
      const hosts = receivers(env).map((w) => notifyTargetLabel(w.url));
      const recent = readAlertsState(env).slice(-10).reverse();
      if (input.flags["json"] === true || input.flags["json"] === "true") {
        io.log(
          JSON.stringify(
            {
              enabled: cfg.enabled,
              source: cfg.source,
              minSeverity: cfg.minSeverity,
              windowMinutes: cfg.windowMinutes,
              desktop: cfg.desktop,
              triageModel: triageInstalled(env) ? TRIAGE_MODEL_ID : null,
              receivers: hosts,
              recent: recent.map((e) => ({
                ts: e.ts,
                severity: e.severity,
                title: e.title,
                detectors: e.detectors,
                delivered: e.delivered,
                status: e.status,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      io.log(`Security alerts: ${cfg.enabled ? "on" : "off"}${cfg.source === "env" ? " (set by KYA_ALERTS)" : ""}`);
      io.log(`Severity floor: ${cfg.minSeverity}. Window: ${cfg.windowMinutes} minutes.`);
      io.log(`Desktop notification: ${cfg.desktop ? "on" : "off"}. Local triage model: ${triageInstalled(env) ? `installed (${TRIAGE_MODEL_ID})` : "not installed (alerts use the detector severity). Install: KYA_ALERTS=on kya start"}.`);
      io.log(
        hosts.length > 0
          ? `Webhooks that receive incidents: ${hosts.join(", ")}`
          : "Webhooks that receive incidents: none (alerts show in the report only). Add notify.webhooks to ~/.kya/config.json.",
      );
      if (recent.length === 0) io.log("Last alerts: none yet.");
      else {
        io.log("Last alerts:");
        for (const e of recent) {
          io.log(`  ${e.ts}  [${e.severity}] ${e.title}  (${e.status === "sent" ? `sent to ${e.delivered}` : "not delivered"})`);
        }
      }
      io.log("Local KYA is advisory.");
      return 0;
    }
    case "test": {
      const targets = receivers(env);
      const alert = buildTestIncidentAlert();
      if (resolveAlertsConfig(env).desktop) {
        io.log(`${(await desktopNotify(alert, env, input.desktop)) ? "sent" : "not sent"}: desktop notification`);
      }
      if (targets.length === 0) {
        io.error("No webhook receives incident alerts. Add notify.webhooks to ~/.kya/config.json first.");
        return 1;
      }
      let failed = 0;
      for (const w of targets) {
        const ok = (await notifyIncident(alert, [w], env, input.deps)) > 0;
        if (!ok) failed++;
        io.log(`${ok ? "sent" : "failed"}: ${notifyTargetLabel(w.url)}`);
      }
      io.log(failed === 0 ? "Test alert sent." : `Test alert failed for ${failed} of ${targets.length} webhook(s).`);
      return failed === 0 ? 0 : 1;
    }
    case "on":
    case "off": {
      const on = input.sub === "on";
      try {
        writeAlertsEnabled(env, on);
      } catch (err) {
        io.error(`Could not write ~/.kya/config.json: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      io.log(`Security alerts: ${on ? "on" : "off"}.`);
      const override = env.KYA_ALERTS?.trim();
      if (override) io.log(`Note: KYA_ALERTS=${override} in this shell overrides the config file.`);
      if (on && receivers(env).length === 0) {
        io.log("No webhook receives incidents yet. Alerts show in the report only. Add notify.webhooks to ~/.kya/config.json.");
      }
      return 0;
    }
    default:
      for (const line of USAGE) io.error(line);
      return input.sub === undefined ? 0 : 2;
  }
}
