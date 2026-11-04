/**
 * kya posture - the developer posture report (opt-in, default off).
 *   status                 show the local toggle, label, login, cached workspace policy. No network.
 *   on [--yes]             print the exact report that would be sent, then ask (TTY) or need --yes.
 *   off                    stop sending at once. No network.
 *   send [--dry-run] [--json]
 *                          --dry-run prints the report and sends nothing. Otherwise one send attempt.
 *   label NAME             set the label shown in the workspace console.
 * Advisory. Nothing here prevents anything.
 */
import { createInterface } from "node:readline/promises";
import { readCredentials } from "../login/credentials.js";
import { readIocResult } from "../ioc/result.js";
import { buildPostureReport, runPostureSend } from "../posture/send.js";
import {
  deviceId,
  effectiveLabel,
  labelProblem,
  readPostureConfig,
  readPostureState,
  writePostureConfig,
} from "../posture/store.js";
import { forbiddenContext, forbiddenReason } from "../posture/validate.js";
import { kyaHome } from "../config.js";
import { hostname, userInfo } from "node:os";

export interface PostureIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface PostureInput {
  readonly io: PostureIo;
  readonly env: NodeJS.ProcessEnv;
  readonly sub: string | undefined;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly isTty: boolean;
  /** Asks a yes/no question. Default: the terminal. Tests pass a stub. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly fetch?: typeof fetch;
  readonly now?: Date;
}

const USAGE = [
  "Usage: kya posture status | on [--yes] | off | send [--dry-run] [--json] | label NAME",
  "Developer posture report: opt-in and off by default. kya posture on shows exactly what would be sent.",
];

export async function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function origin(env: NodeJS.ProcessEnv): string | undefined {
  const creds = readCredentials(env);
  if (creds === undefined) return undefined;
  return new URL(creds.baseUrl).origin;
}

function statusLines(env: NodeJS.ProcessEnv, now: Date): string[] {
  const cfg = readPostureConfig(env);
  const state = readPostureState(env);
  const id = deviceId(env, false);
  const ioc = readIocResult(env);
  const policy = state.policy
    ? `${state.policy.enabled ? "enabled" : "disabled"} (checked ${state.policy.checkedAt})`
    : "not checked yet";
  const iocLine = ioc
    ? `IoC check: ${ioc.findings.length} finding(s), list ${ioc.listVersion}, checked ${ioc.checkedAt}.`
    : "IoC check: no result yet (kya doctor --iocs).";
  return [
    cfg.share
      ? "Posture sharing: on. A report is sent once a day only when the workspace allows it."
      : "Posture sharing: off. Nothing is sent and no request is made.",
    `Label: ${id === undefined ? "created on first use" : effectiveLabel(env, id)}${cfg.label ? "" : " (default)"}`,
    `Hosted login: ${origin(env) ?? "none (kya login links this machine)"}`,
    `Workspace policy (cached): ${policy}`,
    `Last sent: ${state.lastSentAt ?? "never"}`,
    iocLine,
    `Checked at ${now.toISOString()}. Advisory: this report shows what is sent, it does not prevent anything.`,
  ];
}

function violationLines(violations: readonly { path: string; reason: string }[]): string[] {
  return violations.map((v) => `  ${v.path || "report"}: ${v.reason}`);
}

export async function runPosture(input: PostureInput): Promise<number> {
  const { io, env } = input;
  const now = input.now ?? new Date();
  const yes = input.flags["yes"] === true;
  switch (input.sub) {
    case "status": {
      for (const line of statusLines(env, now)) io.log(line);
      return 0;
    }

    case "on": {
      const { report, violations } = await buildPostureReport(env, now);
      io.log("This is exactly what a send would contain (nothing is sent by this command):");
      io.log(JSON.stringify(report, null, 2));
      if (violations.length > 0) {
        io.error("Not turned on: this report fails the local check, so nothing would be sent. Details:");
        for (const l of violationLines(violations)) io.error(l);
        return 1;
      }
      if (!yes) {
        if (!input.isTty) {
          io.error("kya posture on needs a terminal to confirm. In scripts, re-run with --yes. Nothing changed.");
          return 2;
        }
        const ask = input.confirm ?? confirmOnTerminal;
        const ok = await ask("Turn on posture sharing? Nothing is sent until your workspace allows it. [y/N] ");
        if (!ok) {
          io.log("Left off. Nothing changed.");
          return 0;
        }
      }
      writePostureConfig(env, { share: true });
      io.log("Posture sharing is on. Turn it off any time with kya posture off.");
      if (readCredentials(env) === undefined) io.log("No hosted login yet: nothing is sent until you run kya login.");
      return 0;
    }

    case "off": {
      writePostureConfig(env, { share: false });
      io.log("Posture sharing is off. No report is sent, and no request is made.");
      return 0;
    }

    case "send": {
      if (input.flags["dry-run"] === true) {
        const { report, violations } = await buildPostureReport(env, now);
        if (input.flags["json"] === true) io.log(JSON.stringify(report, null, 2));
        else {
          io.log("Dry run: nothing is sent. This is the report a send would post:");
          io.log(JSON.stringify(report, null, 2));
        }
        if (violations.length > 0) {
          io.error("Would not be sent: fails the local check. Details:");
          for (const l of violationLines(violations)) io.error(l);
          return 1;
        }
        return 0;
      }
      const result = await runPostureSend(env, { fetch: input.fetch, now });
      switch (result.outcome) {
        case "sent":
          io.log("Posture report sent.");
          return 0;
        case "off":
          io.log("Posture sharing is off. Nothing sent. Run kya posture on to turn it on.");
          return 0;
        default:
          io.error(`Not sent: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}.`);
          return 1;
      }
    }

    case "label": {
      const name = input.args[0];
      if (name === undefined) {
        for (const l of USAGE) io.error(l);
        return 2;
      }
      let user = "";
      try {
        user = userInfo().username;
      } catch {
        /* none */
      }
      const ctx = forbiddenContext(env, user, hostname(), kyaHome(env));
      const problem = labelProblem(name, (v) => forbiddenReason(v, ctx));
      if (problem) {
        io.error(`Label not set: ${problem}.`);
        return 2;
      }
      writePostureConfig(env, { label: name });
      io.log(`Label set to ${name}.`);
      return 0;
    }

    default:
      for (const l of USAGE) io.log(l);
      return input.sub === undefined ? 0 : 2;
  }
}

/** Used by the hidden detached child (`kya posture-send`). Never throws; sends at most one report. */
export async function runPostureSendDetached(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runPostureSend(env);
  } catch {
    /* fail open */
  }
}


