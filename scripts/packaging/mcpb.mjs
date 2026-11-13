#!/usr/bin/env node
// Claude Desktop extension bundle (.mcpb) of a kya release: a zip with manifest.json at its root
// (https://github.com/anthropics/mcpb, docs MANIFEST.md). The official packer (@anthropic-ai/mcpb) is
// not a dependency of this repo, so this file writes the zip format itself: no dependency, Node 24.
//
//   node mcpb.mjs build  <package-dir> <out.mcpb> <X.Y.Z>   zip <package-dir> after checking its manifest
//   node mcpb.mjs verify <file.mcpb> <X.Y.Z>                 exit 1 unless the bundle's manifest.json says X.Y.Z
//   node mcpb.mjs from-tarball <pkg.tgz> <out.mcpb> <X.Y.Z>  unpack the npm tarball safely, then build
//   node mcpb.mjs compare <a.mcpb> <b.mcpb>                  exit 1 unless both hold the same entries {name, SHA-256, size}
//
// <package-dir> is the unpacked npm tarball of @shield-agent/kya@X.Y.Z (dist/ is already built there),
// so the bundle holds exactly the bytes npm serves. The bundle has no node_modules: dist/ loads the
// OpenTelemetry packages only when the user turns telemetry on (src/otel.ts, dynamic import).
// Output is deterministic for one Node/zlib build: sorted entries, fixed timestamps, no extra fields.
// Used by .github/scripts/kya-mcpb-release.sh (build + upload) and .github/scripts/kya-channels.mjs (probe).
// Self-test: sdks/kya/test/mcpb.test.ts
import { createHash } from "node:crypto";
import { deflateRawSync, gunzipSync, inflateRawSync, crc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_ENTRIES = 20000; // zip64 is not written: the classic limit is 65535 entries
const MAX_MANIFEST = 1 << 20; // a manifest above 1 MiB is not a manifest
const MiB = 1 << 20;
// Size caps (the real tarball is 3.6 MiB, the bundle 3.8 MiB): a bomb or a swapped asset is refused, not unpacked.
export const MAX_TARBALL = 50 * MiB;
export const MAX_EXTRACTED = 200 * MiB;
export const MAX_FILE = 50 * MiB;
export const MAX_BUNDLE = 100 * MiB;
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,40}$/;

/** Reason an archive path is not allowed, or "". Backslash, colon, control chars, empty / . / .. segments, leading slash. */
export function badEntryName(name) {
  if (typeof name !== "string" || name === "") return "empty name";
  if (/[\\:\u0000-\u001f\u007f]/.test(name)) return "backslash, colon or control character"; // guard:name-chars
  if (name.startsWith("/")) return "leading slash"; // guard:name-slash
  if (name.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "empty, . or .. segment"; // guard:name-segments
  return "";
}

const posix = (p) => p.split(sep).join("/");

/** Relative posix paths of every file under dir, sorted. A symlink or special file is an error. */
function listFiles(dir, rel = "") {
  const out = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const bad = badEntryName(r);
    if (bad) throw new Error(`${JSON.stringify(r)}: ${bad}; refusing to pack it`);
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) out.push(...listFiles(dir, r));
    else if (st.isFile()) {
      if (st.size > MAX_FILE) throw new Error(`${r} is ${st.size} bytes, above the ${MAX_FILE} limit`); // guard:file-cap
      out.push(r);
    } else throw new Error(`${r} is not a regular file or directory (symlink?); refusing to pack it`);
  }
  return out;
}

