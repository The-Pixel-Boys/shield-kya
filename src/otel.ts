/**
 * Opt-in OTLP metrics for the OSS CLI (thin edge).
 * Default off. Never exports tool args, prompts, or API keys.
 * Hosted plane remains the rich telemetry source.
 *
 * The OpenTelemetry SDK is imported only when an OTLP endpoint is configured,
 * so default hook and CLI runs never load it (about 40 MB of modules).
 */

import type * as OtelApi from "@opentelemetry/api";
import { CLI_VERSION } from "./version.js";

let started: Promise<void> | undefined;
let otelMetrics: typeof OtelApi.metrics | undefined;

export function otlpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const endpoint = env.KYA_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return Boolean(endpoint);
}

/**
 * Start a process-wide MeterProvider once when an OTLP endpoint is configured.
 * Never throws: a start error is logged once to stderr (never stdout) and metrics stay off.
 */
export function ensureOtlpMetrics(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!started && otlpEnabled(env)) {
    started = startOtlp(env).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`KYA OTLP metrics unavailable: ${message}`);
    });
  }
  return started ?? Promise.resolve();
}

async function startOtlp(env: NodeJS.ProcessEnv): Promise<void> {
  const endpoint =
    env.KYA_OTLP_METRICS_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() ||
    env.KYA_OTLP_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

  const [api, resources, sdk, otlp] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
  ]);

  const url = endpoint.includes("/v1/metrics")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/v1/metrics`;

  const headers: Record<string, string> = {};
  const raw = env.OTEL_EXPORTER_OTLP_HEADERS ?? env.KYA_OTLP_HEADERS ?? "";
  for (const part of raw.split(",")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  const exporter = new otlp.OTLPMetricExporter({ url, headers });
  const provider = new sdk.MeterProvider({
    resource: resources.resourceFromAttributes({
      "service.name": "shield-kya-cli",
      "service.version": CLI_VERSION,
    }),
    readers: [
      new sdk.PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 15_000,
      }),
    ],
  });
  api.metrics.setGlobalMeterProvider(provider);
  otelMetrics = api.metrics;
}

/** Record evaluate latency with low-cardinality tags only (verdict, host). */
export function recordClientEvaluate(input: {
  readonly verdict: string;
  readonly host: string;
  readonly latencyMs: number;
}): void {
  if (!otelMetrics) return;
  const meter = otelMetrics.getMeter("shield-kya-cli", CLI_VERSION);
  const hist = meter.createHistogram("kya.client.evaluate.latency", {
    description: "OSS CLI policy evaluate latency",
    unit: "ms",
  });
  hist.record(Math.max(0, input.latencyMs), {
    verdict: input.verdict || "UNKNOWN",
    host: input.host || "unknown",
  });
}
