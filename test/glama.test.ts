/**
 * glama.json claims the MCP server listing on Glama for its maintainer. It lives at the
 * sdks/kya root so the public mirror (shield-kya) gets it at its root on every sync.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GLAMA = join(dirname(fileURLToPath(import.meta.url)), "..", "glama.json");

describe("glama.json", () => {
  it("exists at the package root", () => {
    expect(existsSync(GLAMA)).toBe(true);
  });

  it("parses as JSON with the Glama schema and lists the maintainer", () => {
    const glama = JSON.parse(readFileSync(GLAMA, "utf8"));
    expect(glama.$schema).toBe("https://glama.ai/mcp/schemas/server.json");
    expect(glama.maintainers).toEqual(["cc-bb-aa"]);
  });
});
