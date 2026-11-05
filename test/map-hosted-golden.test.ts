import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bucketOf, buildMap, toolClassOf } from "../src/map/build.js";
import { buildHeat } from "../src/map/heat.js";
import { classifyTarget } from "../src/map/target-class.js";
import type { TrailEventLike } from "../src/map/types.js";
import { isSecretPath } from "../src/never-list-input.js";

// One golden file, two runners: this test and core MapGoldenParityTest (the Java port for the hosted map).
// Hosted rows have no cwd and no home, so every case runs without them.
const FILE = join(import.meta.dirname, "fixtures/map/hosted-golden.json");

interface Case<I> {
  input: I;
  expected?: unknown;
}
interface Golden {
  classify: Case<{ toolId: string; targetPath?: string; summary?: string; project?: string }>[];
  secret: Case<string>[];
  toolClass: Case<{ toolId: string; summary?: string; targetPath?: string }>[];
  bucket: Case<{ verdict: string; mode: string }>[];
  graph: { salt: string; maxNodes: number; rows: TrailEventLike[]; expected?: unknown };
  heat: { now: string; days: number; expected?: unknown };
}

function compute(g: Golden): Golden {
  return {
    ...g,
    classify: g.classify.map((c) => ({ input: c.input, expected: classifyTarget(c.input) })),
    secret: g.secret.map((c) => ({ input: c.input, expected: isSecretPath(c.input, undefined) })),
    toolClass: g.toolClass.map((c) => ({ input: c.input, expected: toolClassOf({ ts: "", sessionId: "", reasonCode: "", verdict: "", mode: "observe", ...c.input }) })),
    bucket: g.bucket.map((c) => ({ input: c.input, expected: bucketOf({ ts: "", sessionId: "", reasonCode: "", toolId: "", ...c.input }) })),
    graph: { ...g.graph, expected: buildMap(g.graph.rows, { salt: g.graph.salt, maxNodes: g.graph.maxNodes }) },
    heat: { ...g.heat, expected: buildHeat(g.graph.rows, { now: new Date(g.heat.now), days: g.heat.days }) },
  };
}

describe("hosted map golden file", () => {
  it("TS map code gives the golden output (the Java port reads the same file)", () => {
    const golden = JSON.parse(readFileSync(FILE, "utf8")) as Golden;
    const actual = compute(golden);
    if (process.env.UPDATE_MAP_GOLDEN === "1") writeFileSync(FILE, JSON.stringify(actual, null, 1) + "\n");
    expect(actual).toEqual(golden);
  });

  // WHATWG IDNA handling of right-to-left digit hosts differs between Node 22 and 24 (http://\u0661\u0662\u0663/ gives
  // xn--9hbcd on 22 and other on 24), so such hosts are not in the shared golden file. Both versions share this
  // weaker property: the class is ASCII only (a punycode host or other), never the raw non-ASCII host.
  it("non-ASCII and digit-script hosts give an ASCII class on every Node version", () => {
    for (const t of ["http://\u0661\u0662\u0663/", "https://m\u00fcnchen.de/", "https://h.example:\u0663/x", "http://0x\u0663f.1/",
      "http://\u0645\u062b\u0627\u0644.\u0625\u062e\u062a\u0628\u0627\u0631/", "http://\uff11\uff12\uff13/"]) {
      const out = classifyTarget({ toolId: "Fetch", targetPath: t });
      expect(out.class, t).toMatch(/^network:(other|[a-z0-9.-]+|\[[0-9a-f:.]+\])$/);
    }
  });

  it("the golden file holds no home folder of a real user and no raw path in an expected class", () => {
    const golden = JSON.parse(readFileSync(FILE, "utf8")) as Golden;
    for (const c of golden.classify) {
      const out = c.expected as { class: string };
      expect(out.class).not.toMatch(/\/(Users|home)\//);
      if (c.input.targetPath && c.input.targetPath.length > 8 && c.input.targetPath.includes("/", 1)) {
        expect(out.class).not.toContain(c.input.targetPath);
      }
    }
  });
});