/** Problems with the manifest of an unpacked package; empty = fine. */
export function manifestProblems(dir, version) {
  const p = [];
  if (!SEMVER.test(version)) return [`invalid version ${version}`];
  let m;
  try {
    m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    return [`manifest.json unreadable: ${e.message}`];
  }
  if (m.version !== version) p.push(`manifest.json version is ${m.version}, want ${version}`);
  for (const k of ["manifest_version", "name", "description"]) if (typeof m[k] !== "string" || !m[k]) p.push(`manifest.json has no ${k}`);
  const entry = m.server?.entry_point;
  if (typeof entry !== "string" || !existsSync(join(dir, entry))) p.push(`server.entry_point ${entry} is not in the package`);
  if (typeof m.icon === "string" && !existsSync(join(dir, m.icon))) p.push(`icon ${m.icon} is not in the package`);
  for (const a of m.server?.mcp_config?.args ?? []) {
    const f = /^\$\{__dirname\}\/(.+)$/.exec(a)?.[1];
    if (f && !existsSync(join(dir, f))) p.push(`mcp_config arg ${a} names a file that is not in the package`);
  }
  return p;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the zip epoch

/** Zip of [{ name, data }] (names sorted by the caller). Deflate, UTF-8 names, fixed timestamps. */
export function zip(entries) {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error(`${entries.length} entries (want 1..${MAX_ENTRIES})`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const badName = badEntryName(name);
    if (badName) throw new Error(`${JSON.stringify(name)}: ${badName}`);
    const nameBuf = Buffer.from(name, "utf8");
    const body = deflateRawSync(data, { level: 9 });
    const useDeflate = body.length < data.length;
    const stored = useDeflate ? body : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by (MS-DOS, no unix modes)
    local.copy(cd, 6, 4, 30); // version needed .. name length (same fields)
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    parts.push(local, nameBuf, stored);
    offset += 30 + nameBuf.length + stored.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + cdBuf.length >= 0xffffffff) throw new Error("bundle above 4 GiB");
  return Buffer.concat([...parts, cdBuf, end]);
}

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
const BAD_FLAGS = 0x2049; // bit 0 encrypted, bit 3 data descriptor, bit 6 strong encryption, bit 13 masked headers

/** True when a zip extra field block holds a ZIP64 record (header id 0x0001). */
function hasZip64Extra(buf, start, len) {
  for (let q = start; q + 4 <= start + len; ) {
    if (u16(buf, q) === 0x0001) return true;
    q += 4 + u16(buf, q + 2);
  }
  return false;
}

/**
 * Strict reading of a zip: what the file really holds, not what its central directory claims about itself.
 * Returns [{ name, size, crc, sha256, data }] in central directory order, or throws. Refused: data before the
 * first entry, between entries, or after the end-of-central-directory record (a comment included); overlapping
 * entries; a central entry whose local header disagrees on name, flags, method, crc or sizes; ZIP64; encryption
 * flags; data descriptors; any method except stored and deflate; two entries of one name; a deflate stream that
 * does not fill its entry exactly; sizes above the caps; a CRC32 that is not the CRC32 of the real bytes.
 * The SHA-256 is of the inflated bytes, so two bundles compare by content, never by compressed bytes (zlib output
 * differs across Node builds).
 */
export function inspectZip(buf, { maxFile = MAX_FILE, maxTotal = MAX_EXTRACTED } = {}) {
  const fail = (m) => {
    throw new Error(`zip: ${m}`);
  };
  if (buf.length < 22) fail("not a zip file (too short)");
  const e = buf.length - 22;
  if (u32(buf, e) !== 0x06054b50) fail("not a zip file: no end-of-central-directory record at the very end (trailing data or a comment?)"); // guard:zip-trailing
  if (u16(buf, e + 4) !== 0 || u16(buf, e + 6) !== 0 || u16(buf, e + 20) !== 0) fail("multi-disk archive or archive comment");
  const n = u16(buf, e + 8);
  const cdSize = u32(buf, e + 12);
  const cdOff = u32(buf, e + 16);
  if (n !== u16(buf, e + 10)) fail("entry counts of the end record disagree");
  if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail("ZIP64 is not supported"); // guard:zip-zip64
  if (cdOff + cdSize !== e) fail("the central directory does not end at the end-of-central-directory record"); // guard:zip-cd-end
  if (n === 0 || n > MAX_ENTRIES) fail(`${n} entries (want 1..${MAX_ENTRIES})`);
  const rows = [];
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (p + 46 > e || u32(buf, p) !== 0x02014b50) fail("corrupt central directory");
    const r = {
      flags: u16(buf, p + 8), method: u16(buf, p + 10), crc: u32(buf, p + 16), csize: u32(buf, p + 20), usize: u32(buf, p + 24),
      nlen: u16(buf, p + 28), xlen: u16(buf, p + 30), clen: u16(buf, p + 32), disk: u16(buf, p + 34), off: u32(buf, p + 42),
    };
    if (p + 46 + r.nlen + r.xlen + r.clen > e) fail("corrupt central directory");
    r.nameBytes = buf.subarray(p + 46, p + 46 + r.nlen);
    r.name = r.nameBytes.toString("utf8");
    if (!Buffer.from(r.name, "utf8").equals(r.nameBytes)) fail("an entry name is not valid UTF-8");
    if (r.flags & BAD_FLAGS) fail(`${JSON.stringify(r.name)}: encrypted entry or data descriptor flag`); // guard:zip-flags
    if (r.method !== 0 && r.method !== 8) fail(`${JSON.stringify(r.name)}: unsupported compression method ${r.method}`); // guard:zip-method
    if (r.csize === 0xffffffff || r.usize === 0xffffffff || r.off === 0xffffffff || hasZip64Extra(buf, p + 46 + r.nlen, r.xlen)) fail("ZIP64 is not supported");
    if (r.disk !== 0) fail("multi-disk archive");
    const bad = badEntryName(r.name);
    if (bad) fail(`${JSON.stringify(r.name)}: ${bad}`);
    rows.push(r);
    p += 46 + r.nlen + r.xlen + r.clen;
  }
  if (p !== e) fail("the central directory has extra bytes");
  // Two entries of one name: readers disagree on which wins (a manifest.json swap). Fail closed.
  if (new Set(rows.map((r) => r.name)).size !== rows.length) fail("the zip has two entries with the same name"); // guard:dup-names
  // Layout: entries follow each other from byte 0 up to the central directory, with no gap and no overlap.
  let cursor = 0;
  for (const r of [...rows].sort((a, b) => a.off - b.off)) {
    if (r.off !== cursor) fail(`${JSON.stringify(r.name)}: data before the first entry, a gap, or entries that overlap`); // guard:zip-layout
    if (r.off + 30 > cdOff || u32(buf, r.off) !== 0x04034b50) fail(`${JSON.stringify(r.name)}: no local header where the central directory says`);
    const lnlen = u16(buf, r.off + 26);
    const lxlen = u16(buf, r.off + 28);
    const same = u16(buf, r.off + 6) === r.flags && u16(buf, r.off + 8) === r.method && u32(buf, r.off + 14) === r.crc
      && u32(buf, r.off + 18) === r.csize && u32(buf, r.off + 22) === r.usize && lnlen === r.nlen
      && buf.subarray(r.off + 30, r.off + 30 + lnlen).equals(r.nameBytes);
    if (!same) fail(`${JSON.stringify(r.name)}: the local header disagrees with the central directory (name, flags, method, crc or sizes)`); // guard:zip-local
    if (hasZip64Extra(buf, r.off + 30 + lnlen, lxlen)) fail("ZIP64 is not supported");
    r.start = r.off + 30 + lnlen + lxlen;
    r.end = r.start + r.csize;
    if (r.end > cdOff) fail(`${JSON.stringify(r.name)}: its data runs into the central directory`);
    cursor = r.end;
  }
  if (cursor !== cdOff) fail("data between the last entry and the central directory");
  let total = 0;
  return rows.map((r) => {
    if (r.usize > maxFile) fail(`${JSON.stringify(r.name)} is ${r.usize} bytes, above the ${maxFile} limit`); // guard:zip-file-cap
    total += r.usize;
    if (total > maxTotal) fail(`the entries add up to more than ${maxTotal} bytes`);
    const raw = buf.subarray(r.start, r.end);
    let data;
    if (r.method === 0) {
      if (r.csize !== r.usize) fail(`${JSON.stringify(r.name)}: stored entry with two sizes`);
      data = raw;
    } else {
      const out = inflateRawSync(raw, { maxOutputLength: r.usize + 1, info: true });
      if (out.engine.bytesWritten !== r.csize) fail(`${JSON.stringify(r.name)}: the deflate stream does not fill its entry (hidden bytes)`); // guard:zip-deflate-fill
      data = out.buffer;
    }
    if (data.length !== r.usize) fail(`${JSON.stringify(r.name)}: real size ${data.length}, declared ${r.usize}`);
    if (crc32(data) !== r.crc) fail(`${JSON.stringify(r.name)}: CRC mismatch (the CRC32 of the real bytes is not the declared one)`); // guard:zip-crc
    return { name: r.name, size: data.length, crc: r.crc, sha256: createHash("sha256").update(data).digest("hex"), data };
  });
}

