import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedConfig } from "../config.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";
import { assertNoSecrets } from "../dash/render.js";
import {
  loadReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../receipt/render-receipt.js";
import { ensureReceiptDaemon } from "../receipt/daemon.js";
import { receiptsDir } from "../trail.js";

export const DEFAULT_RECEIPT_DAYS = 3;

/** Serializable receipt artifacts (paths + counts). */
export interface ReceiptArtifacts {
  readonly title: string;
  readonly rangeLabel: string;
  readonly htmlPath: string;
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly eventCount: number;
  readonly days: number;
}

/** Static write-only result (no live server). */
export type StaticReceiptResult = ReceiptArtifacts & {
  readonly liveUrl?: undefined;
  readonly daemonPid?: undefined;
  readonly daemonReused?: undefined;
};

/** Live result: background daemon URL + pid are both required. */
export type LiveReceiptResult = ReceiptArtifacts & {
  readonly liveUrl: string;
  readonly daemonPid: number;
  readonly daemonReused: boolean;
};

export type ReceiptResult = StaticReceiptResult | LiveReceiptResult;

export async function runReceipt(
  config: ResolvedConfig,
  input: { sessionId?: string; days?: number; open?: boolean; outDir?: string },
): Promise<ReceiptResult> {
  const sessionId = input.sessionId?.trim();
  const days =
    input.days != null && Number.isFinite(input.days) && input.days > 0
      ? Math.floor(input.days)
      : DEFAULT_RECEIPT_DAYS;

  // Static on-disk artifacts always use live:false (no EventSource on file://).
  const model = loadReceiptModel({
    cwd: config.cwd,
    sessionId,
    days,
    live: false,
  });

  const dir = input.outDir?.trim() || receiptsDir(config.cwd);
  mkdirSync(dir, { recursive: true });
  const safe = (sessionId ?? `last-${days}d`).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const htmlPath = join(dir, `${safe}.html`);
  const jsonPath = join(dir, `${safe}.json`);
  const mdPath = join(dir, `${safe}.md`);

  const html = renderReceiptHtml(model);
  const md = renderReceiptMarkdown(model);
  const jsonBody = `${JSON.stringify(model, null, 2)}\n`;
  assertNoSecrets(jsonBody);

  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(jsonPath, jsonBody, "utf8");
  writeFileSync(mdPath, md, "utf8");

  const base: ReceiptArtifacts = {
    title: model.title,
    rangeLabel: model.rangeLabel,
    htmlPath,
    jsonPath,
    mdPath,
    eventCount: model.events.length,
    days,
  };

  if (!input.open) {
    return base;
  }

  const daemon = await ensureReceiptDaemon(config, { days, sessionId });
  openPath(daemon.url);

  return {
    ...base,
    liveUrl: daemon.url,
    daemonPid: daemon.pid,
    daemonReused: daemon.reused,
  };
}

export function receiptInputFromArgs(parsed: ParsedArgs) {
  const daysRaw = flagString(parsed.flags, "days");
  const days = daysRaw ? Number.parseInt(daysRaw, 10) : undefined;
  return {
    sessionId: flagString(parsed.flags, "session", "session-id", "sessionId"),
    days: Number.isFinite(days) ? days : undefined,
    open: parsed.flags["open"] === true || parsed.flags["open"] === "true",
    outDir: flagString(parsed.flags, "out", "out-dir", "outDir"),
  };
}

export function formatReceiptHuman(r: ReceiptResult): string {
  const lines = [
    `${r.title} (${r.rangeLabel})`,
    `events: ${r.eventCount}`,
    `html: ${r.htmlPath}`,
    `json: ${r.jsonPath}`,
    `md: ${r.mdPath}`,
  ];
  if (r.liveUrl) {
    lines.push(`live: ${r.liveUrl}`);
    lines.push("report runs in the background - kya stop to stop");
  }
  return lines.join("\n");
}

export function openPath(target: string): void {
  if (process.env.KYA_NO_BROWSER === "1") return;
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
  child.on("error", (err) => {
    process.stderr.write(`failed to open browser: ${err.message}\n`);
  });
  child.unref();
}
