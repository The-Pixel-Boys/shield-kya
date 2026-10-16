// Unit tests for dist/core.js (node:test, no extra deps). Run: pnpm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../dist/core.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kya-vscode-"));
const row = (o = {}) => JSON.stringify({ ts: new Date().toISOString(), sessionId: "s1", toolId: "Read", verdict: "ALLOW", reasonCode: "OK", mode: "offline", ...o });
// Token-shaped fixtures are built at runtime so the mirror token scan and gitleaks stay quiet.
const fakeStripe = ["sk", "live", "a".repeat(30)].join("_");
const fakeGh = "gh" + "p_" + "b".repeat(36);
const pem = ["-----BEGIN RSA PRIVATE", "KEY-----\nMIIx\n-----END RSA PRIVATE", "KEY-----\n"].join(" ");
const fakeJwt = "ey" + "J" + "c".repeat(20) + "." + "d".repeat(20) + "." + "e".repeat(10);

test("parseTrailLine maps verdicts and keeps flags", () => {
  assert.equal(core.parseTrailLine(row()).verdict, "ALLOW");
  assert.equal(core.parseTrailLine(row({ verdict: "REQUIRE_APPROVE" })).verdict, "REVIEW");
  const d = core.parseTrailLine(row({ verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true, shadow: true, importedFrom: "agt" }));
  assert.equal(d.verdict, "DENY");
  assert.equal(d.neverEvent, true);
  assert.equal(d.shadow, true);
  assert.equal(d.importedFrom, "agt");
  assert.equal(core.parseTrailLine(row({ verdict: "WEIRD" })).verdict, "OTHER");
  assert.equal(core.parseTrailLine(row({ verdict: "REQUIRE_APPROVE", mode: "hold" })).verdict, "HOLD", "hold mode is not an advisory REVIEW");
  assert.equal(core.parseTrailLine(row({ verdict: "REQUIRE_APPROVE", mode: "observe" })).verdict, "REVIEW");
});

test("parseTrailLine drops malformed lines", () => {
  for (const bad of ["", "{", "null", "[]", "42", '"x"', row({ mode: "enforce" }), row({ ts: 5 }), row({ toolId: undefined }),
    JSON.stringify({ ts: "t", sessionId: "s", toolId: "x", verdict: "ALLOW", mode: "offline" })]) {
    assert.equal(core.parseTrailLine(bad), undefined, bad);
  }
  assert.equal(core.parseTrailLine(row({ summary: "x".repeat(70 * 1024) })), undefined, "giant line");
  assert.equal(core.parseTrailLine(row({ neverEvent: "yes" })).neverEvent, false, "non-boolean flag is false");
});

