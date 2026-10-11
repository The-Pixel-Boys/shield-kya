import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mcpServerKeys } from "../src/mcp-servers.js";
import { NEVER_LIST_VERBS, matchesNeverList } from "../src/offline-evaluate.js";
import { SAMPLE_TOOLS } from "../src/sample-tools.js";

// The Python shim (kya-python) ports matchesNeverList and asserts this same file,
// so a never-list change that skips the fixture fails here first.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/never-list-vectors.json", import.meta.url), "utf8"),
) as {
  denySampleIds: string[];
  neverListVerbs: string[];
  mcpServerKeys: string[];
  vectors: { toolId: string; never: boolean }[];
};

describe("never-list shared vectors", () => {
  it("lists exactly the DENY sample tools", () => {
    expect(fixture.denySampleIds).toEqual(
      SAMPLE_TOOLS.filter((t) => t.policyTier === "DENY").map((t) => t.toolId),
    );
  });

  it("carries the destructive verbs as data", () => {
    expect(fixture.neverListVerbs).toEqual([...NEVER_LIST_VERBS]);
  });

  it("lists exactly the known MCP server ids and aliases", () => {
    expect(fixture.mcpServerKeys).toEqual(mcpServerKeys());
  });

  it.each(fixture.vectors)("matchesNeverList($toolId) === $never", ({ toolId, never }) => {
    expect(matchesNeverList(toolId)).toBe(never);
  });
});
