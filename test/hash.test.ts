import { describe, expect, it } from "vitest";
import { computeArgsHash, factoryWorkItemId } from "../src/hash.js";

describe("factoryWorkItemId", () => {
  it("matches Java UUID.nameUUIDFromBytes(kya.factory: + hash)", () => {
    expect(factoryWorkItemId("abc")).toBe("d9ae0e1a-72ee-3eb2-8df2-c512286989dc");
    expect(factoryWorkItemId(computeArgsHash({}))).toBe(
      "418bd044-015c-3bee-a74f-671c881efca3",
    );
  });
});
