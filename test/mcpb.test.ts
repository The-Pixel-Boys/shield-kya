/**
 * Claude Desktop extension bundle (scripts/packaging/mcpb.mjs): zip writer and reader, the manifest
 * gate (the version must equal the tag), determinism, and an end-to-end run of the unpacked bundle
 * (the built dist/cli.js through claude/run-stdio.mjs, an MCP initialize + tools/list over stdio).
 * The e2e needs `pnpm build` first, like the other CLI tests in CI.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// KYA_MCPB_MODULE: only the mutant run at the end, which points every case at a weakened copy of the module.
const MODULE = process.env.KYA_MCPB_MODULE ?? join(dirname(fileURLToPath(import.meta.url)), "../scripts/packaging/mcpb.mjs");
const { MAX_FILE, badEntryName, buildFromTarball, buildMcpb, bundleVersion, diffBundles, entrySet, inspectZip, manifestProblems, readZipEntry, unpackTarball, unzipAll, zip, zipNames } = await import(pathToFileURL(MODULE).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = MODULE;
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-mcpb-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal package dir the manifest gate accepts. */
function tinyPackage(version = "1.2.3"): string {
  const p = join(dir, "pkg");
  mkdirSync(join(p, "claude"), { recursive: true });
  mkdirSync(join(p, "dist"), { recursive: true });
  mkdirSync(join(p, "assets"), { recursive: true });
  writeFileSync(
    join(p, "manifest.json"),
    JSON.stringify({
      manifest_version: "0.3", name: "x", description: "d", version, icon: "assets/logo.svg",
      server: { type: "node", entry_point: "claude/run-stdio.mjs", mcp_config: { command: "node", args: ["${__dirname}/dist/cli.js"] } },
    }),
  );
  writeFileSync(join(p, "claude/run-stdio.mjs"), "// stub\n");
  writeFileSync(join(p, "dist/cli.js"), "x".repeat(5000));
  writeFileSync(join(p, "assets/logo.svg"), "<svg/>");
  return p;
}

describe("zip writer and reader", () => {
  it("round-trips entries (deflate and stored), checks the CRC, lists names", () => {
    const buf = zip([
      { name: "a.txt", data: Buffer.from("hello ".repeat(100)) },
      { name: "d/b.bin", data: Buffer.from([1, 2, 3]) },
      { name: "empty", data: Buffer.alloc(0) },
    ]);
    expect(zipNames(buf)).toEqual(["a.txt", "d/b.bin", "empty"]);
    expect(readZipEntry(buf, "a.txt").toString()).toBe("hello ".repeat(100));
    expect([...readZipEntry(buf, "d/b.bin")]).toEqual([1, 2, 3]);
    expect(readZipEntry(buf, "empty").length).toBe(0);
    expect(readZipEntry(buf, "missing")).toBeNull();
    const bad = Buffer.from(buf);
    bad[bad.indexOf("d/b.bin") + 7] ^= 0xff; // flip a data byte of the stored entry
    expect(() => readZipEntry(bad, "d/b.bin")).toThrow(/CRC/);
  });

  it("the reader refuses non-zip bytes and an entry above the size limit", () => {
    expect(() => zipNames(Buffer.from("not a zip at all, just text"))).toThrow(/not a zip/);
    const buf = zip([{ name: "big", data: Buffer.alloc(5000, 1) }]);
    expect(() => readZipEntry(buf, "big", 100)).toThrow(/above the 100 limit/);
  });

  it("is readable by the system unzip tool", () => {
    const f = join(dir, "t.zip");
    writeFileSync(f, zip([{ name: "a/b.txt", data: Buffer.from("x".repeat(3000)) }]));
    const r = spawnSync("unzip", ["-t", f], { encoding: "utf8" });
    if (r.error) return; // no unzip on this host: the reader tests above still cover the format
    expect(r.status).toBe(0);
  });
});

