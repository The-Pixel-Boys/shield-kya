/**
 * TUI plan: FREE (individual / PLG) vs ENTERPRISE (licensed).
 * Fail-closed: missing or invalid license never elevates; parse errors stay FREE.
 */

import { existsSync, readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";

export type DashPlan = "free" | "enterprise";

export const ENTERPRISE_PANES = ["dashboard", "cases", "metrics", "edge", "settings"] as const;
export const FREE_PANES = [
  "home",
  "policy",
  "agents",
  "approvals",
  "sessions",
  "orr",
  "mcp",
] as const;

export type FreePane = (typeof FREE_PANES)[number];
export type EnterprisePane = (typeof ENTERPRISE_PANES)[number];
export type DashPane = FreePane | EnterprisePane;

export interface Entitlement {
  readonly plan: DashPlan;
  readonly source: "env" | "license" | "plane" | "default";
  readonly locked: readonly EnterprisePane[];
}

export interface PlaneEntitlement {
  readonly plan?: unknown;
  readonly dash?: unknown;
  readonly features?: unknown;
}

export interface ResolveEntitlementInput {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly plane?: PlaneEntitlement;
  readonly now?: Date;
  readonly licensePublicKeyPem?: string;
}

/** Placeholder verify key — real issuers replace via KYA_LICENSE_PUBKEY. */
export const DEFAULT_LICENSE_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA//////////////////////////////////////////8=
-----END PUBLIC KEY-----
`;

const FREE: Entitlement = { plan: "free", source: "default", locked: [...ENTERPRISE_PANES] };

export function isEnterprisePane(pane: string): pane is EnterprisePane {
  return (ENTERPRISE_PANES as readonly string[]).includes(pane);
}

export function paneAllowed(ent: Entitlement, pane: DashPane): boolean {
  if (!isEnterprisePane(pane)) return true;
  return ent.plan === "enterprise";
}

export function resolveEntitlement(input: ResolveEntitlementInput): Entitlement {
  try {
    const envPlan = String(input.env.KYA_DASH_PLAN ?? "")
      .trim()
      .toLowerCase();
    if (envPlan === "enterprise") {
      return { plan: "enterprise", source: "env", locked: [] };
    }
    if (envPlan === "free") {
      return { plan: "free", source: "env", locked: [...ENTERPRISE_PANES] };
    }

    const licensePath =
      String(input.env.KYA_LICENSE ?? "").trim() || join(input.cwd, ".kya", "license");
    if (existsSync(licensePath)) {
      let raw = "";
      try {
        raw = readFileSync(licensePath, "utf8");
      } catch {
        return FREE;
      }
      const pubkey = input.licensePublicKeyPem ?? input.env.KYA_LICENSE_PUBKEY;
      if (licenseGrantsEnterprise(raw, input.now ?? new Date(), pubkey)) {
        return { plan: "enterprise", source: "license", locked: [] };
      }
    }

    if (planeGrantsEnterprise(input.plane)) {
      return { plan: "enterprise", source: "plane", locked: [] };
    }
  } catch {
    return FREE;
  }
  return FREE;
}

export function planeGrantsEnterprise(plane?: PlaneEntitlement): boolean {
  if (!plane || typeof plane !== "object") return false;
  if (plane.dash === "enterprise") return true;
  if (typeof plane.plan === "string" && plane.plan.toUpperCase() === "SCALE") return true;
  return Array.isArray(plane.features) && plane.features.includes("enterprise_tui");
}

export function licenseGrantsEnterprise(
  raw: string,
  now: Date,
  publicKeyPem?: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const rec = parsed as Record<string, unknown>;
  const plan = typeof rec.plan === "string" ? rec.plan.toLowerCase() : "";
  const features = Array.isArray(rec.features) ? rec.features : [];
  const entitled = plan === "enterprise" || features.includes("enterprise_tui");
  if (!entitled) return false;
  if (typeof rec.exp === "string") {
    const exp = Date.parse(rec.exp);
    if (!Number.isFinite(exp) || exp <= now.getTime()) return false;
  }
  const sig = rec.sig;
  if (typeof sig !== "string" || sig.length === 0) return false;
  const { sig: _omit, ...body } = rec;
  void _omit;
  const payload = Buffer.from(canonicalJson(body), "utf8");
  const pem = publicKeyPem ?? DEFAULT_LICENSE_PUBKEY_PEM;
  try {
    const key = createPublicKey(pem);
    return verify(null, payload, key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
