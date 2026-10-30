/**
 * `kya login` (device code flow to the hosted console) and `kya logout` (delete the local key).
 *
 * Explicit commands: a failure exits 1 and stores nothing. Neither command runs on the hook,
 * evaluate or certify path, so the OSS verdicts never depend on them.
 */
import { deleteCredentials, credentialsPath, readCredentials, writeCredentials } from "../login/credentials.js";
import {
  LoginError,
  pollForToken,
  requestDeviceCode,
  validateConsoleUrl,
  type DeviceFlowDeps,
} from "../login/device-flow.js";
import { CLI_VERSION } from "../version.js";

/** The hosted console the API key belongs to. KYA_BASE_URL or --base-url overrides (dev and tests). */
export const DEFAULT_CONSOLE_URL = "https://shield-agent.com";

export interface LoginIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
}

/**
 * The browser opener for `kya login`: none when KYA_NO_BROWSER=1 or when nobody is at a terminal
 * (CI, pipes, scripts), otherwise the opener passed in. Pure, so it can be tested without a browser.
 */
export function loginBrowserOpener(
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  open: (url: string) => void,
): ((url: string) => void) | undefined {
  return env.KYA_NO_BROWSER === "1" || !interactive ? undefined : open;
}

export interface LoginInput {
  readonly io: LoginIo;
  readonly env: NodeJS.ProcessEnv;
  readonly baseUrl?: string;
  /** Opens the verification page. Injected: the CLI passes the browser opener, tests pass a no-op. */
  readonly open?: (url: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: DeviceFlowDeps["sleep"];
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

export async function runLogin(input: LoginInput): Promise<number> {
  try {
    const base = validateConsoleUrl(input.baseUrl ?? input.env.KYA_BASE_URL?.trim() ?? DEFAULT_CONSOLE_URL);
    const deps: DeviceFlowDeps = {
      clientVersion: CLI_VERSION,
      fetch: input.fetch,
      sleep: input.sleep,
      now: input.now,
      requestTimeoutMs: input.requestTimeoutMs,
    };
    const code = await requestDeviceCode(base, deps);
    input.io.log(`To link this machine, open: ${code.verificationUri}`);
    input.io.log(`and enter the code: ${code.userCode}`);
    input.io.log(`The code expires in ${Math.ceil(code.expiresInSec / 60)} minutes.`);
    input.io.log("Approve it in the console only if you started this login yourself.");
    input.open?.(code.verificationUri);
    input.io.log("Waiting for approval...");
    const token = await pollForToken(base, code, deps);
    const createdAt = new Date((input.now ?? Date.now)()).toISOString();
    try {
      const path = writeCredentials({ baseUrl: base.origin, apiKey: token.apiKey, keyPrefix: token.keyPrefix, createdAt }, input.env);
      input.io.log(`Logged in. Key ${token.keyPrefix}... saved to ${path} (mode 0600).`);
    } catch {
      // The key was minted on the server. Say so, so the user can revoke it in Settings.
      input.io.error(
        `Approved, but the key could not be saved to ${credentialsPath(input.env)}. ` +
          "Revoke the new key in the hosted console (Settings, API keys) and try again.",
      );
      return 1;
    }
    return 0;
  } catch (err) {
    input.io.error(err instanceof LoginError ? err.message : "kya login failed; nothing was saved");
    return 1;
  }
}

export interface LogoutInput {
  readonly io: LoginIo;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Delete the local key file. The server key is NOT revoked here (no self-revoke route yet):
 * the message tells the user to revoke it in the console.
 */
export function runLogout(input: LogoutInput): number {
  const had = readCredentials(input.env) !== undefined;
  const removed = deleteCredentials(input.env);
  if (!had && !removed) {
    input.io.log("No hosted login on this machine. Nothing to remove.");
    return 0;
  }
  if (!removed) {
    input.io.error(`Could not remove ${credentialsPath(input.env)}. Delete it by hand.`);
    return 1;
  }
  input.io.log(`Removed the saved hosted key: ${credentialsPath(input.env)}`);
  input.io.log("The key stays active on the server until you revoke it in the hosted console (Settings, API keys).");
  return 0;
}
