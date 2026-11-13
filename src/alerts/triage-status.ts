/**
 * Whether the opt-in local triage model is installed. Light on purpose: the alert scan and `kya start`
 * import it, so it loads no code from the runtime and no model. See triage-model.ts for the loader.
 * Runtime: onnxruntime-node under <kya home>/.kya/triage (same pattern as the plain-language search runtime).
 * Model: one file, downloaded once from models.shield-agent.com (R2), sha256 pinned below.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";

/** Pinned exact version, published 2026-09-14. No network at hook time: it is installed once, by the offer. */
export const TRIAGE_RUNTIME_PACKAGE = "onnxruntime-node@1.30.0";
export const TRIAGE_RUNTIME_NAME = "onnxruntime-node";
export const TRIAGE_MODEL_ID = "kya-triage-v1";
/** The only host the model is downloaded from: a public Cloudflare R2 bucket (`kya-models`) behind a custom domain. */
export const TRIAGE_MODEL_HOST = "models.shield-agent.com";
/** Immutable object path (a new model is a new path). Upload steps: docs/operations/kya-triage-model-release.md. */
export const TRIAGE_MODEL_URL = `https://${TRIAGE_MODEL_HOST}/triage-model-v1/kya-triage-v1.bin`;
/** A model file larger than this is refused (the real file is about 145 MiB). */
export const TRIAGE_MODEL_MAX_BYTES = 200 * 1024 * 1024;
/** sha256 of the packed model file (of the uploaded object). A download with another hash is refused. */
export const TRIAGE_MODEL_SHA256 = "9df79939edaef4bdadbb9972bf357a9f7c396b6a837489f438974a54e00be786";
export const TRIAGE_MODEL_MB = 150;

export function triageRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "triage");
}

/** Where the offer writes the model. */
export function triageModelInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(triageRuntimeDir(env), "model", `${TRIAGE_MODEL_ID}.bin`);
}

/** The model file to load. `KYA_TRIAGE_MODEL_PATH` points at a locally built file (tests, development). */
export function triageModelFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KYA_TRIAGE_MODEL_PATH?.trim();
  return override ? override : triageModelInstallPath(env);
}

/** The one command that installs the runtime and the model (printed when an install fails). */
export function triageInstallCommand(): string {
  return "KYA_ALERTS=on kya start";
}

/** True when the runtime package files exist under the opt-in prefix. Nothing is loaded. */
export function triageRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const root = realpathSync(triageRuntimeDir(env));
    return existsSync(join(root, "node_modules", TRIAGE_RUNTIME_NAME, "package.json"));
  } catch {
    return false;
  }
}

export function triageModelPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return statSync(triageModelFile(env)).size > 0;
  } catch {
    return false;
  }
}

/** Runtime and model are both there: the alert scan then adds triage to each new incident alert. */
export function triageInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triageRuntimeInstalled(env) && triageModelPresent(env);
}
