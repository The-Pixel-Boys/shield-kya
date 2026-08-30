import type { PolicyEvaluateResponse } from "../client.js";
import { resolveConfig } from "../config.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import { runEvalTool } from "./eval-tool.js";
import { assertSandboxId } from "../sandbox/id.js";
import { jailRoot } from "../sandbox/path-jail.js";
import {
  killSandbox,
  loadSandboxState,
  resolveSandboxDriver,
  spawnSandbox,
} from "../sandbox/runtime.js";

function verdictExit(verdict: string): number {
  if (verdict === "DENY") return 1;
  if (verdict === "REQUIRE_APPROVE") return 4;
  return 0;
}

export async function runSandboxCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  if (!sub) {
    throw new UsageError(
      "sandbox requires a subcommand: spawn | exec | kill | status",
    );
  }

  const offlineFlag = flagBool(parsed.flags, "offline");
  const apiKey = process.env.KYA_API_KEY?.trim();
  const useOffline = offlineFlag || !apiKey;
  const config = resolveConfig({
    flags: parsed.flags,
    requireApiKey: !useOffline,
    allowMissingApiKey: useOffline,
    offline: useOffline,
  });
  const root = jailRoot(flagString(parsed.flags, "path") ?? process.cwd());
  const driver = resolveSandboxDriver(
    flagString(parsed.flags, "sandbox") ?? process.env.KYA_SANDBOX,
  );

  async function evaluate(
    toolId: string,
    irreversible: boolean,
    sandboxId?: string,
  ): Promise<PolicyEvaluateResponse> {
    const result = await runEvalTool(config, {
      toolId,
      irreversible,
      sandboxId,
      offline: useOffline,
    });
    return result.response;
  }

  if (sub === "spawn") {
    const policy = await evaluate("org.sample.sandbox.spawn", true);
    if (policy.verdict !== "ALLOW") {
      process.stdout.write(
        `verdict: ${policy.verdict}\nreasonCode: ${policy.reasonCode}\nsideEffect: blocked\n`,
      );
      return verdictExit(policy.verdict);
    }
    const row = await spawnSandbox({
      root,
      driver,
      agentId: config.agentId,
    });
    process.stdout.write(
      [`sandboxId: ${row.sandboxId}`, `backend: ${row.backend}`, ""].join("\n"),
    );
    return 0;
  }

  if (sub === "exec") {
    const sandboxId = assertSandboxId(
      flagString(parsed.flags, "sandbox-id", "sandboxId"),
    );
    const policy = await evaluate(
      "org.sample.sandbox.exec",
      true,
      sandboxId,
    );
    if (policy.verdict !== "ALLOW") {
      process.stdout.write(
        `verdict: ${policy.verdict}\nreasonCode: ${policy.reasonCode}\nsideEffect: blocked\n`,
      );
      return verdictExit(policy.verdict);
    }
    const cmdRaw = flagString(parsed.flags, "cmd") ?? "true";
    const result = await driver.exec({
      sandboxId,
      command: cmdRaw.split(/\s+/).filter(Boolean),
    });
    process.stdout.write(
      `verdict: ALLOW\nexitCode: ${result.exitCode}\nstdout: ${result.stdout}\n`,
    );
    return result.exitCode;
  }

  if (sub === "kill") {
    const sandboxId = assertSandboxId(
      flagString(parsed.flags, "sandbox-id", "sandboxId"),
    );
    await killSandbox({ root, driver, sandboxId });
    process.stdout.write(`killed: ${sandboxId}\n`);
    return 0;
  }

  if (sub === "status") {
    const rows = loadSandboxState(root);
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  throw new UsageError(`unknown sandbox subcommand: ${sub}`);
}