describe("buildMcpb", () => {
  it("packs every file with manifest.json at the root, deterministically, sorted", () => {
    const p = tinyPackage();
    const a = buildMcpb(p, "1.2.3");
    const b = buildMcpb(p, "1.2.3");
    expect(a.equals(b)).toBe(true);
    expect(zipNames(a)).toEqual(["assets/logo.svg", "claude/run-stdio.mjs", "dist/cli.js", "manifest.json"]);
    expect(bundleVersion(a)).toBe("1.2.3");
  });

  it("refuses a manifest whose version is not the release version", () => {
    expect(() => buildMcpb(tinyPackage("1.2.2"), "1.2.3")).toThrow(/manifest.json version is 1\.2\.2, want 1\.2\.3/);
  });

  it("refuses a manifest that points at a missing file, a bad version argument, a symlink", () => {
    const p = tinyPackage();
    rmSync(join(p, "claude/run-stdio.mjs"));
    expect(manifestProblems(p, "1.2.3").join(" ")).toMatch(/entry_point/);
    rmSync(join(p, "dist/cli.js"));
    expect(manifestProblems(p, "1.2.3").join(" ")).toMatch(/mcp_config arg/);
    expect(manifestProblems(p, "v1.2.3")).toEqual(["invalid version v1.2.3"]);
    const q = tinyPackage();
    symlinkSync("/etc/passwd", join(q, "assets/link"));
    expect(() => buildMcpb(q, "1.2.3")).toThrow(/symlink/);
  });

  it("the CLI builds and verifies; verify fails on another version", () => {
    const p = tinyPackage();
    const out = join(dir, "x.mcpb");
    expect(spawnSync(process.execPath, [SCRIPT, "build", p, out, "1.2.3"]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT, "verify", out, "1.2.3"]).status).toBe(0);
    const bad = spawnSync(process.execPath, [SCRIPT, "verify", out, "1.2.4"], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/manifest version is 1\.2\.3, want 1\.2\.4/);
  });
});

