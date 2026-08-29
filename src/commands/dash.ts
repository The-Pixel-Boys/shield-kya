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
import { isMachineApiKey } from "../client.js";
import { runWrap, wrapExitCode } from "./wrap.js";
import { runInvoke } from "./invoke.js";
import { runDecide } from "./decide.js";
import { runKillAgent, runShrinkSession } from "./ops.js";
import { runOrr } from "./orr.js";

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

export async function runDash(
  config: ResolvedConfig,
  parsed: ParsedArgs,
  io: DashIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const opts = dashOptionsFromArgs(parsed);
  const tty = io.isTty ?? Boolean(stdinFd.isTTY && stdoutFd.isTTY);
  const once = opts.once || !tty;

  let client: KyaHttpClient | undefined;
  if (!opts.offline && config.apiKey) {
    client = new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
      requireApiKey: true,
    });
  }

  const fetchPlane = client
    ? async () =>
        client!.request<{ plan?: string; dash?: string; features?: string[] }>(
          "/api/v1/kya/entitlement",
          { signal: AbortSignal.timeout(5000) },
        )
    : undefined;

  let pane = opts.pane;
  let offline = opts.offline;
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
        fetchPlaneEntitlement: fetchPlane,
        cursor,
        orrSummary,
      },
      env,
    );
    last = {
      agents: [...snap.agents],
      approvals: [...snap.approvals],
      sessions: [...snap.sessions],
    };
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
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      const raw = key?.ctrl && key.name === "c" ? "\u0003" : (str ?? key?.name ?? "");
      const action = mapKey(raw);
      if (action.type === "quit") {
        cleanup();
        resolve(0);
        return;
      }
      if (action.type === "help") {
        io.log(
          "1-7 panes · j/k move · w wrap · k kill · i invoke · b/R shrink · o orr · a/x approve/reject (JWT) · O offline · q",
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
      } else if (action.type === "pane" && action.pane) {
        pane = action.pane;
        cursor = 0;
      } else if (action.type === "register-hint") {
        io.log("Register: kya register-agent --name solo --version-hash dev-local");
        return;
      } else if (!opts.offline && client) {
        const cfg = { ...config, offline: false };
        void (async () => {
          try {
            if (action.type === "wrap") {
              const result = await runWrap(
                cfg,
                { toolId: "org.sample.data.write", irreversible: true },
                client,
              );
              io.log(`wrap exit ${wrapExitCode(result)} ${result.eval.response.verdict}`);
            } else if (action.type === "kill") {
              const row = selected(last.agents);
              if (!row) return;
              const killed = await runKillAgent(cfg, row.id, client);
              io.log(`${killed.status ?? "PAUSED"}  ${killed.id}`);
            } else if (action.type === "invoke") {
              const row = selected(last.approvals);
              if (!row) return;
              const result = await runInvoke(
                cfg,
                { toolId: String(row.action ?? "org.sample.data.write"), irreversible: true },
                client,
              );
              io.log(`invoke ${result.verdict} dispatched=${result.dispatched} ${result.sideEffect}`);
            } else if (action.type === "shrink-build" || action.type === "shrink-read") {
              const row = selected(last.sessions);
              if (!row) return;
              const to = action.type === "shrink-build" ? "BUILD" : "READ";
              const sh = await runShrinkSession(cfg, row.id, to, client);
              io.log(`clearance ${sh.from} → ${sh.to}`);
            } else if (action.type === "orr-run") {
              const result = deskOrr(config.cwd);
              orrSummary = {
                overall: result.report.overall,
                disposition: result.report.disposition,
                path: result.reportJsonPath ?? result.reportMdPath,
              };
            } else if (action.type === "decide-approve" || action.type === "decide-reject") {
              const row = selected(last.approvals);
              if (!row) return;
              if (isMachineApiKey(config.apiKey)) {
                io.log(`Machine key cannot decide. kya ${action.type === "decide-approve" ? "approve" : "reject"} --id ${row.id}`);
                return;
              }
              const decided = await runDecide(
                cfg,
                {
                  id: row.id,
                  decision: action.type === "decide-approve" ? "approve" : "reject",
                },
                client,
              );
              io.log(`${decided.status}: ${decided.id}`);
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
        const result = deskOrr(config.cwd);
        orrSummary = {
          overall: result.report.overall,
          disposition: result.report.disposition,
          path: result.reportJsonPath ?? result.reportMdPath,
        };
      }
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
    const cleanup = () => {
      stdinFd.setRawMode?.(false);
      stdinFd.off("keypress", onKey);
      stdinFd.pause();
    };
    stdinFd.on("keypress", onKey);
  });
}
