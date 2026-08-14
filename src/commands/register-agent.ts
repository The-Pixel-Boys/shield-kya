import { writeFileConfig, type ResolvedConfig } from "../config.js";
import { KyaHttpClient, type AgentResponse } from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";

export interface RegisterAgentResult {
  readonly agent: AgentResponse;
  readonly agentId: string;
  readonly configPath: string;
}

export async function runRegisterAgent(
  config: ResolvedConfig,
  input: { name: string; versionHash: string; breakGlassReason?: string },
  client?: KyaHttpClient,
): Promise<RegisterAgentResult> {
  if (!input.name?.trim()) {
    throw new UsageError("register-agent requires --name");
  }
  if (!input.versionHash?.trim()) {
    throw new UsageError("register-agent requires --version-hash");
  }

  const http =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
    });

  const agent = await http.registerAgent({
    name: input.name.trim(),
    versionHash: input.versionHash.trim(),
    breakGlassReason: input.breakGlassReason,
  });

  const agentId = String(agent.id);
  writeFileConfig(config.cwd, {
    baseUrl: config.baseUrl,
    host: config.host,
    agentId,
    agentName: agent.name,
  });

  return { agent, agentId, configPath: config.configPath };
}

export function registerAgentInputFromArgs(parsed: ParsedArgs): {
  name: string;
  versionHash: string;
  breakGlassReason?: string;
} {
  const name = flagString(parsed.flags, "name");
  const versionHash =
    flagString(parsed.flags, "version-hash", "versionHash") ?? "dev-local";
  const breakGlassReason = flagString(
    parsed.flags,
    "break-glass-reason",
    "breakGlassReason",
  );
  if (!name) {
    throw new UsageError(
      'register-agent requires --name "solo-builder" [--version-hash <hash>] [--break-glass-reason <why>]',
    );
  }
  if (breakGlassReason) {
    return { name, versionHash, breakGlassReason };
  }
  return { name, versionHash };
}