describe("the real package", () => {
  it("builds from the files npm ships, with the manifest version equal to package.json", () => {
    expect(PKG.files).toContain("manifest.json");
    const staged = join(dir, "pkg");
    mkdirSync(staged);
    for (const f of [...PKG.files, "package.json"]) {
      if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(staged, f), { recursive: true });
    }
    const buf = buildMcpb(staged, PKG.version);
    expect(bundleVersion(buf)).toBe(PKG.version);
    const names: string[] = zipNames(buf);
    for (const n of ["manifest.json", "claude/run-stdio.mjs", "dist/cli.js", "assets/logo.svg"]) expect(names).toContain(n);
  }, 30000);

  it.skipIf(process.env.KYA_MCPB_MODULE !== undefined)("e2e: the unpacked bundle starts the MCP server and answers initialize and tools/list", async () => {
    expect(existsSync(join(ROOT, "dist/cli.js")), "run pnpm build first").toBe(true);
    const staged = join(dir, "pkg");
    mkdirSync(staged);
    for (const f of [...PKG.files, "package.json"]) {
      if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(staged, f), { recursive: true });
    }
    const buf = buildMcpb(staged, PKG.version);
    const out = join(dir, "unpacked");
    for (const [n, data] of unzipAll(buf) as Map<string, Buffer>) {
      mkdirSync(dirname(join(out, n)), { recursive: true });
      writeFileSync(join(out, n), data);
    }
    const home = join(dir, "home");
    mkdirSync(home);
    const child = spawn(process.execPath, [join(out, "claude/run-stdio.mjs")], {
      cwd: out, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", KYA_HOME: home, KYA_BASE_URL: "http://127.0.0.1:9", KYA_API_KEY: "sk_test_none" },
    });
    try {
      const replies: Record<number, any> = {};
      let acc = "";
      child.stdout.on("data", (d) => {
        acc += d;
        let i;
        while ((i = acc.indexOf("\n")) >= 0) {
          const line = acc.slice(0, i).trim();
          acc = acc.slice(i + 1);
          if (line) { try { const m = JSON.parse(line); if (m.id !== undefined) replies[m.id] = m; } catch { /* log line */ } }
        }
      });
      const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-test", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const deadline = Date.now() + 15000;
      while ((!replies[1] || !replies[2]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(replies[1]?.result?.serverInfo, JSON.stringify(replies)).toBeTruthy();
      const tools = (replies[2]?.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);
});

/** A package/ tarball of tinyPackage() plus whatever `extra` does inside the package dir. */
function tarballOf(version: string, extra: (pkg: string) => void = () => {}): Buffer {
  const root = join(dir, "tgzroot");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  const pkg = tinyPackage(version);
  cpSync(pkg, join(root, "package"), { recursive: true });
  extra(join(root, "package"));
  const out = join(dir, "t.tgz");
  const r = spawnSync("tar", ["-czf", out, "-C", root, "package"]);
  expect(r.status).toBe(0);
  return readFileSync(out);
}

describe("entry names (L2)", () => {
  it("badEntryName refuses backslash, colon, control chars, empty / . / .. segments, a leading slash", () => {
    for (const bad of ["a\\b", "a:b", "a\nb", "a\u0000b", "", ".", "..", "a/../b", "a//b", "/etc/passwd", "a/./b", "a/", "x\u007fy"]) {
      expect(badEntryName(bad), JSON.stringify(bad)).not.toBe("");
    }
    expect(badEntryName("/etc/passwd")).toBe("leading slash");
    for (const ok of ["manifest.json", "dist/cli.js", "assets/logo.svg", "a b/c-d_e.f"]) expect(badEntryName(ok), ok).toBe("");
  });

  it("zip() and the packer refuse such names", () => {
    expect(() => zip([{ name: "../x", data: Buffer.from("x") }])).toThrow(/segment/);
    const p = tinyPackage();
    writeFileSync(join(p, "assets", "bad\\name.txt"), "x");
    expect(() => buildMcpb(p, "1.2.3")).toThrow(/backslash, colon or control/);
  });
});

describe("duplicate entries and bundle comparison (M1)", () => {
  it("a zip with two entries of one name is refused by every reader", () => {
    const dup = zip([{ name: "manifest.json", data: Buffer.from("{}") }, { name: "manifest.json", data: Buffer.from('{"version":"9.9.9"}') }]);
    expect(() => zipNames(dup)).toThrow(/two entries with the same name/);
    expect(() => bundleVersion(dup)).toThrow(/two entries/);
    expect(() => entrySet(dup)).toThrow(/two entries/);
  });

  it("diffBundles: same entries = no diff; a changed byte, an added or a removed file is named", () => {
    const p = tinyPackage();
    const a = buildMcpb(p, "1.2.3");
    expect(diffBundles(a, buildMcpb(p, "1.2.3"))).toEqual([]);
    writeFileSync(join(p, "dist/cli.js"), "y".repeat(5000)); // same size, other bytes: only the crc differs
    expect(diffBundles(a, buildMcpb(p, "1.2.3")).join("\n")).toMatch(/only in the first bundle: dist\/cli\.js[\s\S]*only in the second bundle: dist\/cli\.js/);
    writeFileSync(join(p, "extra.txt"), "z");
    expect(diffBundles(a, buildMcpb(p, "1.2.3")).join("\n")).toMatch(/only in the second bundle: extra\.txt/);
    expect(diffBundles(buildMcpb(p, "1.2.3"), a).join("\n")).toMatch(/only in the first bundle: extra\.txt/);
  });

  it("the CLI compare exits 1 on a difference and 0 on equal bundles", () => {
    const p = tinyPackage();
    const a = join(dir, "a.mcpb");
    const b = join(dir, "b.mcpb");
    writeFileSync(a, buildMcpb(p, "1.2.3"));
    writeFileSync(b, buildMcpb(p, "1.2.3"));
    expect(spawnSync(process.execPath, [SCRIPT, "compare", a, b]).status).toBe(0);
    writeFileSync(join(p, "dist/cli.js"), "changed");
    writeFileSync(b, buildMcpb(p, "1.2.3"));
    const r = spawnSync(process.execPath, [SCRIPT, "compare", a, b], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/differ/);
  });
});

/**
 * Hand-made zip for the forgery cases: every field the strict reader checks can be set apart in the local header
 * and the central directory. Entries follow each other from byte 0; `gap` adds bytes between entries, `gapEnd`
 * between the last entry and the central directory.
 */
type CraftEntry = {
  name: string; data: Buffer; method?: 0 | 8; raw?: Buffer; crc?: number; localCrc?: number; usize?: number; flags?: number;
  localName?: string; centralMethod?: number; csizeCentral?: number;
};
function craft(entries: CraftEntry[], opts: { gap?: number; gapEnd?: number; cdGap?: number; trailing?: Buffer; leading?: Buffer } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  entries.forEach((e, i) => {
    const method = e.method ?? 0;
    const raw = e.raw ?? (method === 8 ? deflateRawSync(e.data) : e.data);
    const crc = e.crc ?? crc32(e.data);
    const usize = e.usize ?? e.data.length;
    const flags = e.flags ?? 0x0800;
    const name = Buffer.from(e.name);
    const lname = Buffer.from(e.localName ?? e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(e.localCrc ?? crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(lname.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(e.centralMethod ?? method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.csizeCentral ?? raw.length, 20);
    ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, name]));
    parts.push(lh, lname, raw);
    off += 30 + lname.length + raw.length;
    if (opts.gap && i < entries.length - 1) { parts.push(Buffer.alloc(opts.gap, 0x41)); off += opts.gap; }
  });
  if (opts.gapEnd) { parts.push(Buffer.alloc(opts.gapEnd, 0x41)); off += opts.gapEnd; }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([opts.leading ?? Buffer.alloc(0), ...parts, cd, Buffer.alloc(opts.cdGap ?? 0, 0x42), end, opts.trailing ?? Buffer.alloc(0)]);
}
const X = Buffer.from("AAAAAAAAAAAA-the-real-bytes");
const Y = Buffer.from("BBBBBBBBBBBB-forged-bytes!!");

describe("strict zip reading (M1, second review)", () => {
  it("a honest crafted zip reads, stored and deflate, and hashes the real bytes", () => {
    const z = craft([{ name: "a.txt", data: X }, { name: "b.txt", data: Buffer.alloc(3000, 7), method: 8 }]);
    const e = inspectZip(z);
    expect(e.map((x: { name: string }) => x.name)).toEqual(["a.txt", "b.txt"]);
    expect(e[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e[1].size).toBe(3000);
  });

  it("a forged central CRC and size over different local data is refused (the declared CRC is not the real one)", () => {
    expect(X.length).toBe(Y.length);
    const forged = craft([{ name: "a.txt", data: X, raw: Y }]); // central says crc(X), the bytes are Y
    expect(() => inspectZip(forged)).toThrow(/CRC mismatch/);
    expect(() => entrySet(forged)).toThrow(/CRC mismatch/);
    const forgedDeflate = craft([{ name: "a.txt", data: Buffer.alloc(500, 1), method: 8, raw: deflateRawSync(Buffer.alloc(500, 2)) }]);
    expect(() => inspectZip(forgedDeflate)).toThrow(/CRC mismatch/);
  });

  it("two entries with the same CRC32 and size but other bytes are different content (SHA-256, not CRC)", () => {
    // Birthday search for a CRC32 collision of two distinct 8-byte payloads (about 80 000 tries).
    const seen = new Map<number, Buffer>();
    let pair: [Buffer, Buffer] | undefined;
    for (let i = 0; !pair; i++) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(i) * 2654435761n);
      const c = crc32(b);
      const prev = seen.get(c);
      if (prev && !prev.equals(b)) pair = [prev, b]; else seen.set(c, b);
    }
    const [p1, p2] = pair;
    expect(crc32(p1)).toBe(crc32(p2));
    const good = craft([{ name: "a.txt", data: p1 }]);
    const swapped = craft([{ name: "a.txt", data: p2 }]); // honest zip: right CRC and size for its own bytes
    expect(() => inspectZip(swapped)).not.toThrow();
    expect(diffBundles(good, swapped).length).toBeGreaterThan(0);
    expect(diffBundles(good, craft([{ name: "a.txt", data: p1 }]))).toEqual([]);
  });

  it("refuses a local header that disagrees with the central directory", () => {
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, localName: "b.txt" }]))).toThrow(/local header disagrees/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, localCrc: 1 }]))).toThrow(/local header disagrees/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, centralMethod: 8 }]))).toThrow(/local header disagrees|unsupported|deflate|corrupt|invalid/i);
  });

  it("refuses data before the first entry, between entries, after the last entry, and after the end record", () => {
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }], { trailing: Buffer.from("EXTRA") }))).toThrow(/no end-of-central-directory record at the very end/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }], { leading: Buffer.from("LEAD") }))).toThrow();
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }, { name: "b.txt", data: Y }], { gap: 5 }))).toThrow(/gap|overlap/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }], { gapEnd: 5 }))).toThrow(/between the last entry and the central directory/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }], { cdGap: 5 }))).toThrow(/does not end at the end-of-central-directory record/);
  });

  it("refuses overlapping entries (two entries at one offset)", () => {
    const z = craft([{ name: "a.txt", data: X }, { name: "b.txt", data: Y }]);
    const cd = z.readUInt32LE(z.length - 6);
    const second = cd + 46 + "a.txt".length; // central header of b.txt
    z.writeUInt32LE(0, second + 42);
    expect(() => inspectZip(z)).toThrow(/gap|overlap/);
  });

  it("refuses ZIP64 markers, encryption and data descriptor flags, other methods, hidden bytes in a deflate entry", () => {
    const z64 = craft([{ name: "a.txt", data: X }]);
    z64.writeUInt32LE(0xffffffff, z64.readUInt32LE(z64.length - 6) + 20); // central csize
    expect(() => inspectZip(z64)).toThrow(/ZIP64/);
    const e64 = craft([{ name: "a.txt", data: X }]);
    e64.writeUInt16LE(0xffff, e64.length - 22 + 8); // entry counts in the end record
    e64.writeUInt16LE(0xffff, e64.length - 22 + 10);
    expect(() => inspectZip(e64)).toThrow(/ZIP64/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, flags: 0x0801 }]))).toThrow(/encrypted/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, flags: 0x0808 }]))).toThrow(/data descriptor/);
    expect(() => inspectZip(craft([{ name: "a.txt", data: X, method: 8, raw: X, centralMethod: 9 }]))).toThrow(/unsupported/);
    const hidden = Buffer.concat([deflateRawSync(Buffer.alloc(500, 1)), Buffer.from("HIDDEN-BYTES")]);
    expect(() => inspectZip(craft([{ name: "a.txt", data: Buffer.alloc(500, 1), method: 8, raw: hidden }]))).toThrow(/does not fill its entry/);
  });

  it("applies the per-file and the total size caps", () => {
    const z = craft([{ name: "a.txt", data: Buffer.alloc(60, 1) }, { name: "b.txt", data: Buffer.alloc(60, 2) }]);
    expect(() => inspectZip(z, { maxFile: 50 })).toThrow(/above the 50 limit/);
    expect(() => inspectZip(z, { maxTotal: 100 })).toThrow(/add up to more than 100/);
    expect(() => inspectZip(z, { maxFile: 60, maxTotal: 120 })).not.toThrow();
    // A deflate bomb whose declared size is small: the inflate itself is capped by the declared size.
    const bomb = craft([{ name: "a.txt", data: Buffer.alloc(50, 1), method: 8, raw: deflateRawSync(Buffer.alloc(5_000_000, 1)), usize: 50 }]);
    expect(() => inspectZip(bomb)).toThrow();
  });

  it("a duplicate entry name is refused", () => {
    expect(() => inspectZip(craft([{ name: "a.txt", data: X }, { name: "a.txt", data: Y }]))).toThrow(/two entries with the same name/);
  });
});