/** name -> bytes of every entry (strictly checked). */
export function unzipAll(buf, opts) {
  return new Map(inspectZip(buf, opts).map((x) => [x.name, x.data]));
}

/** The entries of a zip as sorted "name<TAB>sha256<TAB>size" lines: the real content, not how it is compressed. */
export function entrySet(buf) {
  return inspectZip(buf).map((x) => `${x.name}\t${x.sha256}\t${x.size}`).sort(); // guard:entry-set
}

/** Differences between two bundles as lines ("only in A: ...", "only in B: ..."); empty = same entries. */
export function diffBundles(a, b) {
  const [x, y] = [new Set(entrySet(a)), new Set(entrySet(b))];
  const short = (e) => e.replaceAll("\t", " ").replace(/ ([0-9a-f]{12})[0-9a-f]{52} /, " sha256:$1... ");
  return [...[...x].filter((e) => !y.has(e)).map((e) => `only in the first bundle: ${short(e)}`),
    ...[...y].filter((e) => !x.has(e)).map((e) => `only in the second bundle: ${short(e)}`)];
}

export function zipNames(buf) {
  return inspectZip(buf).map((x) => x.name);
}

/** Bytes of one entry (strictly checked), or null when the zip has no such entry. */
export function readZipEntry(buf, name, max = MAX_MANIFEST) {
  const x = inspectZip(buf).find((y) => y.name === name);
  if (!x) return null;
  if (x.size > max) throw new Error(`${name} is ${x.size} bytes, above the ${max} limit`);
  return x.data;
}

