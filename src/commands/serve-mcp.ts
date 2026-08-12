import type { ResolvedConfig } from "../config.js";
import { KyaHttpClient } from "../client.js";
import { startHttpMcp, type HttpMcpServer } from "../mcp/http.js";
import { startStdioMcp, type StdioMcpHandle } from "../mcp/stdio.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagInt } from "../parse-args.js";

export type ServeMcpMode = "stdio" | "http";

export interface ServeMcpOptions {
  readonly mode: ServeMcpMode;
  readonly port?: number;
  readonly listenHost?: string;
}

export interface ServeMcpResult {
  readonly mode: ServeMcpMode;
  readonly http?: HttpMcpServer;
  readonly stdio?: StdioMcpHandle;
}

export function serveMcpOptionsFromArgs(parsed: ParsedArgs): ServeMcpOptions {
  const stdio = flagBool(parsed.flags, "stdio");
  const port = flagInt(parsed.flags, "port", 0);
  return {
    mode: stdio ? "stdio" : "http",
    port: port > 0 ? port : undefined,
    listenHost: "127.0.0.1",
  };
}

export async function runServeMcp(
  config: ResolvedConfig,
  options: ServeMcpOptions,
  client?: KyaHttpClient,
): Promise<ServeMcpResult> {
  const httpClient =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
    });

  if (options.mode === "stdio") {
    const stdio = startStdioMcp({
      client: httpClient,
      kyaHost: config.host,
      agentId: config.agentId,
    });
    return { mode: "stdio", stdio };
  }

  const port = options.port ?? config.mcpPort;
  const http = await startHttpMcp({
    host: options.listenHost ?? "127.0.0.1",
    port,
    client: httpClient,
    kyaHost: config.host,
    agentId: config.agentId,
  });
  return { mode: "http", http };
}
