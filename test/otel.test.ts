import { describe, expect, it } from "vitest";
import { otlpEnabled } from "../src/otel.js";

describe("otel", () => {
  it("is off by default", () => {
    expect(otlpEnabled({})).toBe(false);
  });

  it("enables when KYA_OTLP_ENDPOINT is set", () => {
    expect(otlpEnabled({ KYA_OTLP_ENDPOINT: "http://127.0.0.1:4318" })).toBe(true);
  });
});
