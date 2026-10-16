// Runs INSIDE a real VS Code extension host (--extensionTestsPath). Drives the Shield KYA extension
// that e2e/run.mjs installed from the .vsix, against a real kya and a local stub of the hosted API.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cfg = JSON.parse(process.env.KYA_E2E_JSON);
const results = [];
const check = (name, ok, detail) => results.push({ name, pass: Boolean(ok), detail: detail === undefined ? undefined : String(detail).slice(0, 300) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(200);
  }
}
const stubLog = async () => (await (await fetchReal(`${cfg.stub}/__log`)).json());
let fetchReal;

function kyaHook(toolName, toolInput, id) {
  const payload = JSON.stringify({ session_id: "e2e", hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: cfg.ws, tool_use_id: id });
  return spawnSync(cfg.node, [cfg.cli, "hook", "--host", "claude"], { input: payload, env: { ...process.env, KYA_HOME: cfg.home }, encoding: "utf8" }).status;
}

exports.run = async function run() {
  fetchReal = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = (url, init) => { fetchCalls.push(String(url)); return fetchReal(url, init); };
  const notes = [];
  const opened = [];
  const ui = {
    info: (m) => notes.push(`info: ${m}`), warn: (m) => notes.push(`warn: ${m}`), error: (m) => notes.push(`error: ${m}`),
    confirm: async () => true, pick: async (items) => items.find((i) => i.label === "claude"),
    input: async () => undefined, openExternal: async (u) => { opened.push(u.toString()); return true; },
  };
  try {
    const ext = vscode.extensions.getExtension("shield-agent.shield-kya");
    if (cfg.scenario === "production") {
      check("installed from the .vsix (extensions dir)", ext && ext.extensionPath.startsWith(cfg.installedDir), ext && ext.extensionPath);
      const exportsValue = await ext.activate();
      check("production mode exposes no test API / prompt seam", exportsValue === undefined, typeof exportsValue);
      check("extension is active", ext.isActive);
      return;
    }
    check("extension runs from the unpacked .vsix contents", ext && ext.extensionPath === cfg.extDir, ext && ext.extensionPath);
    const api = await ext.activate();
    check("test API present (ExtensionMode.Test)", api && typeof api.statusText === "function");
    // Route through the extension's seam on every change (setUi copies the functions).
    const setUi = new Proxy({}, { set: (_t, k, v) => { ui[k] = v; api.setUi({ [k]: v }); return true; } });
    api.setUi(ui);
    const sc = cfg.scenario;
    check(`workspace trust is ${sc === "untrusted" ? "off" : "on"}`, vscode.workspace.isTrusted === (sc !== "untrusted"), vscode.workspace.isTrusted);

    // (a) live feed from the real kya trail; the hostile workspace trailPath is ignored.
    await waitFor(() => api.feed().length >= 4);
    const feed = api.feed();
    const verdicts = feed.map((r) => `${r.verdict}${r.neverEvent ? "!" : ""}:${r.toolId}`).join(",");
    check("feed shows ALLOW/REVIEW/never-list DENY rows written by real kya", /ALLOW:Read/.test(verdicts) && /REVIEW:Bash/.test(verdicts) && /DENY!:mcp__postgres__drop_table/.test(verdicts), verdicts);
    check("hold-mode REQUIRE_APPROVE row shows as HOLD (handwritten row)", /HOLD:deploy\.production/.test(verdicts), verdicts);
    check("workspace shieldKya.trailPath is ignored", !feed.some((r) => r.toolId.includes("HOSTILE")), verdicts);
    check("no secret reaches a row", !JSON.stringify(feed).includes(cfg.secretMarker), "");
    // (c) status bar: gate mode from the real wired hook + counts.
    const wantMode = sc === "trusted" ? "advisory" : sc === "nokya" ? "advisory" : "unknown";
    check(`status bar shows gate mode '${wantMode}' (${sc === "nokya" ? "Claude plugin" : sc === "trusted" ? "user hook" : "nothing wired, trail active"}) and counts`,
      new RegExp(`KYA ${wantMode}\\b`).test(api.statusText()) && /1 allow 1 review 1 hold 1 deny/.test(api.statusText()), api.statusText());
    check("status tooltip states advisory/fail-open semantics", /blocks only the never-list; it fails open/.test(api.statusTooltip()), api.statusTooltip());
    check("feed tooltips are plain strings (never MarkdownString)", api.feed().every((_, i) => typeof api.feedItem(i).tooltip === "string"), typeof api.feedItem(0).tooltip);
    // Live tail: a new real hook call shows up without reload.
    kyaHook("mcp__postgres__drop_table", { table: "users" }, `live-${sc}`);
    check("live tail picks up a new DENY row", await waitFor(() => api.feed().length >= 5), api.feed().length);
    if (sc === "trusted") {
      // Eb: push the never-list row out of the 200 shown rows; the bar must stay red.
      const trailFile = path.join(cfg.home, ".kya", "trail.jsonl");
      const filler = Array.from({ length: 210 }, (_, i) => JSON.stringify({ ts: new Date().toISOString(), sessionId: "e2e", toolId: `Read${i}`, verdict: "ALLOW", reasonCode: "OK", mode: "offline" })).join("\n") + "\n";
      fs.appendFileSync(trailFile, filler);
      await waitFor(() => api.feed().length === 200 && !api.feed().some((r) => r.neverEvent));
      check("never-list deny scrolled out of the 200 rows: status bar stays red", !api.feed().some((r) => r.neverEvent) && api.statusRed(), `${api.feed().length} rows, red=${api.statusRed()}`);
    }
    // (f) the workspace fake kya (first on PATH) never ran.
    check("workspace kya binary never executed", !fs.existsSync(cfg.pwnedMarker));

    if (sc === "trusted") {
      check("MCP server registered through the VS Code MCP API", api.mcp() === "vscode", api.mcp());
      const env = api.childEnv();
      check("kya child PATH excludes the workspace bin dir", typeof env === "object" && !env.PATH.split(path.delimiter).includes(path.join(cfg.ws, "bin")), typeof env === "object" ? env.PATH : env);
      check("hosted off: approvals view says so", /off/.test(api.approvalsNote()), api.approvalsNote());
      check("hosted off: zero fetch calls", fetchCalls.length === 0, fetchCalls.join(" "));

      // (d) connect: declined confirmation writes nothing, accepted runs real `kya connect claude --project`.
      setUi.confirm = async () => false;
      await vscode.commands.executeCommand("shieldKya.connectWorkspace");
      check("connect declined: nothing written", !fs.existsSync(path.join(cfg.ws, ".mcp.json")));
      setUi.confirm = async () => true;
      await vscode.commands.executeCommand("shieldKya.connectWorkspace");
      const mcpJson = fs.existsSync(path.join(cfg.ws, ".mcp.json")) ? fs.readFileSync(path.join(cfg.ws, ".mcp.json"), "utf8") : "";
      check("connect accepted: .mcp.json has shield-kya pointing at the installed kya", mcpJson.includes("shield-kya") && mcpJson.includes(cfg.cli), mcpJson);
      check("connect reported the result", notes.some((n) => /kya connect claude --project: (created|merged|updated|skipped)/.test(n)), notes.join(" | "));

      // (b) hosted approvals against the local stub of KyaApprovalController.
      const conf = vscode.workspace.getConfiguration("shieldKya");
      await conf.update("hosted.baseUrl", cfg.stub, vscode.ConfigurationTarget.Global);
      await conf.update("hosted.enabled", true, vscode.ConfigurationTarget.Global);
      setUi.input = async () => "e2e-human-token";
      await vscode.commands.executeCommand("shieldKya.setApiKey");
      check("hosted on: pending approval listed", await waitFor(() => api.approvals().length === 1), api.approvalsNote());
      setUi.confirm = async () => false;
      await vscode.commands.executeCommand("shieldKya.reject", api.approvals()[0]);
      // MED-1 probes: another extension calls the command with forged objects.
      const modals = [];
      setUi.confirm = async (m) => { modals.push(m); return true; };
      await vscode.commands.executeCommand("shieldKya.approve", { id: "deadbeef-0000-4000-8000-000000000001", status: "PENDING", action: "FORGED harmless lint fix" });
      check("forged unlisted id: no POST, no modal", !(await stubLog()).some((r) => r.url.includes("deadbeef")) && modals.length === 0, JSON.stringify(modals));
      await vscode.commands.executeCommand("shieldKya.approve", { id: api.approvals()[0].id, action: "FORGED harmless lint fix" });
      check("forged label on a listed id: modal shows the server's action, not the caller's", modals.length === 1 && modals[0].includes("deploy.production") && !modals[0].includes("FORGED"), JSON.stringify(modals));
      const log = await stubLog();
      check("list used Bearer auth", log.some((r) => r.method === "GET" && r.auth === "Bearer e2e-human-token"), JSON.stringify(log));
      check("approve POSTed once", log.filter((r) => r.method === "POST" && r.url.endsWith("/approve")).length === 1, JSON.stringify(log));
      check("declined reject never POSTed", !log.some((r) => r.url.endsWith("/reject")), JSON.stringify(log));
      check("approve result shown", notes.some((n) => /APPROVED/.test(n)), notes.join(" | "));
      // Machine key: no decide call, console link instead.
      setUi.input = async () => ["sk", "test", "e2e"].join("_");
      await vscode.commands.executeCommand("shieldKya.setApiKey");
      await waitFor(() => api.approvals().length === 1);
      const before = (await stubLog()).length;
      await vscode.commands.executeCommand("shieldKya.approve", api.approvals()[0]);
      const after = await stubLog();
      check("machine key: no approve POST", !after.slice(before).some((r) => r.method === "POST"), JSON.stringify(after.slice(before)));
      check("machine key: console link opened", opened.some((u) => u.startsWith(`${cfg.stub}/app/kya/approvals/`)), opened.join(" "));
      check("machine key sent as X-API-Key", after.some((r) => r.xApiKey === ["sk", "test", "e2e"].join("_")), "");
      check("all fetches went to the configured plane only", fetchCalls.every((u) => u.startsWith(cfg.stub)), fetchCalls.join(" "));
      const userSettings = fs.readFileSync(path.join(cfg.userData, "User", "settings.json"), "utf8");
      check("key never written to settings.json", !userSettings.includes("e2e-human-token") && !userSettings.includes("sk_test_e2e"), "");
      await vscode.commands.executeCommand("shieldKya.clearApiKey");
      // LOW-1: an unreadable trail pauses the feed with a visible error; the rest keeps working.
      const trail = path.join(cfg.home, ".kya", "trail.jsonl");
      fs.chmodSync(trail, 0o000);
      await vscode.commands.executeCommand("shieldKya.refresh"); // fresh read, same path as activation
      check("unreadable trail shows a visible error in the status bar", await waitFor(() => /trail unreadable \(EACCES\)/.test(api.statusText())), api.statusText());
      fs.chmodSync(trail, 0o600);
      await vscode.commands.executeCommand("shieldKya.refresh");
      const n = api.feed().length;
      kyaHook("Read", { file_path: "/tmp/after" }, `after-${sc}`);
      check("feed recovers once the trail is readable again", await waitFor(() => !/unreadable/.test(api.statusText()) && api.feed().length > 0 && api.feed().length >= n), api.statusText());
      check("clear key: approvals emptied", await waitFor(() => api.approvals().length === 0 && /No hosted key/.test(api.approvalsNote())), api.approvalsNote());
    }

    if (sc === "untrusted") {
      check("untrusted: MCP not registered", api.mcp().startsWith("not registered"), api.mcp());
      await vscode.commands.executeCommand("shieldKya.connectWorkspace");
      check("untrusted: connect refused at runtime", notes.some((n) => /Restricted Mode/.test(n)) && !fs.existsSync(path.join(cfg.ws, ".mcp.json")), notes.join(" | "));
      const conf = vscode.workspace.getConfiguration("shieldKya");
      await conf.update("hosted.baseUrl", cfg.stub, vscode.ConfigurationTarget.Global);
      await conf.update("hosted.enabled", true, vscode.ConfigurationTarget.Global);
      setUi.input = async () => "e2e-human-token";
      await vscode.commands.executeCommand("shieldKya.setApiKey");
      await vscode.commands.executeCommand("shieldKya.refreshApprovals");
      await sleep(1500);
      check("untrusted: hosted stays off even when enabled in user settings", /Restricted Mode/.test(api.approvalsNote()), api.approvalsNote());
      check("untrusted: zero fetch calls", fetchCalls.length === 0, fetchCalls.join(" "));
    }

    if (sc === "nokya") {
      check("missing kya: MCP not registered, reason given", /kya is not installed/.test(api.mcp()), api.mcp());
      await vscode.commands.executeCommand("shieldKya.connectWorkspace");
      check("missing kya: connect reports it and writes nothing", notes.some((n) => /kya is not installed/.test(n)) && !fs.existsSync(path.join(cfg.ws, ".mcp.json")), notes.join(" | "));
      check("missing kya: zero fetch calls", fetchCalls.length === 0, fetchCalls.join(" "));
    }
  } catch (e) {
    check("no exception", false, e && e.stack);
  } finally {
    globalThis.fetch = fetchReal;
    fs.writeFileSync(cfg.resultFile, JSON.stringify(results, null, 2));
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length) throw new Error(`e2e ${cfg.scenario}: ${failed.length} failed: ${failed.map((f) => f.name).join("; ")}`);
};
