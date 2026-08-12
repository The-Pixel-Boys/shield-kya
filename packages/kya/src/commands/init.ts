import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Host } from "../config.js";
import { configDir, writeFileConfig } from "../config.js";
import { SAMPLE_TOOLS } from "../sample-tools.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";

export interface InitResult {
  readonly cwd: string;
  readonly configPath: string;
  readonly toolsPath: string;
  readonly envExamplePath: string;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

export interface InitOptions {
  readonly cwd?: string;
  readonly baseUrl?: string;
  readonly host?: Host;
  readonly force?: boolean;
}

export function runInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd();
  const dir = configDir(cwd);
  mkdirSync(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  const configPath = join(dir, "config.json");
  const toolsPath = join(dir, "tools.sample.json");
  const envExamplePath = join(cwd, ".env.example");

  const baseUrl = options.baseUrl ?? "http://127.0.0.1:8090";
  const host = options.host ?? "ide";

  if (!existsSync(configPath) || options.force) {
    writeFileConfig(cwd, { baseUrl, host });
    created.push(configPath);
  } else {
    skipped.push(configPath);
  }

  if (!existsSync(toolsPath) || options.force) {
    writeFileSync(
      toolsPath,
      `${JSON.stringify({ tools: SAMPLE_TOOLS, packsRequired: false }, null, 2)}\n`,
      "utf8",
    );
    created.push(toolsPath);
  } else {
    skipped.push(toolsPath);
  }

  if (!existsSync(envExamplePath) || options.force) {
    writeFileSync(envExamplePath, ENV_EXAMPLE, "utf8");
    created.push(envExamplePath);
  } else {
    skipped.push(envExamplePath);
  }

  return { cwd, configPath, toolsPath, envExamplePath, created, skipped };
}

export function initFromArgs(
  parsed: ParsedArgs,
  cwd = process.cwd(),
): InitResult {
  const baseUrl = flagString(parsed.flags, "base-url");
  const hostRaw = flagString(parsed.flags, "host");
  const host =
    hostRaw === "runtime" || hostRaw === "ide" ? hostRaw : undefined;
  const force = parsed.flags["force"] === true || parsed.flags["force"] === "true";
  return runInit({ cwd, baseUrl, host, force });
}

const ENV_EXAMPLE = `# Shield KYA light install — copy to .env (never commit secrets)
# Docs: docs/guides/kya-light-install.md

# Control plane origin (hosted or local free console)
KYA_BASE_URL=http://127.0.0.1:8090

# API key when the plane requires auth (empty key → CLI fails closed)
KYA_API_KEY=

# Dual-plane host: ide (authoring) | runtime (production)
KYA_HOST=ide

# Filled by: npx @shield-agent/kya register-agent
# KYA_AGENT_ID=

# Local MCP gate port (serve-mcp)
KYA_MCP_PORT=3920

# Optional tenant label for local logs only (server binds tenant from auth)
# KYA_TENANT_HINT=
`;
