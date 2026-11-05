/**
 * A SYNTHETIC busy trail for the map layout tests. Every value is invented. It has the shape of a real busy week:
 * 2 devices, 23 sessions, several sessions in projects with the same name ("gtm"), long project names, one hot
 * navigation class (command:cd) plus command:ls and command:pwd, a few deny and hold rows, tools in several classes,
 * and more than 20 target classes. A seeded generator builds it, so the same `now` gives the same rows.
 */
import type { TrailEventLike } from "../../src/map/types.js";

/** mulberry32: small seeded random generator. Same seed, same sequence. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LONG_A = "2026-11-03-signal-run-weekly-outreach-pipeline";
const LONG_B = "gtm-decision-pack-for-the-quarterly-review-2026";
/** Project per session. Six sessions share "gtm"; two names are longer than 40 characters. */
const PROJECTS = ["gtm", "gtm", "gtm", "gtm", "gtm", "gtm", "dev", "dev", "tmp", "bin", LONG_A, LONG_A, LONG_B,
  "demo-app.git", "api-server", "docs-site", "infra", "billing-service", "web-console", "data-jobs", "mobile-app",
  "search-indexer", "release-notes"];

/** Tool and the target classes it touches. */
const TOOLS: Array<{ toolId: string; targets: string[] }> = [
  { toolId: "Bash", targets: ["command:git", "command:npm", "command:node", "command:make", "command:docker", "command:curl", "command:grep", "command:cat"] },
  { toolId: "Read", targets: ["project:app/src/**", "project:docs/**", "project:test/**", "home:other"] },
  { toolId: "Edit", targets: ["project:app/src/**", "project:web/**"] },
  { toolId: "Write", targets: ["project:app/src/**", "tmp:other"] },
  { toolId: "Grep", targets: ["project:app/src/**", "project:lib/**"] },
  { toolId: "Glob", targets: ["project:config/**"] },
  { toolId: "WebFetch", targets: ["network:api1.example", "network:api2.example", "network:docs.example", "network:cdn.example"] },
  { toolId: "WebSearch", targets: ["network:search.example"] },
  { toolId: "mcp__gh__create_issue", targets: ["network:github.example"] },
  { toolId: "mcp__db__query", targets: ["system:other", "network:db.example"] },
  { toolId: "TodoWrite", targets: ["none"] },
  { toolId: "kya:policy_evaluate", targets: ["none"] },
];

const DEVICE_B = "da5e8c06f0b49b5b";

/**
 * Builds the busy trail. `now` sets the newest row to one hour before it, so the default 3-day window holds all rows.
 * About 4900 rows; command:cd holds 2492 of them.
 */
export function busyTrail(now: Date, seed = 20261105): TrailEventLike[] {
  const rnd = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const start = now.getTime() - 3_600_000 - 60 * 3_600_000;
  const rows: TrailEventLike[] = [];
  const session = (i: number) => `5e1c0a00-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const base = (i: number): Omit<TrailEventLike, "ts" | "toolId" | "verdict" | "reasonCode" | "mode"> => ({
    sessionId: session(i),
    host: "ide",
    product: i % 5 === 0 ? "cursor" : "claude",
    project: PROJECTS[i]!,
    ...(i % 2 === 0 ? { deviceId: DEVICE_B } : {}),
  });
  const push = (i: number, toolId: string, targetClass: string, verdict = "ALLOW", mode = "offline") => {
    rows.push({ ts: "", ...base(i), toolId, targetClass, verdict, reasonCode: verdict === "DENY" ? "NEVER_EVENT" : verdict, mode });
  };
  // Each session uses three tools and one target class per tool, as real sessions do. This keeps the edge count
  // under the builder cap, so the hot classes stay as their own nodes.
  const work = PROJECTS.map(() => [0, 1, 2].map(() => {
    const t = pick(TOOLS);
    return { toolId: t.toolId, target: pick(t.targets) };
  }));
  const anySession = () => Math.floor(rnd() * PROJECTS.length);
  // The hot navigation classes: command:cd in every session, command:ls and command:pwd in a few.
  for (let k = 0; k < 2492; k += 1) push(k < PROJECTS.length ? k : anySession(), "Bash", "command:cd");
  for (let k = 0; k < 50; k += 1) push(k % 8, "Bash", "command:ls");
  for (let k = 0; k < 31; k += 1) push(k % 5, "Bash", "command:pwd");
  // Normal work.
  for (let k = 0; k < 2300; k += 1) {
    const i = anySession();
    const w = pick(work[i]!);
    const observe = rnd() < 0.08;
    push(i, w.toolId, w.target, observe ? "REQUIRE_APPROVE" : "ALLOW", observe ? "observe" : "offline");
  }
  // A few denies and holds.
  push(0, "Read", "secret:ssh-key", "DENY");
  push(3, "Bash", "secret:cloud-credential", "DENY");
  push(11, "Bash", "command:rm", "DENY");
  push(2, "mcp__gh__create_issue", "network:github.example", "REQUIRE_APPROVE", "hold");
  push(12, "WebFetch", "network:upload.example", "REQUIRE_APPROVE", "hold");
  push(7, "Write", "system:other", "REQUIRE_APPROVE", "hold");
  // Timestamps: in order, the newest one hour before now.
  const step = (60 * 3_600_000) / rows.length;
  rows.forEach((r, i) => {
    r.ts = new Date(start + Math.round(i * step + rnd() * step * 0.5)).toISOString();
  });
  return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
