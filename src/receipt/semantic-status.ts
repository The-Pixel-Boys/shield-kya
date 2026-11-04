/**
 * Whether the opt-in plain-language search runtime is installed. Light on purpose: the report page
 * imports it, so it loads no code from the runtime and no model. See embeddings.ts for the loader.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";

/** Opt-in install prefix for the semantic runtime. */
export function semanticRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "semantic");
}

/** The one command that enables semantic search (printed by the degrade hint and shown on the report). */
export function semanticInstallCommand(env: NodeJS.ProcessEnv = process.env): string {
  return `npm install --prefix "${semanticRuntimeDir(env)}" @shield-agent/fastembed@3.0.0`;
}

/** True when the runtime package files exist under the opt-in prefix. Nothing is loaded. */
export function semanticRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const root = realpathSync(semanticRuntimeDir(env));
    return existsSync(join(root, "node_modules", "@shield-agent", "fastembed", "package.json"));
  } catch {
    return false;
  }
}
