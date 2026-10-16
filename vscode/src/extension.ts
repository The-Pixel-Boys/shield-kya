// Shield KYA for VS Code / Cursor / Open VSX editors. Shows the local kya trail; never gates a call.
// OSS kya is advisory and fails open except the never-list; enforcement is the hosted product.
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Approval, countRows, detectGateMode, type FeedRow, findExecutable, type GateMode, HostedClient,
  childEnv, isMachineKey, kyaCliJs, trustedFor, MAX_ROWS, safePath, TrailTailer, userPath, validateBaseUrl,
} from "./core";

const SECRET_KEY = "shieldKya.hosted.apiKey";
const DEFAULT_BASE = "https://shield-agent.com";
const POLL_MS = 1000;

/** Project-scope hosts `kya connect <host> --project` can wire (sdks/kya/src/commands/connect.ts). */
const PROJECT_HOSTS: ReadonlyArray<{ id: string; file: string }> = [
  { id: "cursor", file: ".cursor/mcp.json" },
  { id: "claude", file: ".mcp.json" },
  { id: "opencode", file: "opencode.json" },
  { id: "kilo", file: "kilo.json" },
  { id: "kiro", file: ".kiro/settings/mcp.json" },
  { id: "qwen", file: ".qwen/settings.json" },
  { id: "kimi", file: ".kimi-code/mcp.json" },
  { id: "mastracode", file: ".mastracode/mcp.json" },
];

const ci = process.platform === "darwin" || process.platform === "win32";

/** Every prompt and notice goes through here. The e2e swaps it (see TestApi); production never does. */
const ui = {
  info: (m: string) => void vscode.window.showInformationMessage(m),
  warn: (m: string) => void vscode.window.showWarningMessage(m),
  error: (m: string) => void vscode.window.showErrorMessage(m),
  confirm: async (m: string, button: string) => (await vscode.window.showWarningMessage(m, { modal: true }, button)) === button,
  pick: <T extends vscode.QuickPickItem>(items: T[], placeHolder: string) => vscode.window.showQuickPick(items, { placeHolder }),
  input: (prompt: string) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true }),
  openExternal: (u: vscode.Uri) => vscode.env.openExternal(u),
};

/** User-level value only: workspace and folder settings never steer paths, URLs or network. */
function userSetting<T>(key: string, fallback: T): T {
  const v = vscode.workspace.getConfiguration("shieldKya").inspect<T>(key)?.globalValue;
  return v === undefined || v === null || v === "" ? fallback : v;
}

const kyaHome = () => process.env.KYA_HOME?.trim() || homedir();
const trailPath = () => userSetting("trailPath", join(kyaHome(), ".kya", "trail.jsonl"));
const workspaceRoots = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);

/** Mutating commands, network and process spawns need a trusted, local workspace. */
function trusted(): boolean {
  return trustedFor(vscode.workspace.isTrusted, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.scheme));
}

function refuseUntrusted(what: string): boolean {
  if (trusted()) return false;
  ui.warn(`Shield KYA: ${what} is off in Restricted Mode and virtual workspaces. The feed stays read-only.`);
  return true;
}

interface KyaRuntime { node: string; cliJs: string; dirs: string[] }

/** The installed kya only: user setting or PATH, never npx, never a file inside the workspace. */
function resolveKya(): KyaRuntime | { error: string } {
  const roots = workspaceRoots();
  const win = process.platform === "win32";
  const dirs = safePath(process.env.PATH, roots, ci);
  const opts = { win, ci, pathext: process.env.PATHEXT };
  const node = findExecutable("node", dirs, roots, opts);
  if (!node) return { error: "node was not found on PATH (outside the workspace)" };
  const configured = userSetting("cliPath", "");
  let cliJs: string | undefined;
  if (configured) {
    const real = userPath(configured, roots, ci);
    cliJs = real ? kyaCliJs(real) : undefined;
    if (!cliJs) return { error: `shieldKya.cliPath (${configured}) is not a kya install outside the workspace` };
  } else {
    const bin = findExecutable("kya", dirs, roots, opts);
    cliJs = bin ? kyaCliJs(bin) : undefined;
    if (!cliJs) return { error: "kya is not installed (npm i -g @shield-agent/kya), or set shieldKya.cliPath" };
  }
  return { node, cliJs, dirs };
}

