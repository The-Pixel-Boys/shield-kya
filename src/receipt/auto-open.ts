/**
 * After wrap, surface the activity receipt so developers do not have to
 * discover `kya receipt --open` manually.
 *
 * Default: interactive TTY → write receipt HTML and open the browser once
 * per cwd (always on DENY/never-event). Disable with KYA_RECEIPT_AUTO=0.
 * Force with KYA_RECEIPT_AUTO=1 (even non-TTY / CI).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedConfig } from "../config.js";
import { configDir } from "../config.js";
import { runReceipt } from "../commands/receipt.js";

export function shouldAutoOpenReceipt(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY),
): boolean {
  const flag = (env.KYA_RECEIPT_AUTO ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  if (env.CI) return false;
  return isTty;
}

function markerPath(cwd: string): string {
  return join(configDir(cwd), ".receipt-autopen");
}

function alreadyOpened(cwd: string): boolean {
  return existsSync(markerPath(cwd));
}

function markOpened(cwd: string): void {
  mkdirSync(configDir(cwd), { recursive: true });
  writeFileSync(markerPath(cwd), `${new Date().toISOString()}\n`, "utf8");
}

function openBrowser(target: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* browser optional */
  });
  child.unref();
}

export interface AutoOpenResult {
  readonly opened: boolean;
  readonly htmlPath?: string;
  readonly hint: string;
}

/**
 * Write the latest receipt and optionally open it in the browser.
 * @param force — open even if already opened this cwd (use on DENY).
 */
export async function autoOpenReceiptAfterWrap(
  config: ResolvedConfig,
  opts: { force?: boolean; env?: NodeJS.ProcessEnv; isTty?: boolean } = {},
): Promise<AutoOpenResult> {
  const env = opts.env ?? process.env;
  const hint = "View activity: kya receipt --open";
  const want = shouldAutoOpenReceipt(env, opts.isTty ?? Boolean(process.stdout.isTTY));
  if (!want) {
    return { opened: false, hint };
  }

  const force = Boolean(opts.force);
  const skipOpen = !force && alreadyOpened(config.cwd);

  const receipt = await runReceipt(config, { open: false });
  if (skipOpen) {
    return { opened: false, htmlPath: receipt.htmlPath, hint: `${hint}\nreceipt: ${receipt.htmlPath}` };
  }

  openBrowser(receipt.htmlPath);
  markOpened(config.cwd);
  return {
    opened: true,
    htmlPath: receipt.htmlPath,
    hint: `receipt opened: ${receipt.htmlPath}\nLive updates: kya receipt --open`,
  };
}
