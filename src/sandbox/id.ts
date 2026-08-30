import { UsageError } from "../errors.js";

/** Spawned ids are `sbx-` + uuid. Kill/exec flags must match; never a pkill regex. */
export const SANDBOX_ID_RE = /^sbx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSandboxId(raw: string | undefined): string {
  const id = raw?.trim() ?? "";
  if (!SANDBOX_ID_RE.test(id)) {
    throw new UsageError(
      "sandbox-id must be sbx-<uuid> (from `kya sandbox spawn`); refusing regex/path values",
    );
  }
  return id;
}
