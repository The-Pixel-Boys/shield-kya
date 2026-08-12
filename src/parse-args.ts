/**
 * Minimal argv parser — no external CLI framework.
 * Supports: flags (--foo), values (--foo bar | --foo=bar), boolean (--stdio), positionals.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  // drop node + script path when present (cli entry strips itself; tests pass raw)
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        flags[key] = value;
        continue;
      }
      const key = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        // boolean-looking flags stay boolean when next is another command-like word
        // only consume next if it looks like a value (not a known pattern of pure flag)
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length === 2) {
      const key = token.slice(1);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

export function flagString(
  flags: Readonly<Record<string, string | boolean>>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function flagBool(
  flags: Readonly<Record<string, string | boolean>>,
  ...names: string[]
): boolean {
  for (const name of names) {
    const v = flags[name];
    if (v === true || v === "true" || v === "1") return true;
    if (v === false || v === "false" || v === "0") return false;
  }
  return false;
}

export function flagInt(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
  fallback: number,
): number {
  const v = flags[name];
  if (typeof v === "string" && v.length > 0) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