/** Version the bundle's manifest.json declares; throws when the bundle has none. */
export function bundleVersion(buf) {
  const raw = readZipEntry(buf, "manifest.json");
  if (!raw) throw new Error("the bundle has no manifest.json at its root");
  const v = JSON.parse(raw.toString("utf8")).version;
  if (typeof v !== "string") throw new Error("manifest.json has no version string");
  if (!VERSION_TEXT.test(v)) throw new Error("manifest.json version is not a plain version string"); // guard:version-text
  return v;
}

/** Build the bundle of an unpacked package dir; returns the zip bytes. Throws on a bad manifest. */
export function buildMcpb(dir, version) {
  const problems = manifestProblems(dir, version);
  if (problems.length) throw new Error(`refusing to build the .mcpb: ${problems.join("; ")}`);
  const files = listFiles(dir);
  const entries = [];
  let total = 0;
  for (const name of files) {
    const data = readFileSync(join(dir, name));
    total += data.length;
    if (total > MAX_EXTRACTED) throw new Error(`the package is above ${MAX_EXTRACTED} bytes`); // guard:total-cap
    entries.push({ name: posix(name), data });
  }
  return zip(entries);
}

/**
 * Unpack an npm tarball (bytes) into `dir` and return nothing. Only regular files and directories under
 * package/ are accepted: a symlink, hardlink, device or fifo entry fails before anything is written, and the
 * decompressed stream is capped (a gzip bomb). `tar` runs without a shell and without owner restore.
 */
export function unpackTarball(tgz, dir) {
  if (tgz.length > MAX_TARBALL) throw new Error(`the tarball is ${tgz.length} bytes, above the ${MAX_TARBALL} limit`); // guard:tarball-cap
  const raw = gunzipSync(tgz, { maxOutputLength: MAX_EXTRACTED + 16 * MiB });
  const TAR_MS = 120000; // a stuck tar is an error, never a hang of the release step
  const tar = (args) => execFileSync("tar", args, { input: raw, encoding: "utf8", maxBuffer: 64 * MiB, stdio: ["pipe", "pipe", "pipe"], timeout: TAR_MS });
  for (const line of tar(["-tvf", "-"]).split("\n").filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error(`the tarball has an entry that is not a regular file or directory: ${JSON.stringify(line.slice(0, 120))}`); // guard:tar-types
  }
  for (const name of tar(["-tf", "-"]).split("\n").filter(Boolean)) {
    if (!name.startsWith("package/") || name.split("/").includes("..")) throw new Error(`the tarball has a member outside package/: ${JSON.stringify(name.slice(0, 120))}`);
  }
  execFileSync("tar", ["-xf", "-", "-C", dir, "--strip-components=1", "--no-same-owner"], { input: raw, stdio: ["pipe", "pipe", "pipe"], timeout: TAR_MS });
}

/** Bundle bytes built from the bytes of the npm tarball of `version`. */
export function buildFromTarball(tgz, version) {
  const dir = mkdtempSync(join(tmpdir(), "kya-mcpb-"));
  try {
    unpackTarball(tgz, dir);
    return buildMcpb(dir, version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(argv) {
  const [cmd, a, b, c] = argv;
  if (cmd === "build" && a && b && c) {
    const buf = buildMcpb(a, c);
    writeFileSync(b, buf);
    console.log(`mcpb: wrote ${b} (${buf.length} bytes, manifest version ${bundleVersion(buf)})`);
    return 0;
  }
  if (cmd === "from-tarball" && a && b && c) {
    const buf = buildFromTarball(readFileSync(a), c);
    writeFileSync(b, buf);
    console.log(`mcpb: wrote ${b} (${buf.length} bytes, manifest version ${bundleVersion(buf)})`);
    return 0;
  }
  if (cmd === "compare" && a && b) {
    const diff = diffBundles(readFileSync(a), readFileSync(b));
    if (diff.length) throw new Error(`${a} and ${b} differ:\n  ${diff.slice(0, 20).join("\n  ")}`);
    console.log(`mcpb: ${a} holds the same entries as ${b}`);
    return 0;
  }
  if (cmd === "verify" && a && b) {
    if (!SEMVER.test(b)) throw new Error(`invalid version ${b}`);
    const v = bundleVersion(readFileSync(a));
    if (v !== b) throw new Error(`${a}: manifest version is ${v}, want ${b}`);
    console.log(`mcpb: ${a} carries manifest version ${v}`);
    return 0;
  }
  throw new Error("usage: mcpb.mjs build <package-dir> <out.mcpb> X.Y.Z | from-tarball <pkg.tgz> <out.mcpb> X.Y.Z | compare <a.mcpb> <b.mcpb> | verify <file.mcpb> X.Y.Z");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (e) {
    console.error(`mcpb: ${e.message}`);
    process.exitCode = 1;
  }
}
