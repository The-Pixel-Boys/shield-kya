/**
 * Opt-in OTLP metrics for the OSS CLI (thin edge).
 * Default off. Never exports tool args, prompts, or API keys.
 * Hosted plane remains the rich telemetry source.
 */

import { metrics } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { CLI_VERSION } from "./version.js";

let started = false;

export function otlpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const endpoint = env.KYA_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return Boolean(endpoint);
}

/** Start a process-wide MeterProvider once when an OTLP endpoint is configured. */
export function ensureOtlpMetrics(env: NodeJS.ProcessEnv = process.env): void {
  if (started || !otlpEnabled(env)) return;
  const endpoint =
    env.KYA_OTLP_METRICS_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() ||
    env.KYA_OTLP_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

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

  const exporter = new OTLPMetricExporter({ url, headers });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      "service.name": "shield-kya-cli",
      "service.version": CLI_VERSION,
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 15_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  started = true;
}

/** Record evaluate latency with low-cardinality tags only (verdict, host). */
export function recordClientEvaluate(input: {
  readonly verdict: string;
  readonly host: string;
  readonly latencyMs: number;
}): void {
  if (!started) return;
  const meter = metrics.getMeter("shield-kya-cli", CLI_VERSION);
  const hist = meter.createHistogram("kya.client.evaluate.latency", {
    description: "OSS CLI policy evaluate latency",
    unit: "ms",
  });
  hist.record(Math.max(0, input.latencyMs), {
    verdict: input.verdict || "UNKNOWN",
    host: input.host || "unknown",
  });
}