function runKya(rt: KyaRuntime, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(rt.node, [rt.cliJs, ...args], {
      cwd, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      env: childEnv(rt.dirs),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ---------- views ----------

const VERDICT_LABEL: Record<FeedRow["verdict"], string> = { ALLOW: "ALLOW", REVIEW: "REVIEW", HOLD: "HOLD", DENY: "DENY", OTHER: "?" };

class FeedProvider implements vscode.TreeDataProvider<FeedRow> {
  rows: FeedRow[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  fire() { this.changed.fire(); }
  getChildren(el?: FeedRow) { return el ? [] : [...this.rows].reverse(); }
  getTreeItem(r: FeedRow): vscode.TreeItem {
    const tag = r.neverEvent ? "DENY never-list" : VERDICT_LABEL[r.verdict];
    // Plain strings only: trail text never becomes markdown or a command link.
    const item = new vscode.TreeItem(`${tag}  ${r.toolId}`);
    item.description = [r.summary ?? r.targetPath, r.product, r.ts.slice(11, 19)].filter(Boolean).join("  ");
    const review = r.verdict === "REVIEW"
      ? "REVIEW = kya recorded REQUIRE_APPROVE with no Hold path armed. Advisory hooks let the call run; a local --strict hook denied it (its rows look the same)."
      : r.verdict === "HOLD"
        ? "HOLD = kya recorded REQUIRE_APPROVE with a Hold/strict path armed (hosted strict hook or kya wrap --hold): the call was held or denied pending a human, not run on an advisory pass."
        : undefined;
    item.tooltip = [
      `${r.rawVerdict} ${r.reasonCode}`, `tool: ${r.toolId}`, `time: ${r.ts}`, `mode: ${r.mode}`,
      r.product && `host: ${r.product}`, r.project && `project: ${r.project}`,
      r.neverEvent && "never-list: blocked in every mode",
      r.shadow && "shadow: hosted verdict recorded, not enforced",
      r.importedFrom && `imported from ${r.importedFrom}`,
      r.targetPath && `path: ${r.targetPath}`, r.summary && `change: ${r.summary}`,
      r.diffPreview && `preview (redacted):\n${r.diffPreview}`, review,
    ].filter(Boolean).join("\n");
    const color = r.neverEvent || r.verdict === "DENY" ? "errorForeground"
      : r.verdict === "REVIEW" || r.verdict === "HOLD" ? "editorWarning.foreground" : "testing.iconPassed";
    const icon = r.neverEvent ? "error" : r.verdict === "DENY" ? "circle-slash" : r.verdict === "HOLD" ? "debug-pause"
      : r.verdict === "REVIEW" ? "eye" : "pass";
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    return item;
  }
}

class ApprovalsProvider implements vscode.TreeDataProvider<Approval> {
  items: Approval[] = [];
  note = "";
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  fire() { this.changed.fire(); }
  getChildren(el?: Approval) { return el ? [] : this.items; }
  getTreeItem(a: Approval): vscode.TreeItem {
    const item = new vscode.TreeItem(`${a.action ?? "approval"}  ${a.status}`);
    item.description = [a.priority, a.createdAt].filter(Boolean).join("  ");
    item.tooltip = `approval ${a.id}`;
    item.contextValue = "approval";
    item.id = a.id;
    return item;
  }
}

// ---------- activation ----------

export interface TestApi {
  statusText(): string;
  /** Whether the status bar is in its red (error background) state. */
  statusRed(): boolean;
  statusTooltip(): string;
  feed(): readonly FeedRow[];
  approvals(): readonly Approval[];
  approvalsNote(): string;
  gateMode(): GateMode;
  mcp(): string;
  poll(): void;
  /** The TreeItem the Verdicts view renders for row i (tooltip must stay a plain string). */
  feedItem(i: number): vscode.TreeItem;
  trusted(): boolean;
  /** Env the kya child process gets. */
  childEnv(): NodeJS.ProcessEnv | string;
  /** Replace prompts/notices for the e2e (records them instead of showing modals). */
  setUi(over: Partial<typeof ui>): void;
}

export function activate(ctx: vscode.ExtensionContext): TestApi | undefined {
  const feed = new FeedProvider();
  const approvals = new ApprovalsProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "shieldKya.feed.focus";
  status.show();
  let tailer = new TrailTailer(trailPath());
  let gate = detectGateMode(kyaHome());
  let mcpState = "not registered";
  let trailError = "";
  // Never-list denies across everything read from the trail tail (not only the 200 rows shown),
  // so the red status bar does not clear just because newer rows arrived.
  let neverSeen = 0;

  const render = () => {
    const c = countRows(feed.rows, 0);
    const hosted = userSetting("hosted.enabled", false);
    const recent = feed.rows.some((r) => Date.now() - Date.parse(r.ts) < 24 * 3600_000);
    const mode = gate.mode === "none" ? (recent ? "unknown" : "no hook") : gate.mode;
    status.text = trailError
      ? `$(warning) KYA ${mode}  trail unreadable (${trailError})`
      : `$(shield) KYA ${mode}${hosted ? " +hosted" : ""}  ${c.allow} allow ${c.review} review ${c.hold ? `${c.hold} hold ` : ""}${c.deny} deny`;
    status.tooltip = [
      `Gate mode: ${mode} (from ${gate.hooks} user-level kya hook(s) or Claude Code plugin(s); Codex/Gemini plugins and project-level wiring are not inspected${mode === "unknown" ? ", but the trail has recent rows" : ""}).`,
      "Advisory: kya records every call and blocks only the never-list; it fails open. Strict/hosted hooks deny REQUIRE_APPROVE.",
      `Counts: the last ${MAX_ROWS} rows of ${tailer.path} (the Verdicts view shows the same rows).`,
      trailError ? `The trail could not be read: ${trailError}. The feed is paused; everything else still works.` : "",
      neverSeen ? `${neverSeen} never-list deny(s) since the trail was last loaded (activation, Refresh, or a truncated/rotated file).` : "",
      hosted ? "Hosted approvals on (network to the configured plane)." : "Hosted off: no network.",
    ].filter(Boolean).join("\n");
    status.backgroundColor = neverSeen || trailError ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  };

  const poll = () => {
    if (tailer.path !== trailPath()) tailer = new TrailTailer(trailPath());
    const { rows, reset, error } = tailer.poll();
    if ((error ?? "") !== trailError) {
      trailError = error ?? "";
      feedView.message = trailError ? `Cannot read the kya trail (${trailError}): ${tailer.path}` : undefined;
      render();
    }
    if (!rows.length && !reset) return;
    if (reset) neverSeen = 0;
    neverSeen += rows.filter((r) => r.neverEvent).length;
    feed.rows = (reset ? rows : feed.rows.concat(rows)).slice(-MAX_ROWS);
    feed.fire();
    render();
  };

  const secrets = ctx.secrets;
  const hostedClient = async (): Promise<HostedClient | string> => {
    if (!userSetting("hosted.enabled", false)) return "Hosted approvals are off (shieldKya.hosted.enabled). No network is used.";
    if (!trusted()) return "Hosted approvals are off in Restricted Mode.";
    const key = await secrets.get(SECRET_KEY);
    if (!key) return "No hosted key. Run 'Shield KYA: Set hosted API key'.";
    let base: string;
    try { base = validateBaseUrl(userSetting("hosted.baseUrl", DEFAULT_BASE)); } catch (e) { return (e as Error).message; }
    return new HostedClient(base, key, globalThis.fetch as never);
  };

  const refreshApprovals = async () => {
    const client = await hostedClient();
    if (typeof client === "string") {
      approvals.items = [];
      approvals.note = client;
    } else {
      try {
        approvals.items = await client.list();
        approvals.note = approvals.items.length ? "" : "No pending approvals.";
      } catch (e) {
        approvals.items = [];
        approvals.note = (e as Error).message;
      }
    }
    approvalsView.message = approvals.note || undefined;
    approvals.fire();
  };

  const decide = async (arg: unknown, decision: "approve" | "reject") => {
    if (refuseUntrusted(`${decision}`)) return;
    // The command argument only selects WHICH listed approval; id and label shown and sent always come
    // from the list the server returned. Another extension calling the command with a forged object
    // cannot get an unlisted id decided or a made-up label into the confirmation.
    const wanted = arg && typeof arg === "object" ? (arg as { id?: unknown }).id : undefined;
    const a = approvals.items.find((x) => x.id === wanted);
    if (!a) return ui.warn("Shield KYA: that approval is not in the current hosted list. Refresh the Hosted approvals view and pick it there.");
    const client = await hostedClient();
    if (typeof client === "string") return ui.warn(`Shield KYA: ${client}`);
    const key = (await secrets.get(SECRET_KEY)) ?? "";
    const base = validateBaseUrl(userSetting("hosted.baseUrl", DEFAULT_BASE));
    if (isMachineKey(key)) {
      // kya decide refuses machine keys: a human with kya.approve decides in the console.
      const open = await ui.confirm(
        "Shield KYA: machine keys (sk_*) cannot approve or reject. Open this approval in the hosted console?", "Open console");
      if (open) await ui.openExternal(vscode.Uri.parse(`${base}/app/kya/approvals/${encodeURIComponent(a.id)}`));
      return;
    }
    const ok = await ui.confirm(
      `Shield KYA: ${decision.toUpperCase()} "${a.action ?? a.id}" on the hosted plane?`, decision === "approve" ? "Approve" : "Reject");
    if (!ok) return;
    try {
      const r = await client.decide(a.id, decision);
      ui.info(`Shield KYA: ${r.status} ${r.id}`);
    } catch (e) {
      ui.error(`Shield KYA: ${(e as Error).message}`);
    }
    await refreshApprovals();
  };

  const connectWorkspace = async () => {
    if (refuseUntrusted("Connect this workspace")) return;
    const folder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: "Folder to wire" })
      : vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") return ui.warn("Shield KYA: open a local folder first.");
    const rt = resolveKya();
    if ("error" in rt) return ui.error(`Shield KYA: ${rt.error}`);
    const inCursor = /cursor/i.test(vscode.env.appName);
    const picks = PROJECT_HOSTS.map((h) => ({ label: h.id, description: h.file, picked: h.id === (inCursor ? "cursor" : "claude") }));
    picks.sort((a, b) => Number(b.picked) - Number(a.picked));
    const host = await ui.pick(picks, "Agent host to wire for this project (kya connect <host> --project)");
    if (!host) return;
    const ok = await ui.confirm(
      `Run "kya connect ${host.label} --project" in ${folder.name}? It merges a shield-kya MCP server entry into ${host.description} (existing entries are kept). kya is advisory: it records tool calls and blocks only the never-list.`,
      "Connect");
    if (!ok) return;
    const r = await runKya(rt, ["connect", host.label, "--project", "--json"], folder.uri.fsPath);
    if (r.code !== 0) return ui.error(`Shield KYA: kya connect failed (exit ${r.code}). ${r.stderr.slice(0, 300)}`);
    let summary = "done";
    try {
      const j = JSON.parse(r.stdout) as { path?: unknown; status?: unknown };
      if (typeof j.status === "string" && typeof j.path === "string") summary = `${j.status} ${j.path}`;
    } catch { /* not JSON: keep "done" */ }
    ui.info(`Shield KYA: kya connect ${host.label} --project: ${summary}`);
  };

  // MCP: one registration path only (Cursor's API when present, else the VS Code provider API).
  const mcpChanged = new vscode.EventEmitter<void>();
  let mcpRegistered = false;
  const registerMcp = () => {
    if (mcpRegistered || !trusted() || !userSetting("mcp.enabled", true)) return;
    const rt = resolveKya();
    if ("error" in rt) { mcpState = `not registered: ${rt.error}`; return; }
    const env = { KYA_HOST: "ide", KYA_OFFLINE: "1", KYA_SESSION_ID: "mcp:vscode" };
    const args = [rt.cliJs, "serve-mcp", "--stdio"];
    const cursorMcp = (vscode as unknown as { cursor?: { mcp?: { registerServer?: (c: unknown) => void; unregisterServer?: (n: string) => void } } }).cursor?.mcp;
    if (typeof cursorMcp?.registerServer === "function") {
      cursorMcp.registerServer({ name: "shield-kya", server: { command: rt.node, args, env } });
      ctx.subscriptions.push({ dispose: () => cursorMcp.unregisterServer?.("shield-kya") });
      mcpState = "cursor";
    } else if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function") {
      ctx.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("shieldKya.mcp", {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: () => [new vscode.McpStdioServerDefinition("Shield KYA", rt.node, args, env)],
        // Re-check at start time: trust can be revoked only by reload, but kya can be uninstalled.
        resolveMcpServerDefinition: (def) => (trusted() && !("error" in resolveKya()) ? def : undefined),
      }));
      mcpState = "vscode";
    } else {
      mcpState = "not registered: this editor has no MCP extension API";
      return;
    }
    mcpRegistered = true;
  };

  const feedView = vscode.window.createTreeView("shieldKya.feed", { treeDataProvider: feed });
  const approvalsView = vscode.window.createTreeView("shieldKya.approvals", { treeDataProvider: approvals });
  const timer = setInterval(poll, POLL_MS);
  ctx.subscriptions.push(status, feedView, approvalsView, mcpChanged, { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("shieldKya.refresh", () => {
      tailer = new TrailTailer(trailPath());
      gate = detectGateMode(kyaHome());
      poll();
      render();
    }),
    vscode.commands.registerCommand("shieldKya.connectWorkspace", connectWorkspace),
    vscode.commands.registerCommand("shieldKya.refreshApprovals", () => (refuseUntrusted("Hosted approvals") ? undefined : refreshApprovals())),
    vscode.commands.registerCommand("shieldKya.approve", (a?: unknown) => decide(a, "approve")),
    vscode.commands.registerCommand("shieldKya.reject", (a?: unknown) => decide(a, "reject")),
    vscode.commands.registerCommand("shieldKya.setApiKey", async () => {
      if (refuseUntrusted("Setting the hosted key")) return;
      const key = await ui.input("Shield KYA hosted API key (stored in the OS keychain via VS Code SecretStorage, never in settings.json)");
      if (key?.trim()) { await secrets.store(SECRET_KEY, key.trim()); await refreshApprovals(); }
    }),
    vscode.commands.registerCommand("shieldKya.clearApiKey", async () => { await secrets.delete(SECRET_KEY); await refreshApprovals(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { registerMcp(); void refreshApprovals(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shieldKya")) { poll(); render(); void refreshApprovals(); }
    }),
  );
  poll();
  render();
  registerMcp();
  void refreshApprovals();

  // The test API (including the prompt seam) exists only in ExtensionMode.Test: VS Code sets that
  // solely when this extension is loaded via --extensionDevelopmentPath together with
  // --extensionTestsPath. Settings, env (devcontainer remoteEnv) or workspace files cannot set it, so
  // an installed extension never exposes the seam to other extensions in the same host.
  if (ctx.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    setUi: (over) => Object.assign(ui, over),
    statusText: () => status.text,
    statusRed: () => status.backgroundColor !== undefined,
    statusTooltip: () => String(status.tooltip ?? ""),
    feed: () => feed.rows,
    approvals: () => approvals.items,
    approvalsNote: () => approvals.note,
    gateMode: () => gate.mode,
    mcp: () => mcpState,
    poll,
    feedItem: (i) => feed.getTreeItem(feed.rows[i]!),
    trusted,
    childEnv: () => { const rt = resolveKya(); return "error" in rt ? rt.error : childEnv(rt.dirs); },
  };
}

export function deactivate(): void {}
