/** Plain-text lines for the IoC check, shared by `kya doctor`, the dash pane and the receipt text. */
import type { IocResult } from "./result.js";

export function iocLines(result: IocResult | undefined, enabled: boolean): string[] {
  const background = enabled
    ? "Background scan: on (once a day, started by kya hook; KYA_IOC=0 turns it off)."
    : "Background scan: off (KYA_IOC=0 or ioc.enabled=false in ~/.kya/config.json).";
  if (result === undefined) {
    return [
      "IoC check: no result yet.",
      "Run: kya doctor --iocs",
      background,
    ];
  }
  const n = result.findings.length;
  const lines = [
    n === 0 ? "IoC check: no findings." : `IoC check: ${n} finding${n === 1 ? "" : "s"} (advisory).`,
    `  list ${result.listVersion} · checked ${result.checkedAt} · unreadable files skipped: ${result.skipped}`,
  ];
  for (const f of result.findings) {
    lines.push(`  [${f.severity}] ${f.ioc} (${f.check}): ${f.evidence}`, `    fix: ${f.hint}`);
  }
  lines.push(
    "This check reads local files only. A clean result does not prove the machine is clean.",
    background,
  );
  return lines;
}
