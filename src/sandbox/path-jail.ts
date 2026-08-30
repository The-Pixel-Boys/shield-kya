import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";

export function jailRoot(raw: string): string {
  const abs = resolve(raw);
  if (!existsSync(abs) || !lstatSync(abs).isDirectory()) {
    throw new UsageError(`--path must be an existing directory: ${raw}`);
  }
  return realpathSync(abs);
}

export function insideRoot(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertInsideRoot(file: string, root: string, label: string): string {
  const abs = resolve(file);
  if (!insideRoot(abs, root)) {
    throw new UsageError(`${label} must sit inside --path`);
  }
  return abs;
}
