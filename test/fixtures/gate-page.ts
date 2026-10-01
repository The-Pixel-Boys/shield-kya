import type { GatePage } from "../../src/receipt/gate-page.js";

export function minimalGatePage(state: GatePage["state"]): GatePage {
  return {
    state,
    servers: [],
    events: 0,
    binaryPresent: false,
    failureMode: "failOpen",
    otlpPort: 3931,
    bindScope: { loopbackOnly: true, detail: "loopback-only" },
    binaryPath: "/home/test/.kya/bin/kya-gate",
    gateEvents: [],
    listeners: [],
    routes: [],
    policySummary: {
      networkRule: "127.0.0.0/8",
      failureMode: "failOpen",
      totalPolicies: 1,
      verdicts: { allow: 0, deny: 0, hold: 0, never: 0 },
    },
    playgroundSamples: [],
  };
}
