/**
 * Sample custom tools for light install — zero vertical packs (R8).
 * Same descriptors as docs/dev/kya-custom-tools-sample.md.
 */

export type ActionClass = "READ" | "WRITE" | "EXTERNAL_SIDE_EFFECT" | "EXPORT";
export type PolicyVerdict = "ALLOW" | "DENY" | "REQUIRE_APPROVE";
export type DataClass = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export interface SampleToolDescriptor {
  readonly toolId: string;
  readonly displayName: string;
  readonly actionClass: ActionClass;
  readonly policyTier: PolicyVerdict;
  readonly irreversible: boolean;
  readonly dataClass: DataClass;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const SAMPLE_TOOLS: readonly SampleToolDescriptor[] = [
  {
    toolId: "org.sample.safe.read",
    displayName: "Safe read",
    actionClass: "READ",
    policyTier: "ALLOW",
    irreversible: false,
    dataClass: "INTERNAL",
    metadata: { version: "1.0.0", owner: "sample" },
  },
  {
    toolId: "org.sample.data.write",
    displayName: "Data write",
    actionClass: "WRITE",
    policyTier: "REQUIRE_APPROVE",
    irreversible: true,
    dataClass: "CONFIDENTIAL",
    metadata: { version: "1.0.0", owner: "sample" },
  },
  {
    toolId: "org.sample.never.event",
    displayName: "Never event",
    actionClass: "EXTERNAL_SIDE_EFFECT",
    policyTier: "DENY",
    irreversible: true,
    dataClass: "RESTRICTED",
    metadata: { version: "1.0.0", owner: "sample" },
  },
  {
    toolId: "kya.agent.register",
    displayName: "Register agent",
    actionClass: "WRITE",
    policyTier: "REQUIRE_APPROVE",
    irreversible: true,
    dataClass: "CONFIDENTIAL",
    metadata: { version: "1.0.0", owner: "kya" },
  },
] as const;

export function findSampleTool(toolId: string): SampleToolDescriptor | undefined {
  return SAMPLE_TOOLS.find((t) => t.toolId === toolId);
}
