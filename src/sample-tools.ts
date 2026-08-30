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
  /** When true, evaluate DENY MISSING_SANDBOX_ID unless env.sandboxId is set. */
  readonly requiresSandbox?: boolean;
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
  {
    toolId: "org.sample.sandbox.spawn",
    displayName: "Sandbox spawn",
    actionClass: "WRITE",
    policyTier: "REQUIRE_APPROVE",
    irreversible: true,
    dataClass: "INTERNAL",
    metadata: { version: "1.0.0", owner: "sample" },
  },
  {
    toolId: "org.sample.sandbox.exec",
    displayName: "Sandbox exec",
    actionClass: "EXTERNAL_SIDE_EFFECT",
    policyTier: "REQUIRE_APPROVE",
    irreversible: true,
    dataClass: "RESTRICTED",
    requiresSandbox: true,
    metadata: { version: "1.0.0", owner: "sample", requiresSandbox: true },
  },
  {
    toolId: "org.sample.sandbox.net_open",
    displayName: "Sandbox net open",
    actionClass: "EXTERNAL_SIDE_EFFECT",
    policyTier: "REQUIRE_APPROVE",
    irreversible: true,
    dataClass: "INTERNAL",
    requiresSandbox: true,
    metadata: { version: "1.0.0", owner: "sample", requiresSandbox: true },
  },
  {
    toolId: "org.sample.sandbox.kill",
    displayName: "Sandbox kill",
    actionClass: "WRITE",
    policyTier: "ALLOW",
    irreversible: false,
    dataClass: "INTERNAL",
    metadata: { version: "1.0.0", owner: "sample" },
  },
] as const;

export function findSampleTool(toolId: string): SampleToolDescriptor | undefined {
  const id = toolId.trim().toLowerCase();
  if (!id) return undefined;
  return SAMPLE_TOOLS.find((t) => t.toolId.toLowerCase() === id);
}
