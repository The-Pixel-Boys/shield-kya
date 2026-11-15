/**
 * kya doctor: is the PreToolUse hook command still runnable? A hook whose node or
 * cli.js path is gone fails open with no notice, so doctor looks at the commands
 * the hosts will run (claude settings, grok hook file, kimi config) and at the
 * launcher kya start wrote in ~/.kya/bin/.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { launcherPath } from "./commands/wire-hooks.js";

export interface HookHealth {
  readonly launcher: "ok" | "fallback" | "missing" | "dead";
  readonly problems: readonly string[];
  readonly lines: readonly string[];
}

function commandsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  if (path.endsWith(".json")) {
    try {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (k === "command" && typeof x === "string") out.push(x);
            else walk(x);
          }
        }
      };
      walk(JSON.parse(text));
    } catch {
      /* unparseable: nothing to check */
    }
  } else {
    for (const m of text.matchAll(/^\s*command\s*=\s*(?:'([^'\n]*)'|"((?:[^"\\\n]|\\.)*)")/gm)) out.push(m[1] ?? m[2] ?? "");
  }
  return out.filter((c) => c.includes("hook --host"));
}

function shValue(text: string, name: string): string | undefined {
  const m = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'`, "m").exec(text);
  return m?.[1]?.replace(/'\\''/g, "'");
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  for (const d of (env.PATH ?? "").split(":")) if (isAbsolute(d) && existsSync(join(d, bin))) return true;
  return false;
}

export function hookHealth(home: string, env: NodeJS.ProcessEnv = process.env): HookHealth {
  const problems: string[] = [];
  const lines: string[] = [];
  let launcher: HookHealth["launcher"] = "missing";
  const lp = launcherPath(home);
  if (existsSync(lp)) {
    const text = readFileSync(lp, "utf8");
    const node = shValue(text, "KYA_NODE");
    const cli = shValue(text, "KYA_CLI");
    const nodeOk = node !== undefined && existsSync(node);
    const cliOk = cli !== undefined && existsSync(cli);
    if (nodeOk && cliOk) {
      launcher = "ok";
      lines.push(`hook launcher: ok (${lp})`);
    } else if ((onPath("node", env) && cliOk) || onPath("kya", env)) {
      launcher = "fallback";
      lines.push(`hook launcher: recorded ${!nodeOk ? `node ${node}` : `cli ${cli}`} is gone; it falls back to ${onPath("kya", env) ? "kya" : "node"} on PATH. Refresh it: kya start --force`);
    } else {
      launcher = "dead";
      const msg = `hook launcher: DEAD - node ${node ?? "?"} or ${cli ?? "?"} is gone and neither node nor kya is on PATH. The hook fails open (tool calls are NOT checked). Fix: reinstall kya, then kya start --force`;
      problems.push(msg);
      lines.push(msg);
    }
  } else {
    lines.push("hook launcher: not installed (kya start writes it when a hook is wired)");
  }
  const files = [
    join(home, ".claude", "settings.json"),
    join(home, ".grok", "hooks", "shield-kya.json"),
    join(home, ".kimi-code", "config.toml"),
  ];
  for (const f of files) {
    for (const cmd of commandsIn(f)) {
      for (const m of cmd.matchAll(/"([^"]+)"/g)) {
        const p = m[1]!;
        if (isAbsolute(p) && !existsSync(p)) {
          const msg = `hook in ${f}: path ${p} does not exist. The hook fails open (tool calls are NOT checked). Fix: kya connect <host> --hooks --force`;
          problems.push(msg);
          lines.push(msg);
        }
      }
    }
  }
  return { launcher, problems, lines };
}