test("redaction scrubs secrets in every displayed field", () => {
  const r = core.parseTrailLine(row({
    toolId: `mcp__x__${fakeStripe}`,
    summary: `curl -H "Authorization: Bearer ${fakeJwt}" https://u:pw@host/x?token=abc`,
    targetPath: `/tmp/${fakeGh}/f`,
    diffPreview: `API_KEY=${"z".repeat(12)}\npassword: hunter2\n${pem}` + "l\n".repeat(20),
  }));
  const all = [r.toolId, r.summary, r.targetPath, r.diffPreview].join("\n");
  for (const secret of [fakeStripe, fakeGh, fakeJwt, "hunter2", "zzzzzzzzzzzz", "MIIx", "u:pw@", "token=abc"]) {
    assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 8)}`);
  }
  assert.ok(r.diffPreview.split("\n").length <= 8, "preview clipped to 8 lines");
  assert.ok(r.summary.length <= 200);
});

test("TrailTailer: incremental, partial line held, truncate resets, missing file ok", () => {
  const dir = tmp();
  const f = path.join(dir, "trail.jsonl");
  const t = new core.TrailTailer(f);
  assert.deepEqual(t.poll().rows, []);
  fs.writeFileSync(f, row() + "\n" + row({ verdict: "DENY" }).slice(0, 20));
  let p = t.poll();
  assert.equal(p.rows.length, 1);
  fs.appendFileSync(f, row({ verdict: "DENY" }).slice(20) + "\n");
  p = t.poll();
  assert.equal(p.rows.length, 1, "partial line completed");
  assert.equal(p.rows[0].verdict, "DENY");
  assert.equal(t.poll().rows.length, 0, "nothing new");
  fs.writeFileSync(f, row({ verdict: "REQUIRE_APPROVE" }) + "\n");
  p = t.poll();
  assert.equal(p.reset, true, "shrink resets");
  assert.equal(p.rows[0].verdict, "REVIEW");
  fs.appendFileSync(f, "not json\n{\"ts\":1}\n" + row() + "\n");
  assert.equal(t.poll().rows.length, 1, "bad lines skipped, good kept");
  fs.rmSync(f);
  assert.equal(t.poll().reset, true, "deleted file resets");
});

test("TrailTailer: huge file reads only the tail and drops the cut first line", () => {
  const dir = tmp();
  const f = path.join(dir, "trail.jsonl");
  const line = row({ summary: "s".repeat(500) }) + "\n";
  fs.writeFileSync(f, line.repeat(Math.ceil((3 * 1024 * 1024) / line.length)));
  const t = new core.TrailTailer(f);
  const { rows, reset } = t.poll();
  assert.equal(reset, true);
  assert.ok(rows.length > 100 && rows.length <= Math.ceil(core.TAIL_BYTES / line.length), `rows=${rows.length}`);
  // A burst bigger than the tail window skips ahead instead of reading it all.
  fs.appendFileSync(f, line.repeat(Math.ceil((2 * 1024 * 1024) / line.length)));
  const burst = t.poll();
  assert.equal(burst.reset, true);
  // A runaway line with no newline is dropped, not buffered forever.
  const t2 = new core.TrailTailer(f, 1024);
  t2.poll();
  fs.appendFileSync(f, "x".repeat(900));
  t2.poll();
  fs.appendFileSync(f, "x".repeat(900));
  t2.poll();
  fs.appendFileSync(f, "\n" + row() + "\n");
  assert.equal(t2.poll().rows.length, 1);
});

test("countRows windows by time and counts never-list", () => {
  const now = Date.now();
  const rows = [
    core.parseTrailLine(row()),
    core.parseTrailLine(row({ verdict: "REQUIRE_APPROVE" })),
    core.parseTrailLine(row({ verdict: "DENY", neverEvent: true })),
    core.parseTrailLine(row({ verdict: "REQUIRE_APPROVE", mode: "hold" })),
    core.parseTrailLine(row({ ts: new Date(now - 2 * 86400_000).toISOString() })),
    core.parseTrailLine(row({ ts: "garbage" })),
  ];
  assert.deepEqual(core.countRows(rows, now - 86400_000), { allow: 1, review: 1, hold: 1, deny: 1, never: 1 });
});

test("gate mode comes from hook commands, not trail rows", () => {
  // Exact shapes kya writes (wire-hooks.ts): JSON `hooks` for claude/grok, TOML literal for kimi.
  const cmd = (flags) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `"/n" "/k/dist/cli.js" hook --host claude${flags}` }] }] } });
  const adv = cmd("");
  const strict = cmd(" --strict");
  const hosted = `[[hooks]]\ncommand = '"/n" "/k/dist/cli.js" hook --host kimi --plane-config "/p"'\n`;
  const fc = cmd(" --fail-closed");
  assert.deepEqual(core.gateModeFromTexts([]), { mode: "none", hooks: 0 });
  assert.equal(core.gateModeFromTexts([adv]).mode, "advisory");
  assert.equal(core.gateModeFromTexts([strict]).mode, "strict");
  assert.equal(core.gateModeFromTexts([hosted]).mode, "strict");
  assert.equal(core.gateModeFromTexts([fc]).mode, "strict");
  assert.equal(core.gateModeFromTexts([adv, strict]).mode, "mixed");
  // Claude Code plugins (the default install path): kya@<marketplace> is advisory.
  assert.deepEqual(core.gateModeFromTexts(['{"enabledPlugins":{"kya@shield-kya": true}}']), { mode: "advisory", hooks: 1 });
  assert.equal(core.gateModeFromTexts(['{"enabledPlugins":{"kya-hosted@shield-kya":true}}']).mode, "strict");
  assert.equal(core.gateModeFromTexts(['{"enabledPlugins":{"kya@shield-kya": false, "other@x": true}}']).mode, "none", "disabled plugin is not wiring");
  const home = tmp();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), strict);
  assert.deepEqual(core.detectGateMode(home), { mode: "strict", hooks: 1 });
  assert.deepEqual(core.detectGateMode(tmp()), { mode: "none", hooks: 0 });
});

test("executable resolution never returns a workspace file", () => {
  const ws = tmp();
  const sys = tmp();
  for (const d of [ws, sys]) {
    fs.writeFileSync(path.join(d, "kya"), "#!/bin/sh\n", { mode: 0o755 });
  }
  fs.writeFileSync(path.join(sys, "notexec"), "", { mode: 0o644 });
  const opts = { win: false, ci: false };
  const dirs = core.safePath([ws, "relative/bin", ".", sys].join(path.delimiter), [ws], false);
  assert.deepEqual(dirs, [sys], "workspace and relative PATH entries removed");
  assert.equal(core.findExecutable("kya", [ws, sys], [ws], opts), fs.realpathSync(path.join(sys, "kya")));
  assert.equal(core.findExecutable("notexec", [sys], [], opts), undefined, "needs the exec bit");
  // A symlink outside the workspace that points into it is refused (realpath check).
  const link = tmp();
  fs.symlinkSync(path.join(ws, "kya"), path.join(link, "kya"));
  assert.equal(core.findExecutable("kya", [link], [ws], opts), undefined);
  assert.equal(core.userPath("relative/kya", [], false), undefined);
  assert.equal(core.userPath(path.join(link, "kya"), [ws], false), undefined);
  assert.equal(core.userPath(path.join(sys, "kya"), [ws], false), fs.realpathSync(path.join(sys, "kya")));
  assert.equal(core.isInside("/A/b", ["/a"], true), true);
  assert.equal(core.isInside("/A/b", ["/a"], false), false);
  assert.equal(core.isInside("/a-b", ["/a"], false), false, "sibling prefix is not inside");
});

test("kyaCliJs finds dist/cli.js behind a bin", () => {
  const prefix = tmp();
  const cli = path.join(prefix, "node_modules", "@shield-agent", "kya", "dist", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "");
  assert.equal(core.kyaCliJs(cli), cli);
  assert.equal(core.kyaCliJs(path.join(prefix, "kya.cmd")), cli, "windows npm layout");
  assert.equal(core.kyaCliJs(path.join(tmp(), "kya")), undefined);
});

test("validateBaseUrl: https, loopback http only, no credentials", () => {
  assert.equal(core.validateBaseUrl("https://shield-agent.com/"), "https://shield-agent.com");
  assert.equal(core.validateBaseUrl("http://127.0.0.1:8090"), "http://127.0.0.1:8090");
  for (const bad of ["http://shield-agent.com", "http://127.0.0.1.evil.com", "https://u:p@x.com", "https://x.com/?a=1", "file:///etc", "javascript:alert(1)", "nope"]) {
    assert.throws(() => core.validateBaseUrl(bad), undefined, bad);
  }
});

function recorder(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 200, body: "[]" };
    return { ok: r.status < 300, status: r.status, text: async () => r.body };
  };
  return { calls, fetch };
}

test("HostedClient: auth header per key type, redirect error, shape filtering", async () => {
  const jwt = recorder([{ status: 200, body: JSON.stringify([{ id: "1f0e", status: "PENDING", action: `deploy ${fakeStripe}` }, { id: 5 }, null]) }]);
  const list = await new core.HostedClient("https://h", "jwt-token", jwt.fetch).list();
  assert.equal(list.length, 1);
  assert.ok(!list[0].action.includes(fakeStripe), "action redacted");
  assert.equal(jwt.calls[0].url, "https://h/api/v1/kya/approvals");
  assert.equal(jwt.calls[0].redirect, "error");
  assert.equal(jwt.calls[0].headers.Authorization, "Bearer jwt-token");
  const mk = recorder([]);
  await new core.HostedClient("https://h", fakeStripe, mk.fetch).list();
  assert.equal(mk.calls[0].headers["X-API-Key"], fakeStripe);
  assert.equal(mk.calls[0].headers.Authorization, undefined);
});

test("HostedClient.decide: machine key and bad id never reach the network", async () => {
  const r = recorder([]);
  await assert.rejects(new core.HostedClient("https://h", fakeStripe, r.fetch).decide("1f0e", "approve"), /machine keys/);
  await assert.rejects(new core.HostedClient("https://h", "jwt", r.fetch).decide("../../admin", "approve"), /UUID/);
  assert.equal(r.calls.length, 0);
  const ok = recorder([{ status: 200, body: '{"id":"1f0e","status":"APPROVED"}' }]);
  assert.deepEqual(await new core.HostedClient("https://h", "jwt", ok.fetch).decide("1f0e", "approve"), { id: "1f0e", status: "APPROVED" });
  assert.equal(ok.calls[0].method, "POST");
  assert.equal(ok.calls[0].url, "https://h/api/v1/kya/approvals/1f0e/approve");
  const denied = recorder([{ status: 403, body: "" }]);
  await assert.rejects(new core.HostedClient("https://h", "jwt", denied.fetch).decide("1f0e", "reject"), /rejected the key/);
  const junk = recorder([{ status: 200, body: "<html>" }]);
  await assert.rejects(new core.HostedClient("https://h", "jwt", junk.fetch).list(), /non-JSON/);
});

// ---------- return path 1 (review of PR #413) ----------

test("MED-2: long uppercase fields are cut before redaction (time budget)", () => {
  const evil = "A" + "KEY".repeat(21000); // 63 KB, the quadratic case for the env-assignment shape
  let t = Date.now();
  const r = core.parseTrailLine(row({ summary: evil }));
  const r2 = core.parseTrailLine(row({ toolId: evil }));
  assert.ok(Date.now() - t < 100, `one row took ${Date.now() - t} ms`);
  assert.ok(Date.now() - t < 200, `two rows took ${Date.now() - t} ms`);
  assert.ok(r.summary.length <= 200 && r2.toolId.length <= 120);
  const dir = tmp();
  const f = path.join(dir, "trail.jsonl");
  fs.writeFileSync(f, (row({ summary: evil }) + "\n").repeat(16));
  t = Date.now();
  const p = new core.TrailTailer(f).poll();
  assert.ok(Date.now() - t < 500, `1 MB poll took ${Date.now() - t} ms`);
  assert.equal(p.rows.length >= 15, true);
  // Secrets inside the displayed part are still redacted after the cut.
  assert.ok(!core.display(`x ${fakeStripe} ` + "B".repeat(5000), 200).includes(fakeStripe));
});

test("MED-2: server action text is cut before redaction too", async () => {
  const r = recorder([{ status: 200, body: JSON.stringify([{ id: "1f0e", status: "PENDING", action: "A" + "KEY".repeat(30000) }]) }]);
  const t = Date.now();
  const list = await new core.HostedClient("https://h", "jwt", r.fetch).list();
  assert.ok(Date.now() - t < 100, `list took ${Date.now() - t} ms`);
  assert.ok(list[0].action.length <= 120);
});

test("LOW-1: unreadable trail or a directory never throws", () => {
  const dir = tmp();
  assert.deepEqual(new core.TrailTailer(dir).poll(), { rows: [], reset: false, error: "not a file" });
  const f = path.join(dir, "trail.jsonl");
  fs.writeFileSync(f, row() + "\n");
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(f, 0o000);
    const p = new core.TrailTailer(f).poll();
    fs.chmodSync(f, 0o600);
    assert.equal(p.error, "EACCES");
    assert.deepEqual(p.rows, []);
  }
  assert.equal(new core.TrailTailer(path.join(dir, "missing")).poll().error, undefined, "missing file is just empty");
});

test("runaway line without newline is capped, not buffered forever", () => {
  const dir = tmp();
  const f = path.join(dir, "trail.jsonl");
  fs.writeFileSync(f, "");
  const t = new core.TrailTailer(f, 1024);
  t.poll();
  fs.appendFileSync(f, "x".repeat(900));
  t.poll();
  fs.appendFileSync(f, "x".repeat(900));
  t.poll();
  assert.equal(t.pendingBytes, 0, "pending dropped once it passes tailBytes");
  fs.appendFileSync(f, "\n" + row() + "\n");
  assert.equal(t.poll().rows.length, 1);
});

test("LOW-5: a multibyte character split across two writes is decoded intact", () => {
  const dir = tmp();
  const f = path.join(dir, "trail.jsonl");
  const bytes = Buffer.from(row({ toolId: "écrire_fichier" }) + "\n", "utf8");
  const cut = bytes.indexOf(0xc3) + 1; // inside the 2-byte é
  fs.writeFileSync(f, bytes.subarray(0, cut));
  const t = new core.TrailTailer(f);
  assert.equal(t.poll().rows.length, 0);
  fs.appendFileSync(f, bytes.subarray(cut));
  assert.equal(t.poll().rows[0].toolId, "écrire_fichier");
});

test("LOW-3: only real hook commands count; permissions strings and disabled hooks do not", () => {
  const settings = (o) => JSON.stringify(o);
  const hook = (cmd) => ({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }] } });
  const adv = '"/usr/bin/node" "/x/@shield-agent/kya/dist/cli.js" hook --host claude';
  assert.equal(core.gateModeFromTexts([settings({ permissions: { allow: ["Bash(kya hook --host claude --strict:*)"] } })]).mode, "none");
  assert.equal(core.gateModeFromTexts([settings({ ...hook(adv + " --strict"), disableAllHooks: true })]).mode, "none");
  assert.equal(core.gateModeFromTexts([settings(hook(adv))]).mode, "advisory");
  assert.equal(core.gateModeFromTexts([settings(hook(adv + " --strict"))]).mode, "strict");
  assert.equal(core.gateModeFromTexts([settings(hook('echo "hook --host claude --strict"'))]).mode, "none", "foreign command with the words");
  assert.equal(core.gateModeFromTexts([`[[hooks]]\nevent = "PreToolUse"\ncommand = '${adv} --plane-config "/p"'\n`]).mode, "strict", "kimi toml");
  assert.equal(core.gateModeFromTexts(["# command = 'kya hook --host kimi --strict'\n"]).mode, "none", "toml comment");
  assert.equal(core.gateModeFromTexts([settings(hook("echo kya hook --host claude --strict"))]).mode, "none", "N9: only a kya bin or cli.js may run the hook");
  assert.equal(core.gateModeFromTexts([settings(hook(adv + ' --plane-config "/h/p.json" --plane-shadow'))]).mode, "advisory", "NEW-2: shadow never blocks");
  assert.equal(core.gateModeFromTexts([settings(hook(adv + ' --plane-config "/h/p.json" --strict --plane-shadow'))]).mode, "advisory", "NEW-2: shadow wins over --strict");
});

test("LOW-4: control and bidi characters never reach displayed fields", () => {
  const r = core.parseTrailLine(row({ verdict: "DENY", toolId: "x\u202e\u2066WOLLA\r\n\u001b[32mALLOW\u200b", summary: "a\u0007b" }));
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(r.toolId + r.summary), JSON.stringify(r.toolId));
  const d = core.parseTrailLine(row({ diffPreview: "l1\nl2\u202e" }));
  assert.equal(d.diffPreview, "l1\nl2 ", "newlines kept in previews only");
});

test("virtual workspaces are never trusted for spawns, MCP or network", () => {
  assert.equal(core.trustedFor(true, ["file"]), true);
  assert.equal(core.trustedFor(true, []), true, "empty window");
  assert.equal(core.trustedFor(true, ["file", "vscode-vfs"]), false);
  assert.equal(core.trustedFor(false, ["file"]), false);
});

test("kya child env: PATH replaced by the sanitized dirs, Windows Path key dropped", () => {
  const env = core.childEnv(["/safe/bin", "/usr/bin"], { PATH: "/ws/bin:/usr/bin", Path: "C:\\ws\\bin", HOME: "/h" }, false);
  assert.equal(env.PATH, "/safe/bin:/usr/bin");
  assert.equal(env.Path, undefined);
  assert.equal(env.HOME, "/h");
  assert.equal(core.childEnv(["C:\\a", "C:\\b"], {}, true).PATH, "C:\\a;C:\\b");
});

test("NEW-1: a token cut at the pre-cut boundary never shows partially", () => {
  const pem = ["-----BEGIN RSA PRIVATE", "KEY-----\n" + "M".repeat(700) + "\n-----END RSA PRIVATE", "KEY-----"].join(" ");
  for (const [tok, keep, secret] of [["sk-ant-" + "Z".repeat(40), 15, "ZZZZ"], ["ghp_" + "Q".repeat(36), 10, "QQQQ"], ["AKIA" + "W".repeat(16), 10, "WWWW"]]) {
    const lead = pem + " ".repeat(800 - keep - pem.length);
    assert.equal(lead.length + keep, 800);
    const out = core.display(lead + tok + " tail", 200);
    assert.ok(!out.includes(secret), `${tok.slice(0, 7)} keep=${keep}: ${JSON.stringify(out)}`);
  }
});

test("NEW-3: env assignments with very long names are still redacted, and stay cheap", () => {
  for (const v of ["A".repeat(70) + "_API_KEY=abc123secret", "MY_TOKEN" + "_X".repeat(40) + "=abc123secret"]) {
    assert.ok(!core.redact(v).includes("abc123secret"), v.slice(0, 20));
  }
  assert.ok(core.redact("AWS_SECRET_ACCESS_KEY=abc123secret").endsWith("=[redacted]"));
  const t = Date.now();
  core.display("A" + "KEY".repeat(30000), 480);
  core.display(("A".repeat(63) + "_").repeat(40), 480);
  assert.ok(Date.now() - t < 100, `took ${Date.now() - t} ms`);
});
