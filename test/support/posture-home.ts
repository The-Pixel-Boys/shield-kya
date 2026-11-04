/**
 * Fixture machine for the posture tests: a KYA home with a pre-seeded device id and label, one
 * agent CLI on a fixture PATH, editor extensions (one of them the IoC version), an MCP config
 * with planted secrets in its env block, and a stored IoC result, so no test scans the real
 * machine. Everything here is written under a temp dir.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PLANTED_ENV_NAME = "PLANTED_POSTURE_NAME_TOKEN";
export const PLANTED_ENV_VALUE = "planted-posture-value-9f8e7d6c";
export const DEVICE_ID = "dev-golden-0001";
export const LABEL = "golden-desk";
export const NOW = new Date("2026-10-30T12:00:00.000Z");

export interface PostureHome {
  readonly home: string;
  readonly bin: string;
  /** Environment for every posture call: KYA home, fixture PATH, planted values. */
  readonly env: NodeJS.ProcessEnv;
}

export function makePostureHome(opts: { readonly hostedBaseUrl?: string } = {}): PostureHome {
  const root = mkdtempSync(join(tmpdir(), "kya-posture-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".kya"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);

  const ext = (rel: string, dir: string): void => {
    mkdirSync(join(home, rel, dir), { recursive: true });
  };
  ext(".vscode/extensions", "anthropic.claude-code-2.1.313-darwin-arm64"); // IoC version
  ext(".vscode/extensions", "anthropic.claude-code-2.1.314-darwin-arm64");
  ext(".cursor/extensions", "github.copilot-chat-0.22.0"); // longest id wins over github.copilot
  ext(".vscode/extensions", "ms-python.python-2024.1.0"); // not an agent extension: never reported

  writeFileSync(
    join(home, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp?token=planted-url-secret" },
        fs: {
          command: "/usr/local/bin/mcp-filesystem",
          args: ["/Users/alice/private-folder", "--token", PLANTED_ENV_VALUE],
          env: { [PLANTED_ENV_NAME]: PLANTED_ENV_VALUE },
        },
      },
    }),
  );

  writeFileSync(join(home, ".kya", "device-id"), `${DEVICE_ID}\n`, { mode: 0o600 });
  writeFileSync(
    join(home, ".kya", "config.json"),
    `${JSON.stringify({ posture: { label: LABEL }, ioc: { enabled: true } }, null, 2)}\n`,
  );
  writeFileSync(
    join(home, ".kya", "ioc-latest.json"),
    `${JSON.stringify(
      {
        schema: 1,
        checkedAt: NOW.toISOString(),
        listVersion: "2026-10-30.1",
        skipped: 0,
        findings: [
          {
            ioc: "ioc-2026-claude-vscode-trojan",
            check: "extension",
            severity: "critical",
            evidence: "~/.vscode/extensions/anthropic.claude-code-2.1.313-darwin-arm64",
            hint: "Update the extension to a release that is not listed here, restart the editor, then rotate the credentials it could read.",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  if (opts.hostedBaseUrl !== undefined) {
    writeHostedCredentials(home, opts.hostedBaseUrl);
  }

  const env: NodeJS.ProcessEnv = {
    KYA_HOME: home,
    PATH: bin,
    [PLANTED_ENV_NAME]: PLANTED_ENV_VALUE,
  };
  return { home, bin, env };
}

export function writeHostedCredentials(home: string, baseUrl: string): void {
  writeFileSync(
    join(home, ".kya", "hosted-credentials.json"),
    `${JSON.stringify({ baseUrl, apiKey: "sk_test_0123456789abcdef", keyPrefix: "sk_test_", createdAt: NOW.toISOString() })}\n`,
    { mode: 0o600 },
  );
}
