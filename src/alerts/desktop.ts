/**
 * Desktop notification for a new incident alert. macOS: osascript. Linux: notify-send when it exists.
 * Windows: a PowerShell toast. The text is static: a fixed title, the severity and the detector ids
 * (ids pass the safe-id check in triage-input.ts). No summary, tool name or path from the trail is shown.
 * Arguments go to the program as argv (execFile, no shell). Windows reads the text from two environment
 * variables, because PowerShell has no argv-safe way to pass text to a script block.
 * Advisory and fail open: a missing notifier or a failure returns false and changes nothing else.
 */
import { execFile } from "node:child_process";
import type { IncidentAlert } from "./incident-alert.js";

export const DESKTOP_TITLE = "KYA security alert";
const TIMEOUT_MS = 5_000;

const OSA_SCRIPT = ["on run argv", "display notification (item 1 of argv) with title (item 2 of argv)", "end run"];
const WIN_SCRIPT = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode($env:KYA_TOAST_TITLE)) | Out-Null",
  "$t.Item(1).AppendChild($x.CreateTextNode($env:KYA_TOAST_BODY)) | Out-Null",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('KYA').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("; ");

export interface DesktopCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export function desktopCommand(platform: NodeJS.Platform, title: string, body: string): DesktopCommand | undefined {
  switch (platform) {
    case "darwin":
      return { file: "osascript", args: [...OSA_SCRIPT.flatMap((l) => ["-e", l]), body, title] };
    case "linux":
      return { file: "notify-send", args: ["--app-name", "KYA", "--", title, body] };
    case "win32":
      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_SCRIPT],
        env: { KYA_TOAST_TITLE: title, KYA_TOAST_BODY: body },
      };
    default:
      return undefined;
  }
}

/** `severity: <level>. Detectors: <ids>.` Only fixed words and safe ids. */
export function desktopBody(alert: Pick<IncidentAlert, "severity" | "detectorIds" | "test">): string {
  const safe = alert.detectorIds.filter((d) => /^[a-z0-9-]{1,40}$/.test(d));
  const ids = safe.length > 0 ? safe.join(", ") : "none";
  return `${alert.test ? "Test. " : ""}Severity: ${alert.severity}. Detectors: ${ids}. Open kya report.`;
}

export type DesktopRunner = (cmd: DesktopCommand, env: NodeJS.ProcessEnv) => Promise<boolean>;

const defaultRun: DesktopRunner = (cmd, env) =>
  new Promise((resolve) => {
    execFile(
      cmd.file,
      [...cmd.args],
      { env: { ...env, ...cmd.env }, timeout: TIMEOUT_MS, windowsHide: true, shell: false },
      (err) => resolve(!err),
    );
  });

export interface DesktopDeps {
  /** Test seam: the platform. */
  readonly platform?: NodeJS.Platform;
  /** Test seam: runs the command. */
  readonly run?: DesktopRunner;
}

export async function desktopNotify(alert: IncidentAlert, env: NodeJS.ProcessEnv, deps: DesktopDeps = {}): Promise<boolean> {
  try {
    const cmd = desktopCommand(deps.platform ?? process.platform, DESKTOP_TITLE, desktopBody(alert));
    if (!cmd) return false;
    return await (deps.run ?? defaultRun)(cmd, env);
  } catch {
    return false;
  }
}
