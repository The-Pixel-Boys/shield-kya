/**
 * Render a markdown fix brief per incident, shaped to paste into
 * Claude Code / Cursor / Codex. All text is static per detector id plus
 * evidence from the findings - no LLM calls. Only CLI commands that
 * actually exist (kya certify, kya receipt --open, kya approve/reject,
 * kya eval-tool) are referenced.
 */
import type { DetectorId } from "./detectors.js";
import type { Incident } from "./incidents.js";

const WHY: Record<DetectorId, string> = {
  "pii-in-summary":
    "Trail fields are supposed to be redacted; a real email, card number, or token in the local trail means redaction has a hole and the value may also have reached the agent's context or upstream logs.",
  "deny-spike":
    "Repeated DENY verdicts on one tool mean the agent keeps hitting a policy wall, burning tokens and time instead of changing approach.",
  "approval-loop":
    "An agent retrying a held action stalls the session and can bury a human reviewer in duplicate approval prompts.",
  "never-repeat":
    "A never-list rule exists because the action is unacceptable; repeated attempts suggest the agent is routing around an explicit boundary.",
  "unknown-tool-hold":
    "In hold mode an unknown tool is only recorded; in enforce mode the same call would be blocked, so this is a latent breakage once the gate tightens.",
  "slow-calls":
    "Gate evaluation latency is on the critical path of every tool call; a high p95 slows the whole agent loop even though latency never changes verdicts.",
};

const SUGGESTED_CHANGE: Record<DetectorId, string> = {
  "pii-in-summary": [
    "1. Rotate the leaked value immediately (password, token, or card) and treat it as compromised.",
    "2. Tighten the redaction step that produces `summary` / `diffPreview` / `targetPath` so the leaked pattern is masked before it reaches the trail.",
    "3. Add a regression fixture with the masked shape so the pattern cannot come back.",
  ].join("\n"),
  "deny-spike": [
    "1. If the tool should never run, add it to the never-list so attempts fail fast instead of spiking DENYs.",
    "2. If the tool is legitimate, narrow its args in the gate policy so the intended calls pass and the rest still deny.",
    "3. Re-check the live verdict for one call with `kya eval-tool`.",
  ].join("\n"),
  "approval-loop": [
    "1. Resolve the pending decision once with `kya approve` or `kya reject` instead of letting the agent retry.",
    "2. If the action is routine, add a scoped allow rule so it stops prompting; if it is unwanted, deny it permanently.",
    "3. Tell the agent not to retry a held call unchanged; it should wait or change approach.",
  ].join("\n"),
  "never-repeat": [
    "1. Keep the never rule; it held. Remove the tool from the agent's available toolset or prompt so it stops being proposed.",
    "2. If a variant of the action is legitimately needed, define a narrower tool and allow that instead of loosening the never rule.",
  ].join("\n"),
  "unknown-tool-hold": [
    "1. Register the tool in the gate policy or tool pack so it gets a real verdict instead of UNKNOWN_TOOL.",
    "2. If the tool should not exist, remove it from the agent's toolset before the gate moves to enforce mode.",
    "3. Confirm the resolved verdict with `kya eval-tool`.",
  ].join("\n"),
  "slow-calls": [
    "1. Profile the evaluate path for the slow tool (local model load, network, or oversized args).",
    "2. Cache stable verdicts or trim args sent to the evaluator; latency is observe-only but it taxes every call.",
    "3. Re-measure after the change and confirm p95 drops below 5000ms.",
  ].join("\n"),
};

const VERIFY_COMMANDS: Record<DetectorId, readonly string[]> = {
  "pii-in-summary": ["kya receipt --open", "kya certify"],
  "deny-spike": ["kya eval-tool", "kya certify"],
  "approval-loop": ["kya approvals", "kya receipt --open"],
  "never-repeat": ["kya receipt --open", "kya certify"],
  "unknown-tool-hold": ["kya eval-tool", "kya receipt --open"],
  "slow-calls": ["kya dash", "kya receipt --open"],
};

function evidenceLines(incident: Incident): string[] {
  const lines: string[] = [];
  for (const f of incident.findings) {
    lines.push(`- [${f.severity}] ${f.summary}`);
    const samples = f.evidence.samples;
    if (Array.isArray(samples) && samples.length > 0) {
      lines.push(`  - masked samples: ${samples.map(String).join(", ")}`);
    }
  }
  return lines;
}

export function renderFixBrief(incident: Incident): string {
  const detectorId = incident.findings[0]?.detectorId;
  if (!detectorId) return `# ${incident.title}\n`;
  const window =
    incident.firstTs && incident.lastTs
      ? `${incident.firstTs} to ${incident.lastTs}`
      : "time unknown";
  return [
    `# Fix brief: ${incident.title}`,
    "",
    `- Incident id: ${incident.id}`,
    `- Severity: ${incident.severity}`,
    `- Findings: ${incident.findingCount}`,
    `- Window: ${window}`,
    "",
    "## What happened",
    ...evidenceLines(incident),
    "",
    "## Why it matters",
    WHY[detectorId],
    "",
    "## Suggested change",
    SUGGESTED_CHANGE[detectorId],
    "",
    "## Verify",
    ...VERIFY_COMMANDS[detectorId].map((c) => `- \`${c}\``),
    "",
  ].join("\n");
}
