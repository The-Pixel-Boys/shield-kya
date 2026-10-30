// OTLP metrics start errors: fail open, one line on stderr, nothing on stdout.
import { describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {
    constructor() {
      throw new Error("exporter boom");
    }
  },
}));

import { ensureOtlpMetrics, recordClientEvaluate } from "../src/otel.js";

describe("OTLP metrics start error", () => {
  it("resolves, logs one stderr line, writes nothing to stdout, and records nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const env = { KYA_OTLP_ENDPOINT: "http://127.0.0.1:4318" };
      await expect(ensureOtlpMetrics(env)).resolves.toBeUndefined();
      await ensureOtlpMetrics(env);
      recordClientEvaluate({ verdict: "ALLOW", host: "claude", latencyMs: 1 });
      const lines = err.mock.calls.filter((c) => String(c[0]).includes("OTLP metrics unavailable"));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]![0])).toContain("exporter boom");
      expect(out).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
      stdout.mockRestore();
    }
  });
});