describe("version text (L7)", () => {
  it("bundleVersion refuses a version that is not a plain version string", () => {
    const withVersion = (v: string) => zip([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ version: v })) }]);
    expect(bundleVersion(withVersion("1.2.3-rc.1+b5"))).toBe("1.2.3-rc.1+b5");
    for (const bad of ["1.2.3\n@here", "1.2.3 ", "", "a".repeat(41), "1.2.3`x`", "v1/2"]) expect(() => bundleVersion(withVersion(bad)), JSON.stringify(bad)).toThrow(/plain version/);
  });
});

describe("the npm tarball is unpacked safely (L1, L3)", { timeout: 60000 }, () => {
  it("a normal tarball builds a bundle", () => {
    expect(bundleVersion(buildFromTarball(tarballOf("1.2.3"), "1.2.3"))).toBe("1.2.3");
  });

  it("refuses a symlink, a hardlink and a member outside package/", () => {
    const sym = tarballOf("1.2.3", (pkg) => symlinkSync("/etc/passwd", join(pkg, "assets/link")));
    expect(() => buildFromTarball(sym, "1.2.3")).toThrow(/not a regular file or directory/);
    const hard = tarballOf("1.2.3", (pkg) => linkSync(join(pkg, "dist/cli.js"), join(pkg, "dist/cli2.js")));
    expect(() => buildFromTarball(hard, "1.2.3")).toThrow(/not a regular file or directory/);
    const out = join(dir, "o.tgz");
    mkdirSync(join(dir, "r2"));
    writeFileSync(join(dir, "r2", "evil.txt"), "x");
    expect(spawnSync("tar", ["-czf", out, "-C", join(dir, "r2"), "evil.txt"]).status).toBe(0);
    expect(() => buildFromTarball(readFileSync(out), "1.2.3")).toThrow(/outside package/);
  });

  it("refuses a tarball above 50 MiB, a gzip bomb, one file above 50 MiB and a package above 200 MiB", () => {
    expect(() => unpackTarball(Buffer.alloc(50 * 1024 * 1024 + 1), join(dir, "x"))).toThrow(/above the .* limit/);
    expect(() => unpackTarball(gzipSync(Buffer.alloc(260 * 1024 * 1024)), join(dir, "x"))).toThrow(/larger than|too large/i);
    const big = tinyPackage();
    writeFileSync(join(big, "dist/big.bin"), Buffer.alloc(MAX_FILE + 1));
    expect(() => buildMcpb(big, "1.2.3")).toThrow(/above the .* limit/);
    rmSync(join(big, "dist/big.bin"));
    const many = big;
    for (let i = 0; i < 5; i++) writeFileSync(join(many, `dist/f${i}.bin`), Buffer.alloc(45 * 1024 * 1024, i));
    expect(() => buildMcpb(many, "1.2.3")).toThrow(/package is above/);
  });
});

