// Guard: no static (top-level, non type-only) import or re-export of the embedding runtime,
// OpenTelemetry SDK or exporter packages anywhere in src, and no static ./commands/* import in cli.ts.
// Parsed with the TypeScript AST, so multi-line import clauses are seen. Type-only forms are erased and allowed.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const HEAVY = /^(fastembed|@shield-agent\/fastembed|onnxruntime-node|@shield-agent\/onnxruntime-node|@opentelemetry\/(sdk-metrics|exporter-metrics-otlp-http|resources))(\/.*)?$/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Findings for one file: static (non type-only) declarations whose specifier matches `pick`. */
function staticFindings(file: string, pick: (spec: string) => boolean): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const spec = stmt.moduleSpecifier.text;
      if (pick(spec)) {
        const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
        hits.push(`${relative(SRC, file)}:${line + 1}: import "${spec}"`);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      const spec = stmt.moduleSpecifier.text;
      if (pick(spec)) {
        const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
        hits.push(`${relative(SRC, file)}:${line + 1}: export from "${spec}"`);
      }
    }
  }
  return hits;
}

/** Heavy runtime packages must not be static anywhere in src. */
function heavyStaticImports(root: string): string[] {
  return tsFiles(root).flatMap((f) => staticFindings(f, (spec) => HEAVY.test(spec)));
}

/** cli.ts loads command modules on demand so `kya hook` does not pay for the whole CLI. */
function staticCommandImports(cliFile: string): string[] {
  return staticFindings(cliFile, (spec) => spec.startsWith("./commands/"));
}

describe("lean install guard", () => {
  it("has no top-level static import or re-export of fastembed, onnxruntime or OpenTelemetry SDK packages in src", () => {
    expect(heavyStaticImports(SRC)).toEqual([]);
  });

  it("cli.ts has no static import of ./commands/*", () => {
    expect(staticCommandImports(join(SRC, "cli.ts"))).toEqual([]);
  });

  it("catches a multi-line static import (the form otel.ts used before)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kya-guard-"));
    const file = join(dir, "fixture.ts");
    writeFileSync(
      file,
      `import {\n  MeterProvider,\n} from "@opentelemetry/sdk-metrics";\nexport {\n  x,\n} from "fastembed";\nimport type { Y } from "onnxruntime-node";\n`,
    );
    const hits = staticFindings(file, (spec) => HEAVY.test(spec));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('import "@opentelemetry/sdk-metrics"');
    expect(hits[1]).toContain('export from "fastembed"');
  });
});
