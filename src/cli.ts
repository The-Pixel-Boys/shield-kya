#!/usr/bin/env node
/**
 * @shield-agent/kya — light install CLI
 * Commands: init | register-agent | eval-tool | wrap | invoke | approve | reject
 *   | agents | agent | passport | kill | approvals | sessions | shrink
 *   | serve-mcp | orr run | dash
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
import { runDash } from "./commands/dash.js";
import {
  formatAgentTable,
  formatApprovalTable,
  formatSessionTable,
  requireId,
  runGetAgent,
  runGetPassport,
  runKillAgent,
  runListAgents,
  runListApprovals,
  runListSessions,
  runShrinkSession,
  shrinkToFromArgs,
} from "./commands/ops.js";
import {
  formatWrapHuman,
  runWrap,
  verdictExitCode,
  wrapExitCode,
  wrapInputFromArgs,
} from "./commands/wrap.js";
import { decideIdFromArgs, runDecide } from "./commands/decide.js";
import {
  formatInvokeHuman,
  invokeInputFromArgs,
  runInvoke,
} from "./commands/invoke.js";
import { runSandboxCommand } from "./commands/sandbox.js";

const HELP = `Shield KYA light CLI — Know Your Agent (provider-agnostic)

Usage:
  kya <command> [options]

Commands:
  init              Scaffold .kya/ config + sample tools + .env.example
  register-agent    POST /api/v1/kya/agents (human mint; server applies allow/break-glass/approve)
  eval-tool         Policy evaluate (HTTP plane or --offline sample)
  wrap              Evaluate then (on REQUIRE_APPROVE) open a ticket. Never executes.
  invoke            Authorize on the plane after Allow or APPROVED. Never runs the write here.
  approve           Human APPROVE an approval id (kya.approve scope)
  reject            Human REJECT an approval id (kya.approve scope)
  agents            List registered agents
  agent             Show one agent (--id)
  passport          Observational passport JSON (--id)
  kill              Pause an agent (--id)
  approvals         List the human queue
  sessions          List observed sessions
  shrink            Drop session clearance (--id --to BUILD|READ|DEPLOY)
  serve-mcp         Local MCP gate (HTTP default; --stdio for hosts)
  orr run           Read-only ORR board (reporting only — not a second PEP)
                    Optional: --producer harness.agentshield [--agentshield-json <file>]
  dash              Terminal desk (FREE panes; actions on a TTY, --once for CI)
  sandbox           Opt-in Firecracker wrap (spawn|exec|kill|status). Not MCP.
                    Requires KYA_SANDBOX=mock|firecracker. MCP still never execs.

Options (shared):
  --base-url <url>  Control plane origin (or KYA_BASE_URL)
  --api-key <key>   API key (or KYA_API_KEY) — required for network commands
  --host <ide|runtime>  Dual-plane host (or KYA_HOST, default ide)
  --offline         Sample evaluate / dash without network
  --once            dash: print one frame and exit (CI / pipes)
  --pane <name>     dash pane (home|policy|agents|approvals|sessions|orr|mcp|dashboard|…)
  --json            Machine-readable output
  --help, -h        Show help

Examples:
  npx @shield-agent/kya init --base-url http://127.0.0.1:8090 --host ide
  npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible
  npx @shield-agent/kya eval-tool --offline --tool-id org.sample.data.write --irreversible
  npx @shield-agent/kya register-agent --name solo-builder --version-hash dev-local
  npx @shield-agent/kya register-agent --name ops --version-hash dev --break-glass-reason "prod hotfix"
  npx @shield-agent/kya eval-tool --offline --tool-id kya.agent.register --irreversible
  npx @shield-agent/kya serve-mcp --stdio
  npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
  npx @shield-agent/kya orr run --path . --producer harness.agentshield --agentshield-json ./agentshield-report.json
  npx @shield-agent/kya wrap --offline --tool-id org.sample.data.write --irreversible
  npx @shield-agent/kya invoke --tool-id org.sample.data.write --args-hash <hash>
  npx @shield-agent/kya approve --id <approval-id>
  npx @shield-agent/kya agents
  npx @shield-agent/kya kill --id <agent-id>
  npx @shield-agent/kya shrink --id <session-id> --to BUILD
  npx @shield-agent/kya dash --once --offline
  npx @shield-agent/kya dash --once --pane policy

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
        return verdictExitCode(result.response.verdict);
      }

      case "wrap": {
        const input = wrapInputFromArgs(parsed);
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: !input.offline,
          offline: input.offline,
        });
        const result = await runWrap(config, input);
        if (config.json) {
          io.log(JSON.stringify(result, null, 2));
        } else {
          io.log(formatWrapHuman(result));
        }
        return wrapExitCode(result);
      }

      case "invoke": {
        const input = invokeInputFromArgs(parsed);
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const result = await runInvoke(config, input);
        if (config.json) {
          io.log(JSON.stringify(result, null, 2));
        } else {
          io.log(formatInvokeHuman(result));
        }
        return verdictExitCode(result.verdict);
      }

      case "approve":
      case "reject": {
        const id = decideIdFromArgs(parsed, parsed.command);
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const result = await runDecide(config, {
          id,
          decision: parsed.command,
        });
        if (config.json) {
          io.log(JSON.stringify(result, null, 2));
        } else {
          io.log(`${result.status}: ${result.id}`);
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
          io.log(
            `  token: ${result.http.token}  (header X-KYA-MCP-Token; /health is open)`,
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

      case "agents": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const rows = await runListAgents(config);
        io.log(config.json ? JSON.stringify(rows, null, 2) : formatAgentTable(rows));
        return 0;
      }

      case "agent": {
        const id = requireId(parsed, "agent");
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const row = await runGetAgent(config, id);
        io.log(config.json ? JSON.stringify(row, null, 2) : formatAgentTable([row]));
        return 0;
      }

      case "passport": {
        const id = requireId(parsed, "passport");
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const doc = await runGetPassport(config, id);
        io.log(JSON.stringify(doc, null, 2));
        return 0;
      }

      case "kill": {
        const id = requireId(parsed, "kill");
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const row = await runKillAgent(config, id);
        if (config.json) io.log(JSON.stringify(row, null, 2));
        else io.log(`${row.status ?? "PAUSED"}  ${row.id}  ${row.name}`);
        return 0;
      }

      case "approvals": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const rows = await runListApprovals(config);
        io.log(config.json ? JSON.stringify(rows, null, 2) : formatApprovalTable(rows));
        return 0;
      }

      case "sessions": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const rows = await runListSessions(config);
        io.log(config.json ? JSON.stringify(rows, null, 2) : formatSessionTable(rows));
        return 0;
      }

      case "shrink": {
        const id = requireId(parsed, "shrink");
        const to = shrinkToFromArgs(parsed);
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: true,
        });
        const row = await runShrinkSession(config, id, to);
        if (config.json) io.log(JSON.stringify(row, null, 2));
        else io.log(`clearance ${row.from} → ${row.to}  ${row.id}`);
        return 0;
      }

      case "dash": {
        const config = resolveConfig({
          cwd,
          env,
          flags: parsed.flags,
          requireApiKey: false,
          allowMissingApiKey: true,
          offline: parsed.flags["offline"] === true || parsed.flags["offline"] === "true",
        });
        return await runDash(config, parsed, io, env);
      }

      case "sandbox": {
        return await runSandboxCommand(parsed);
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
