/**
 * Reason codes of a never-list deny: NEVER_EVENT (tool name and the input rules) and the guard pack
 * codes (NEVER_SHELL, NEVER_SECRET_READ, NEVER_SECRET_WRITE, NEVER_EXFIL). One test for all of them,
 * so a new code is counted as a block everywhere that sets `neverEvent`.
 */
export function isNeverCode(code: string | undefined): boolean {
  return typeof code === "string" && code.startsWith("NEVER_");
}