// Every guard weakened in turn must fail some case above (the cases run against the weakened copy).
const MUTANTS: [string, string, string][] = [
  ["bad character in a name allowed", 'if (/[\\\\:\\u0000-\\u001f\\u007f]/.test(name)) return', "if (false) return"],
  ["leading slash allowed", 'if (name.startsWith("/")) return', "if (false) return"],
  ["empty, dot and dot-dot segments allowed", 'if (name.split("/").some(', 'if (name.split("/").filter(() => false).some('],
  ["per-file cap removed", "if (st.size > MAX_FILE) throw", "if (false) throw"],
  ["total cap removed", "if (total > MAX_EXTRACTED) throw", "if (false) throw"],
  ["tarball cap removed", "if (tgz.length > MAX_TARBALL) throw", "if (false) throw"],
  ["gzip bomb cap removed", "maxOutputLength: MAX_EXTRACTED + 16 * MiB", "maxOutputLength: 4096 * MiB"],
  ["duplicate entry names allowed", "new Set(rows.map((r) => r.name)).size !== rows.length", "false"],
  ["version text not checked", "if (!VERSION_TEXT.test(v)) throw", "if (false) throw"],
  ["symlink and hardlink members allowed", "if (!/^[-d]/.test(line)) throw", "if (false) throw"],
  ["member outside package/ allowed", 'if (!name.startsWith("package/") ||', 'if (false ||'],
  ["comparison uses central metadata only (CRC32), not the real bytes", "`${x.name}\\t${x.sha256}\\t${x.size}`", "`${x.name}\\t${x.crc}\\t${x.size}`"],
  ["trailing data after the end record allowed", "if (u32(buf, e) !== 0x06054b50) fail(", "if (false) fail("],
  ["ZIP64 end record allowed", "if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail(", "if (false) fail("],
  ["ZIP64 entry allowed", "if (r.csize === 0xffffffff || r.usize === 0xffffffff || r.off === 0xffffffff || hasZip64Extra(buf, p + 46 + r.nlen, r.xlen)) fail(", "if (false) fail("],
  ["central directory not tied to the end record", "if (cdOff + cdSize !== e) fail(", "if (false) fail("],
  ["encryption and descriptor flags allowed", "if (r.flags & BAD_FLAGS) fail(", "if (false) fail("],
  ["other compression methods allowed", "if (r.method !== 0 && r.method !== 8) fail(", "if (false) fail("],
  ["gaps and overlaps allowed", "if (r.off !== cursor) fail(", "if (false) fail("],
  ["data before the central directory allowed", "if (cursor !== cdOff) fail(", "if (false) fail("],
  ["local header not compared with the central one", "if (!same) fail(", "if (false) fail("],
  ["hidden bytes in a deflate entry allowed", "if (out.engine.bytesWritten !== r.csize) fail(", "if (false) fail("],
  ["CRC of the real bytes not checked", "if (crc32(data) !== r.crc) fail(", "if (false) fail("],
  ["zip per-file cap removed", "if (r.usize > maxFile) fail(", "if (false) fail("],
  ["zip total cap removed", "if (total > maxTotal) fail(", "if (false) fail("],
];

describe("mutants", () => {
  it.skipIf(process.env.KYA_MCPB_MODULE !== undefined)("every weakened guard is caught by a case above", () => {
    const src = readFileSync(join(ROOT, "scripts/packaging/mcpb.mjs"), "utf8");
    for (const [name, from, to] of MUTANTS) {
      expect(src.includes(from), `mutant "${name}": pattern not found`).toBe(true);
      const file = join(dir, `mutant-${MUTANTS.findIndex((m) => m[0] === name)}.mjs`);
      writeFileSync(file, src.replace(from, to));
      const r = spawnSync("pnpm", ["exec", "vitest", "run", "test/mcpb.test.ts"], {
        cwd: ROOT, encoding: "utf8", timeout: 180000, env: { ...process.env, KYA_MCPB_MODULE: file },
      });
      expect(r.status, `mutant "${name}" survived`).not.toBe(0);
    }
  }, 1800000);
});
