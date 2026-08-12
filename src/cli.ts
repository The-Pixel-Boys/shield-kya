#!/usr/bin/env node
/**
 * @shield-agent/kya — light install CLI
 * Commands: init | register-agent | eval-tool | serve-mcp | orr run
 * Fail-closed: empty KYA_API_KEY against auth plane → non-zero exit.
 * Offline sample: eval-tool --offline (demo only; not production PEP).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.js";
import { KyaError } from "./errors.js";
import { parseArgs } from "./parse-args.js";
import { initFromArgs } from "./commands/init.js";
import {
  registerAgentInputFromArgs,
  runRegisterAgent,
} from "./commands/register-agent.js";
import {
  evalToolInputFromArgs,
  formatEvalHuman,
  runEvalTool,
} from "./commands/eval-tool.js";
import {
  runServeMcp,
  serveMcpOptionsFromArgs,
} from "./commands/serve-mcp.js";
import {
  orrRunOptionsFromArgs,
  runOrr,
} from "./commands/orr.js";

const HELP = `Shield KYA light CLI — Know Your Agent (provider-agnostic)

Usage:
  kya <command> [options]

Commands:
  init              Scaffold .kya/ config + sample tools + .env.example
  register-agent    POST /api/v1/kya/agents (stores agentId in .kya/config.json)
  eval-tool         Policy evaluate (HTTP plane or --offline sample)
  serve-mcp         Local MCP gate (HTTP default; --stdio for hosts)
  orr run           Read-only ORR board (reporting only — not a second PEP)

Options (shared):
  --base-url <url>  Control plane origin (or KYA_BASE_URL)
  --api-key <key>   API key (or KYA_API_KEY) — required for network commands
  --host <ide|runtime>  Dual-plane host (or KYA_HOST, default ide)
  --offline         Sample evaluate without network (eval-tool only)
  --json            Machine-readable output
  --help, -h        Show help

Examples:
  npx @shield-agent/kya init --base-url http://127.0.0.1:8090 --host ide
  npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible
  npx @shield-agent/kya eval-tool --offline --tool-id org.sample.data.write --irreversible
  npx @shield-agent/kya register-agent --name solo-builder --version-hash dev-local
  npx @shield-agent/kya serve-mcp --stdio
  npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers

Docs: https://shield-agent.com/install · docs/guides/kya-light-install.md
Doctrine: sole PEP is Shield; DENY is hard; missing APPROVED ⇒ no irreversible side effect.
`;

export interface CliIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  readonly exit: (code: number) => void;
}

const defaultIo: CliIo = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  exit: (c) => process.exit(c),
};

/** Testable entry — does not call process.exit when custom io.exit is provided that throws. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  const parsed = parseArgs(argv);

  if (
    !parsed.command ||
    parsed.command === "help" ||
    parsed.flags["help"] === true ||
    parsed.flags["h"] === true
  ) {
    io.log(HELP);
    return 0;
  }

  try {
    switch (parsed.command) {
      case "init": {
        const result = initFromArgs(parsed, cwd);
        if (parsed.flags["json"] === true || parsed.flags["json"] === "true") {
          io.log(JSON.stringify(result, null, 2));
        } else {
          io.log("KYA light scaffold ready (zero vertical packs required)");
          for (const p of result.created) io.log(`  created: ${p}`);
          for (const p of result.skipped) io.log(`  exists:  ${p}`);
          io.log(
            "Next: offline demo → npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible",
          );
          io.log(
            "Or: cp .env.example .env && set KYA_API_KEY, then register-agent",
          );
        }
        return 0;
      }

      case "register-agent": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const input = registerAgentInputFromArgs(parsed);
        const result = await runRegisterAgent(config, input);
        if (config.json) {
          io.log(JSON.stringify(result, null, 2));
        } else {
          io.log(`agentId: ${result.agentId}`);
          io.log(`name: ${result.agent.name}`);
          io.log(`stored: ${result.configPath}`);
        }
        return 0;
      }

      case "eval-tool": {
        const input = evalToolInputFromArgs(parsed);
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: !input.offline,
          offline: input.offline,
        });
        const result = await runEvalTool(config, input);
        if (config.json) {
          io.log(
            JSON.stringify(
              { ...result.response, offline: result.offline },
              null,
              2,
            ),
          );
        } else {
          io.log(formatEvalHuman(result));
        }
        return 0;
      }

      case "serve-mcp": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const opts = serveMcpOptionsFromArgs(parsed);
        const result = await runServeMcp(config, opts);
        if (result.mode === "http" && result.http) {
          io.log(
            `KYA MCP gate listening on ${result.http.url} (host=${config.host})`,
          );
          io.log("  GET  /health");
          io.log("  GET  /connectors/mcp.json");
          io.log("  GET  /mcp/tools");
          io.log("  POST /mcp  (JSON-RPC)");
          io.log("  tools: kya.policy_evaluate | kya.session_ingest | kya.request_approval");
          io.log(
            "  fail-closed: evaluate/request only — no irreversible side effects without APPROVED",
          );
          await new Promise<void>((resolve) => {
            const stop = () => {
              void result.http?.close().finally(resolve);
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
        } else if (result.mode === "stdio" && result.stdio) {
          await result.stdio.done;
        }
        return 0;
      }

      case "orr": {
        const sub = parsed.positionals[0];
        if (sub !== "run") {
          io.error('Usage: kya orr run --path <dir> [options]');
          io.log(
            "ORR is a reporting orchestrator only (not a second PEP). See docs/dev/kya-orr-cli.md",
          );
          return 1;
        }
        // Re-parse with flags after "orr run" — positionals after subcommand already in flags from original parse
        const opts = orrRunOptionsFromArgs(parsed);
        const result = runOrr(opts);
        if (opts.jsonStdout || parsed.flags["json"] === true) {
          io.log(JSON.stringify(result.report, null, 2));
        } else if (!opts.quiet) {
          io.log(
            `ORR ${result.report.overall} / ${result.report.disposition} → ${result.reportJsonPath ?? result.reportMdPath ?? opts.out}`,
          );
          io.log(
            `(reporting only — sole PEP remains Shield KYA; scanners are evidence)`,
          );
        }
        return result.exitCode;
      }

      default:
        io.error(`Unknown command: ${parsed.command}`);
        io.log(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof KyaError) {
      io.error(`error: ${err.message} [${err.code}]`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.error(`error: ${message}`);
    return 1;
  }
}

// Only auto-run when executed as CLI entry (not when imported by tests).
// Bin links resolve as ".../bin/kya" not ".../cli.js" — compare realpaths.
function isCliEntry(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    const a = process.argv[1];
    return (
      a.endsWith("/cli.js") ||
      a.endsWith("/cli.ts") ||
      a.endsWith("/kya") ||
      a.endsWith("/shield-kya") ||
      a.includes("@shield-agent/kya")
    );
  }
}

if (isCliEntry()) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
