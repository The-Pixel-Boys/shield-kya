/**
 * Minimal OTLP wire decode for ExportTraceServiceRequest — protobuf (OTLP/HTTP
 * default) and OTLP/JSON. Only the fields the gate consumes are read (span
 * name, string/int/bool attributes, status); every other field is skipped by
 * wire type. Tool arguments are never extracted — the whitelist lives in
 * otlp-receiver.ts.
 */

export interface DecodedSpan {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** OTLP Status.code: 0 UNSET, 1 OK, 2 ERROR. */
  readonly statusCode: number;
  readonly statusMessage?: string;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

class Reader {
  private pos = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly end: number,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
  }

  bytes(len: number): Uint8Array {
    if (len < 0 || this.pos + len > this.end) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(len: number): string {
    return Buffer.from(this.bytes(len)).toString("utf8");
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.bytes(8);
        return;
      case WIRE_LEN:
        this.bytes(this.varint());
        return;
      case WIRE_FIXED32:
        this.bytes(4);
        return;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

function readAnyValue(buf: Uint8Array): string | number | boolean | undefined {
  const r = new Reader(buf, buf.length);
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === WIRE_LEN) {
      const len = r.varint();
      if (field === 1) return r.string(len); // string_value
      if (field === 7) return hex(r.bytes(len)); // bytes_value
      r.bytes(len); // array_value / kvlist_value: not needed
      continue;
    }
    if (wire === WIRE_FIXED64) {
      r.bytes(8); // double_value: not needed
      continue;
    }
    if (wire !== WIRE_VARINT) {
      r.skip(wire);
      continue;
    }
    const v = r.varint();
    if (field === 2) return v !== 0; // bool_value
    if (field === 3) return v; // int_value
  }
  return undefined;
}

interface MutableSpan {
  traceId?: string;
  spanId?: string;
  name: string;
  attributes: Record<string, string | number | boolean>;
  statusCode: number;
  statusMessage?: string;
}

function readKeyValue(buf: Uint8Array, into: Record<string, string | number | boolean>): void {
  const r = new Reader(buf, buf.length);
  let key: string | undefined;
  let value: string | number | boolean | undefined;
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_LEN) {
      key = r.string(r.varint());
    } else if (field === 2 && wire === WIRE_LEN) {
      value = readAnyValue(r.bytes(r.varint()));
    } else {
      r.skip(wire);
    }
  }
  if (key !== undefined && value !== undefined) into[key] = value;
}

function readStatus(buf: Uint8Array, span: MutableSpan): void {
  const r = new Reader(buf, buf.length);
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 2 && wire === WIRE_LEN) {
      span.statusMessage = r.string(r.varint());
    } else if (field === 3 && wire === WIRE_VARINT) {
      span.statusCode = r.varint();
    } else {
      r.skip(wire);
    }
  }
}

function readSpan(buf: Uint8Array, out: DecodedSpan[]): void {
  const r = new Reader(buf, buf.length);
  const span: MutableSpan = { name: "", attributes: {}, statusCode: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_LEN) {
      span.traceId = hex(r.bytes(r.varint()));
    } else if (field === 2 && wire === WIRE_LEN) {
      span.spanId = hex(r.bytes(r.varint()));
    } else if (field === 5 && wire === WIRE_LEN) {
      span.name = r.string(r.varint());
    } else if (field === 9 && wire === WIRE_LEN) {
      readKeyValue(r.bytes(r.varint()), span.attributes);
    } else if (field === 15 && wire === WIRE_LEN) {
      readStatus(r.bytes(r.varint()), span);
    } else {
      r.skip(wire);
    }
  }
  if (span.name) out.push(span);
}

function readScopeSpans(buf: Uint8Array, out: DecodedSpan[]): void {
  const r = new Reader(buf, buf.length);
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 2 && wire === WIRE_LEN) {
      readSpan(r.bytes(r.varint()), out);
    } else {
      r.skip(wire);
    }
  }
}

function readResourceSpans(buf: Uint8Array, out: DecodedSpan[]): void {
  const r = new Reader(buf, buf.length);
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 2 && wire === WIRE_LEN) {
      readScopeSpans(r.bytes(r.varint()), out);
    } else {
      r.skip(wire);
    }
  }
}

/** Decode an OTLP/protobuf ExportTraceServiceRequest body. */
export function decodeTraceProtobuf(body: Uint8Array): DecodedSpan[] {
  const out: DecodedSpan[] = [];
  const r = new Reader(body, body.length);
  while (!r.done) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_LEN) {
      readResourceSpans(r.bytes(r.varint()), out);
    } else {
      r.skip(wire);
    }
  }
  return out;
}

interface OtlpJsonValue {
  readonly stringValue?: string;
  readonly intValue?: string | number;
  readonly boolValue?: boolean;
  readonly doubleValue?: number;
}

/** Normalize an OTLP/JSON ExportTraceServiceRequest body (best-effort). */
export function decodeTraceJson(raw: unknown): DecodedSpan[] {
  const out: DecodedSpan[] = [];
  if (typeof raw !== "object" || raw === null) return out;
  const resourceSpans = (raw as { resourceSpans?: unknown }).resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown })?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown })?.spans;
      if (!Array.isArray(spans)) continue;
      for (const s of spans) {
        if (typeof s !== "object" || s === null) continue;
        const sp = s as {
          traceId?: unknown;
          spanId?: unknown;
          name?: unknown;
          attributes?: unknown;
          status?: { code?: unknown; message?: unknown };
        };
        if (typeof sp.name !== "string" || !sp.name) continue;
        const attributes: Record<string, string | number | boolean> = {};
        if (Array.isArray(sp.attributes)) {
          for (const a of sp.attributes) {
            const kv = a as { key?: unknown; value?: OtlpJsonValue };
            if (typeof kv?.key !== "string" || !kv.value) continue;
            const v = kv.value;
            if (typeof v.stringValue === "string") attributes[kv.key] = v.stringValue;
            else if (v.intValue !== undefined) attributes[kv.key] = Number(v.intValue);
            else if (typeof v.boolValue === "boolean") attributes[kv.key] = v.boolValue;
          }
        }
        const statusCode =
          typeof sp.status?.code === "number"
            ? sp.status.code
            : typeof sp.status?.code === "string"
              ? ({ STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2 } as Record<string, number>)[
                  sp.status.code
                ] ?? 0
              : 0;
        out.push({
          ...(typeof sp.traceId === "string" ? { traceId: sp.traceId } : {}),
          ...(typeof sp.spanId === "string" ? { spanId: sp.spanId } : {}),
          name: sp.name,
          attributes,
          statusCode,
          ...(typeof sp.status?.message === "string" ? { statusMessage: sp.status.message } : {}),
        });
      }
    }
  }
  return out;
}
