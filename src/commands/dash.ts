import { stdin as stdinFd, stdout as stdoutFd } from "node:process";
import { emitKeypressEvents } from "node:readline";
import type { ResolvedConfig } from "../config.js";
import { isMachineApiKey, KyaHttpClient } from "../client.js";
import { AuthRequiredError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import { type DashPane } from "../dash/entitlement.js";
import { renderDash, type DashIo } from "../dash/dash.js";
import { mapKey } from "../dash/input.js";
import { PolicySampleCache } from "../dash/policy-cache.js";
import { assertNoSecrets } from "../dash/render.js";
import { runWrap, wrapExitCode } from "./wrap.js";
import { runInvoke } from "./invoke.js";
import { runKillAgent, runShrinkSession } from "./ops.js";
import { runOrr } from "./orr.js";

const AUTO_REFRESH_MS = 5_000;

/** TUI ORR stays first_party only — Scorecard spawn is CLI-explicit (no env leak / stdin race). */
function deskOrr(cwd: string) {
  return runOrr({
    path: cwd,
    out: `${cwd}/orr-report`,
    rubric: "0",
    disableCategories: [],
    formats: ["json", "md"],
    producers: ["sa.first_party"],
    skipOptionalProducers: true,
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
  | { kind: "kill"; id: string; prompt: string }
  | { kind: "shrink"; id: string; to: "BUILD" | "READ"; prompt: string }
  | { kind: "decide"; id: string; decision: "approve" | "reject"; prompt: string }
  | { kind: "invoke"; id: string; toolId: string; prompt: string }
  | { kind: "wrap"; prompt: string };

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
  let busy = false;

  let pane = opts.pane;
  let cursor = 0;
  let orrSummary: { overall?: string; disposition?: string; path?: string } | undefined;
  let last = {
    agents: [] as { id: string; name: string; status?: string }[],
    approvals: [] as { id: string; status: string; action?: string }[],
    sessions: [] as { id: string; risk?: string; host?: string; clearance?: string }[],
  };

  const confirmLine = () => pending?.prompt;

  const paint = async (optsPaint?: { clear?: boolean }) => {
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
        confirmLine: confirmLine(),
      },
      env,
    );
    forcePolicyEval = false;
    last = {
      agents: [...snap.agents],
      approvals: [...snap.approvals],
      sessions: [...snap.sessions],
    };
    // Never ANSI-clear while a confirm is armed (keeps the prompt visible).
    if (!once && tty && optsPaint?.clear !== false && !pending) {
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
    await paint({ clear: false });
    return 0;
  }

  await paint({ clear: false });

  emitKeypressEvents(stdinFd);
  stdinFd.setRawMode?.(true);
  stdinFd.resume();
  // Bracketed paste: ignore paste chunks so `ay`/`ky` cannot one-shot confirm.
  try {
    stdoutFd.write("\x1b[?2004h");
  } catch {
    /* ignore */
  }

  return await new Promise<number>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let pasteBuf = "";
    let inPaste = false;

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
        if (busy || pending) return;
        busy = true;
        void paint()
          .catch((err: unknown) => {
            if (err instanceof AuthRequiredError) io.error(err.message);
            else io.error(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            busy = false;
          });
      }, AUTO_REFRESH_MS);
    };

    const syncClient = () => {
      client = makeClient(config, offline);
      if (offline) policyCache.invalidate();
      if (!offline && client && autoRefresh) startRefresh();
      else stopRefresh();
    };

    const stillLive = () => !offline && Boolean(client);

    const arm = (job: PendingConfirm) => {
      pending = job;
      void paint({ clear: false });
    };

    const runPaint = () => {
      if (busy) return;
      busy = true;
      void paint()
        .catch((err: unknown) => {
          if (err instanceof AuthRequiredError) io.error(err.message);
          else io.error(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          busy = false;
        });
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
      const seq = key?.sequence ?? str ?? "";
      // Bracketed paste begin/end
      if (seq.includes("\x1b[200~") || str === "\x1b[200~") {
        inPaste = true;
        pasteBuf = "";
        return;
      }
      if (inPaste) {
        if (seq.includes("\x1b[201~") || str === "\x1b[201~") {
          inPaste = false;
          pasteBuf = "";
          if (pending) {
            pending = undefined;
            io.log("paste ignored — confirm cancelled");
            void paint({ clear: false });
          }
        } else {
          pasteBuf += str ?? "";
        }
        return;
      }

      const raw = key?.ctrl && key.name === "c" ? "\u0003" : (str ?? key?.name ?? "");
      const action = mapKey(raw);

      if (pending) {
        if (action.type === "confirm-yes") {
          const job = pending;
          pending = undefined;
          if (!stillLive()) {
            io.log("Need a live plane (drop offline / set KYA_API_KEY).");
            void paint({ clear: false });
            return;
          }
          const liveClient = client!;
          const cfg = { ...config, offline: false };
          busy = true;
          void (async () => {
            try {
              if (!stillLive()) {
                io.log("offline mid-flight — aborted");
                return;
              }
              if (job.kind === "kill") {
                const killed = await runKillAgent(cfg, job.id, liveClient);
                if (!stillLive()) return;
                io.log(`${killed.status ?? "PAUSED"}  ${killed.id}`);
              } else if (job.kind === "shrink") {
                const sh = await runShrinkSession(cfg, job.id, job.to, liveClient);
                if (!stillLive()) return;
                io.log(`clearance ${sh.from} → ${sh.to}`);
              } else if (job.kind === "decide") {
                // Machine sk_* keys must not decide — JWT / kya.approve only.
                if (isMachineApiKey(config.apiKey ?? "")) {
                  io.log(
                    `Machine API keys cannot ${job.decision} from the TUI. Run: kya ${job.decision} --id ${job.id}`,
                  );
                  return;
                }
                const res = await liveClient.decideApproval(job.id, job.decision);
                if (!stillLive()) return;
                io.log(`${job.decision} → ${res.status}  ${res.id}`);
              } else if (job.kind === "invoke") {
                const result = await runInvoke(
                  cfg,
                  { toolId: job.toolId, irreversible: true },
                  liveClient,
                );
                if (!stillLive()) return;
                io.log(
                  `invoke ${result.verdict} dispatched=${result.dispatched} ${result.sideEffect} (does not run the write)`,
                );
              } else if (job.kind === "wrap") {
                const result = await runWrap(
                  cfg,
                  { toolId: "org.sample.data.write", irreversible: true },
                  liveClient,
                );
                if (!stillLive()) return;
                io.log(`wrap exit ${wrapExitCode(result)} ${result.eval.response.verdict}`);
              }
            } catch (err: unknown) {
              if (err instanceof AuthRequiredError) io.error(err.message);
              else io.error(err instanceof Error ? err.message : String(err));
            } finally {
              busy = false;
              await paint();
            }
          })();
          return;
        }
        pending = undefined;
        io.log("cancelled");
        void paint({ clear: false });
        return;
      }

      if (action.type === "quit") {
        cleanup();
        resolve(0);
        return;
      }
      if (action.type === "help") {
        io.log(
          "1-8 panes · j/k · e eval · p auto-refresh · w wrap · k kill · i invoke · b/R shrink · o orr · t passport · a/x decide (y confirm; sk_* refused) · O offline · q",
        );
        return;
      }
      if (action.type === "noop" || busy) return;

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
        // fall through
      } else if (!offline && client) {
        if (action.type === "wrap") {
          arm({ kind: "wrap", prompt: "wrap sample org.sample.data.write (ticket only)?" });
          return;
        }
        if (action.type === "kill") {
          const row = selected(last.agents);
          if (!row) return;
          arm({ kind: "kill", id: row.id, prompt: `kill agent ${row.id}?` });
          return;
        }
        if (action.type === "invoke") {
          const row = selected(last.approvals);
          if (!row) return;
          const toolId = String(row.action ?? "org.sample.data.write");
          arm({
            kind: "invoke",
            id: row.id,
            toolId,
            prompt: `invoke ${row.id} tool=${toolId}? (does not run the write)`,
          });
          return;
        }
        if (action.type === "shrink-build" || action.type === "shrink-read") {
          const row = selected(last.sessions);
          if (!row) return;
          const to = action.type === "shrink-build" ? "BUILD" : "READ";
          arm({ kind: "shrink", id: row.id, to, prompt: `shrink ${row.id} → ${to}?` });
          return;
        }
        if (action.type === "orr-run") {
          busy = true;
          try {
            const result = deskOrr(config.cwd);
            orrSummary = {
              overall: result.report.overall,
              disposition: result.report.disposition,
              path: result.reportJsonPath ?? result.reportMdPath,
            };
            io.log("orr producer=sa.first_party (Scorecard: use CLI --producer openssf.scorecard)");
          } finally {
            busy = false;
          }
        } else if (action.type === "passport") {
          const row = selected(last.agents);
          if (!row) {
            io.log("Select an agent (pane 3) then press t");
            return;
          }
          busy = true;
          void (async () => {
            try {
              if (!stillLive()) return;
              const passport = await client!.getPassport(row.id);
              const dump = JSON.stringify(passport, null, 2);
              assertNoSecrets("", dump);
              io.log(dump);
            } catch (err: unknown) {
              if (err instanceof AuthRequiredError) io.error(err.message);
              else io.error(err instanceof Error ? err.message : String(err));
            } finally {
              busy = false;
              await paint();
            }
          })();
          return;
        } else if (action.type === "decide-approve" || action.type === "decide-reject") {
          const row = selected(last.approvals);
          if (!row) return;
          const decision = action.type === "decide-approve" ? "approve" : "reject";
          if (isMachineApiKey(config.apiKey ?? "")) {
            io.log(
              `Machine API keys cannot ${decision} from the TUI. Run: kya ${decision} --id ${row.id}`,
            );
            return;
          }
          arm({
            kind: "decide",
            id: row.id,
            decision,
            prompt: `${decision} ${row.id}? (needs kya.approve JWT scope)`,
          });
          return;
        } else {
          runPaint();
          return;
        }
        runPaint();
        return;
      } else if (action.type === "orr-run") {
        const result = deskOrr(config.cwd);
        orrSummary = {
          overall: result.report.overall,
          disposition: result.report.disposition,
          path: result.reportJsonPath ?? result.reportMdPath,
        };
        io.log("orr producer=sa.first_party");
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
      try {
        stdoutFd.write("\x1b[?2004l");
      } catch {
        /* ignore */
      }
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
