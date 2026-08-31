import { stdin as stdinFd, stdout as stdoutFd } from "node:process";
import { emitKeypressEvents } from "node:readline";
import type { ResolvedConfig } from "../config.js";
import { KyaHttpClient } from "../client.js";
import { AuthRequiredError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import { type DashPane } from "../dash/entitlement.js";
import { renderDash, type DashIo } from "../dash/dash.js";
import { mapKey } from "../dash/input.js";
import { PolicySampleCache } from "../dash/policy-cache.js";
import { runWrap, wrapExitCode } from "./wrap.js";
import { runInvoke } from "./invoke.js";
import { runKillAgent, runShrinkSession } from "./ops.js";
import { runOrr } from "./orr.js";

const AUTO_REFRESH_MS = 5_000;

const ORR_PRODUCERS = ["sa.first_party", "openssf.scorecard"] as const;

function deskOrr(cwd: string, producer: string) {
  const producers = producer === "sa.first_party" ? ["sa.first_party"] : ["sa.first_party", producer];
  return runOrr({
    path: cwd,
    out: `${cwd}/orr-report`,
    rubric: "0",
    disableCategories: [],
    formats: ["json", "md"],
    producers: [...producers],
    skipOptionalProducers: producer === "sa.first_party",
    quiet: true,
    jsonStdout: false,
  });
}

const PANES: DashPane[] = [
  "home",
  "policy",
  "agents",
  "approvals",
  "sessions",
  "orr",
  "mcp",
  "sandbox",
  "dashboard",
  "cases",
  "metrics",
  "edge",
  "settings",
];

export function dashOptionsFromArgs(parsed: ParsedArgs): {
  once: boolean;
  offline: boolean;
  pane: DashPane;
} {
  const onceRaw = parsed.flags["once"];
  const stolenPane =
    typeof onceRaw === "string" && (PANES as string[]).includes(onceRaw.toLowerCase())
      ? (onceRaw.toLowerCase() as DashPane)
      : undefined;
  const paneRaw = (flagString(parsed.flags, "pane") ?? stolenPane ?? "home").toLowerCase();
  const pane = (PANES as string[]).includes(paneRaw) ? (paneRaw as DashPane) : "home";
  const once =
    flagBool(parsed.flags, "once") ||
    parsed.positionals.includes("once") ||
    stolenPane !== undefined ||
    onceRaw === "";
  return {
    once,
    offline: flagBool(parsed.flags, "offline") || parsed.positionals.includes("offline"),
    pane,
  };
}

type PendingConfirm =
  | { kind: "kill"; id: string }
  | { kind: "shrink"; id: string; to: "BUILD" | "READ" }
  | { kind: "decide"; id: string; decision: "approve" | "reject" };

export async function runDash(
  config: ResolvedConfig,
  parsed: ParsedArgs,
  io: DashIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const opts = dashOptionsFromArgs(parsed);
  const tty = io.isTty ?? Boolean(stdinFd.isTTY && stdoutFd.isTTY);
  const once = opts.once || !tty;

  let offline = opts.offline;
  let client: KyaHttpClient | undefined = makeClient(config, offline);

  const policyCache = new PolicySampleCache();
  let forcePolicyEval = false;
  let autoRefresh = false;
  let pending: PendingConfirm | undefined;
  let orrProducerIdx = 0;

  let pane = opts.pane;
  let cursor = 0;
  let orrSummary: { overall?: string; disposition?: string; path?: string } | undefined;
  let last = {
    agents: [] as { id: string; name: string; status?: string }[],
    approvals: [] as { id: string; status: string; action?: string }[],
    sessions: [] as { id: string; risk?: string; host?: string; clearance?: string }[],
  };

  const paint = async () => {
    const snap = await renderDash(
      { ...config, offline },
      {
        once: true,
        offline,
        pane,
        client,
        fetchPlaneEntitlement: client
          ? async () =>
              client!.request<{ plan?: string; dash?: string; features?: string[] }>(
                "/api/v1/kya/entitlement",
                { signal: AbortSignal.timeout(5000) },
              )
          : undefined,
        cursor,
        orrSummary,
        policyCache,
        forcePolicyEval,
      },
      env,
    );
    forcePolicyEval = false;
    last = {
      agents: [...snap.agents],
      approvals: [...snap.approvals],
      sessions: [...snap.sessions],
    };
    // Interactive: clear screen before repaint to avoid scroll spam.
    if (!once && tty) {
      try {
        stdoutFd.write("\x1b[2J\x1b[H");
      } catch {
        /* ignore */
      }
    }
    io.log(snap.frame);
    return snap;
  };

  const selected = <T extends { id: string }>(rows: readonly T[]): T | undefined =>
    rows.length === 0 ? undefined : rows[Math.min(cursor, rows.length - 1)];

  if (once) {
    await paint();
    return 0;
  }

  await paint();

  emitKeypressEvents(stdinFd);
  stdinFd.setRawMode?.(true);
  stdinFd.resume();

  return await new Promise<number>((resolve) => {
    let painting = false;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    const stopRefresh = () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    };

    const startRefresh = () => {
      stopRefresh();
      if (!autoRefresh || offline || !client) return;
      refreshTimer = setInterval(() => {
        if (painting || pending) return;
        painting = true;
        void paint()
          .catch((err: unknown) => {
            if (err instanceof AuthRequiredError) io.error(err.message);
            else io.error(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            painting = false;
          });
      }, AUTO_REFRESH_MS);
    };

    const syncClient = () => {
      client = makeClient(config, offline);
      if (offline) policyCache.invalidate();
      if (!offline && client) startRefresh();
      else stopRefresh();
    };

    const runPaint = () => {
      painting = true;
      void paint()
        .catch((err: unknown) => {
          if (err instanceof AuthRequiredError) io.error(err.message);
          else io.error(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          painting = false;
        });
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      const raw = key?.ctrl && key.name === "c" ? "\u0003" : (str ?? key?.name ?? "");
      const action = mapKey(raw);

      if (pending) {
        if (action.type === "confirm-yes") {
          const job = pending;
          pending = undefined;
          if (!client || offline) {
            io.log("Need a live plane (drop offline / set KYA_API_KEY).");
            return;
          }
          const cfg = { ...config, offline: false };
          void (async () => {
            try {
              if (job.kind === "kill") {
                const killed = await runKillAgent(cfg, job.id, client!);
                io.log(`${killed.status ?? "PAUSED"}  ${killed.id}`);
              } else if (job.kind === "shrink") {
                const sh = await runShrinkSession(cfg, job.id, job.to, client!);
                io.log(`clearance ${sh.from} → ${sh.to}`);
              } else {
                const res = await client!.decideApproval(job.id, job.decision);
                io.log(`${job.decision} → ${res.status}  ${res.id}`);
              }
            } catch (err: unknown) {
              if (err instanceof AuthRequiredError) io.error(err.message);
              else io.error(err instanceof Error ? err.message : String(err));
            } finally {
              await paint();
            }
          })();
          return;
        }
        pending = undefined;
        io.log("cancelled");
        return;
      }

      if (action.type === "quit") {
        cleanup();
        resolve(0);
        return;
      }
      if (action.type === "help") {
        io.log(
          "1-8 panes · j/k · e eval · p auto-refresh · w wrap · k kill · i invoke · b/R shrink · o orr · t passport · a/x decide (y confirm) · O offline · q",
        );
        return;
      }
      if (action.type === "noop" || painting) return;

      if (action.type === "up") {
        cursor = Math.max(0, cursor - 1);
      } else if (action.type === "down") {
        cursor += 1;
      } else if (action.type === "offline") {
        offline = !offline;
        syncClient();
        io.log(offline ? "offline (sample PEP only)" : "live plane");
      } else if (action.type === "force-policy-eval") {
        forcePolicyEval = true;
        policyCache.invalidate();
        pane = "policy";
      } else if (action.type === "toggle-auto-refresh") {
        autoRefresh = !autoRefresh;
        io.log(autoRefresh ? `auto-refresh ${AUTO_REFRESH_MS / 1000}s` : "auto-refresh off");
        if (autoRefresh) startRefresh();
        else stopRefresh();
        return;
      } else if (action.type === "pane" && action.pane) {
        pane = action.pane;
        cursor = 0;
      } else if (action.type === "register-hint") {
        io.log("Register: kya register-agent --name solo --version-hash dev-local");
        return;
      } else if (action.type === "refresh") {
        // fall through to paint
      } else if (!offline && client) {
        const cfg = { ...config, offline: false };
        void (async () => {
          try {
            if (action.type === "wrap") {
              const result = await runWrap(
                cfg,
                { toolId: "org.sample.data.write", irreversible: true },
                client!,
              );
              io.log(`wrap exit ${wrapExitCode(result)} ${result.eval.response.verdict}`);
            } else if (action.type === "kill") {
              const row = selected(last.agents);
              if (!row) return;
              pending = { kind: "kill", id: row.id };
              io.log(`kill ${row.id}? press y to confirm, any other key to cancel`);
              return;
            } else if (action.type === "invoke") {
              const row = selected(last.approvals);
              if (!row) return;
              const result = await runInvoke(
                cfg,
                { toolId: String(row.action ?? "org.sample.data.write"), irreversible: true },
                client!,
              );
              io.log(
                `invoke ${result.verdict} dispatched=${result.dispatched} ${result.sideEffect} (does not run the write)`,
              );
            } else if (action.type === "shrink-build" || action.type === "shrink-read") {
              const row = selected(last.sessions);
              if (!row) return;
              const to = action.type === "shrink-build" ? "BUILD" : "READ";
              pending = { kind: "shrink", id: row.id, to };
              io.log(`shrink ${row.id} → ${to}? press y to confirm, any other key to cancel`);
              return;
            } else if (action.type === "orr-run") {
              const producer = ORR_PRODUCERS[orrProducerIdx % ORR_PRODUCERS.length]!;
              orrProducerIdx += 1;
              io.log(`orr producer=${producer}`);
              const result = deskOrr(config.cwd, producer);
              orrSummary = {
                overall: result.report.overall,
                disposition: result.report.disposition,
                path: result.reportJsonPath ?? result.reportMdPath,
              };
            } else if (action.type === "passport") {
              const row = selected(last.agents);
              if (!row) {
                io.log("Select an agent (pane 3) then press t");
                return;
              }
              const passport = await client!.getPassport(row.id);
              io.log(JSON.stringify(passport, null, 2));
            } else if (action.type === "decide-approve" || action.type === "decide-reject") {
              const row = selected(last.approvals);
              if (!row) return;
              const decision = action.type === "decide-approve" ? "approve" : "reject";
              pending = { kind: "decide", id: row.id, decision };
              io.log(
                `${decision} ${row.id}? press y to confirm (needs kya.approve). Any other key cancels.`,
              );
              return;
            }
          } catch (err: unknown) {
            if (err instanceof AuthRequiredError) io.error(err.message);
            else io.error(err instanceof Error ? err.message : String(err));
          } finally {
            await paint();
          }
        })();
        return;
      } else if (action.type === "orr-run") {
        const producer = ORR_PRODUCERS[orrProducerIdx % ORR_PRODUCERS.length]!;
        orrProducerIdx += 1;
        io.log(`orr producer=${producer}`);
        const result = deskOrr(config.cwd, producer);
        orrSummary = {
          overall: result.report.overall,
          disposition: result.report.disposition,
          path: result.reportJsonPath ?? result.reportMdPath,
        };
      } else if (
        action.type === "wrap" ||
        action.type === "kill" ||
        action.type === "invoke" ||
        action.type === "shrink-build" ||
        action.type === "shrink-read" ||
        action.type === "decide-approve" ||
        action.type === "decide-reject" ||
        action.type === "passport"
      ) {
        io.log("Need a live plane (O toggles offline; set KYA_API_KEY).");
        return;
      }

      runPaint();
    };

    const cleanup = () => {
      stopRefresh();
      stdinFd.setRawMode?.(false);
      stdinFd.off("keypress", onKey);
      stdinFd.pause();
    };
    stdinFd.on("keypress", onKey);
  });
}

function makeClient(config: ResolvedConfig, offline: boolean): KyaHttpClient | undefined {
  if (offline || !config.apiKey) return undefined;
  return new KyaHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    host: config.host,
    agentId: config.agentId,
    requireApiKey: true,
  });
}
