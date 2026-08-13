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

  const paint = async () => {
    const snap = await renderDash(
      { ...config, offline },
      { once: true, offline, pane, client, fetchPlaneEntitlement: fetchPlane },
      env,
    );
    io.log(snap.frame);
    return snap;
  };

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
        io.log("1-7 free panes · d dashboard · c cases · m metrics · e edge · s settings · o offline · q quit");
        return;
      }
      if (action.type === "noop" || painting) return;
      if (action.type === "offline") offline = !offline;
      else if (action.type === "pane" && action.pane) pane = action.pane;
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
