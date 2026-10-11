// SessionStart: install the pinned kya into ${CLAUDE_PLUGIN_DATA} once, so the PreToolUse
// hook can run `node <data>/node_modules/@shield-agent/kya/dist/cli.js` with no npx and no
// npm/registry traffic at hook time. Node builtins only. Idempotent. Never edits user settings,
// never approves anything. Always exits 0; a problem becomes a loud `systemMessage`.
// usage: bootstrap.mjs @shield-agent/kya@X.Y.Z   (the pin comes only from hooks.json)
//
// Install: exact version only, fixed public registry, empty user/global npmrc (fresh 0600 files),
// every npm_config_* and NODE_OPTIONS stripped from the npm child, --ignore-scripts
// --omit=optional. It installs into a staging prefix inside DATA, verifies it (version, cli.js,
// `--help` load check) and only then swaps node_modules into place. The swap is a pair of renames:
// a hook that starts in that instant fails open once (follow-up: versioned dirs plus a symlink).
// A failed upgrade leaves the working copy untouched.
// Known limits (follow-ups): no sha512 integrity pin and no shrinkwrap yet, so transitive ranges
// resolve fresh; HTTPS_PROXY and NODE_EXTRA_CA_CERTS are honored (corporate hosts need them) and
// corporate registry mirrors are not.
// Time budget (hooks.json timeout is 120 s): check 10 + re-check 10 + old-copy check 10 + npm 70 + staged check 10.
import { spawn } from "node:child_process";
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";

const SEMVER = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?";
const spec = process.argv[2] ?? "";
const pin = new RegExp(`^@shield-agent/kya@(${SEMVER})$`).exec(spec)?.[1];
const data = process.env.CLAUDE_PLUGIN_DATA;
const STALE_LOCK_MS = 150_000;
const notes = []; // problems: kya cannot do its job
const warns = []; // kya works, but the user should know

const win = process.platform === "win32";
const q = (s) => (win ? `"${s}"` : s);
const lock = data && join(data, ".bootstrap.lock");
let lockHeld = false;
let child;
const scratch = new Set(); // staging and rc dirs to remove on exit or signal
const undeletable = [];

// Best effort and never throws: each removal is its own try, the lock is always released.
function cleanup() {
  for (const d of scratch) {
    try { rmSync(d, { recursive: true, force: true }); } catch { undeletable.push(d); }
  }
  scratch.clear();
  if (lockHeld) try { unlinkSync(lock); } catch { /* already gone */ }
  lockHeld = false;
}
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
  process.on(sig, () => {
    child?.kill("SIGKILL");
    cleanup();
    process.exit(code);
  });
}

function done() {
  cleanup();
  if (undeletable.length) warns.push(`could not delete ${undeletable.join(", ")}; remove it by hand.`);
  const parts = [];
  if (notes.length) parts.push(`Shield KYA is NOT recording: ${notes.join(" ")}`);
  if (warns.length) parts.push(`Shield KYA: ${warns.join(" ")}`);
  if (parts.length) process.stdout.write(`${JSON.stringify({ systemMessage: parts.join(" | ") })}\n`);
  process.exit(0);
}

/** Async spawn with a hard timeout (a sync spawn would block the signal handlers above). */
function run(cmd, args, opts, ms) {
  return new Promise((resolve) => {
    let stderr = "";
    let timer;
    child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], ...opts });
    child.stderr.on("data", (d) => { if (stderr.length < 20_000) stderr += d; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ error, status: null, stderr }); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    timer = setTimeout(() => child.kill("SIGKILL"), ms);
  });
}

// Complete = package.json at the pin, dist/cli.js present, and the entry loads (`--help` rc 0).
// A partial install (interrupted extraction) fails one of the three.
async function loadsAt(root, wantVersion) {
  try {
    const dir = join(root, "node_modules/@shield-agent/kya");
    if (wantVersion && JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version !== wantVersion) return false;
    const cli = join(dir, "dist/cli.js");
    if (!existsSync(cli)) return false;
    const r = await run(process.execPath, [cli, "--help"], { env: { ...process.env, KYA_SKIP_NODE_CHECK: "1" } }, 10_000);
    return r.status === 0;
  } catch {
    return false;
  }
}
const completeAt = (root) => loadsAt(root, pin);

/** Take the install lock. A stale lock is renamed aside (atomic, one cleaner wins) and retried. */
function acquire() {
  for (let i = 0; i < 3; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      lockHeld = true;
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
      const aside = `${lock}.stale-${process.pid}`;
      renameSync(lock, aside);
      // ponytail: another cleaner may have swapped in a fresh lock between stat and rename;
      // put it back if what we moved aside is not stale. Residual window is microseconds.
      if (Date.now() - statSync(aside).mtimeMs <= STALE_LOCK_MS) {
        try { renameSync(aside, lock); } catch { unlinkSync(aside); }
        return false;
      }
      unlinkSync(aside);
    } catch { /* the lock vanished or was cleaned by someone else: retry */ }
  }
  return false;
}

/** An empty file that is created fresh (O_EXCL, no symlink following, 0600) in a private dir. */
function emptyRc(dir, name) {
  const p = join(dir, name);
  closeSync(openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
  return p;
}

async function install() {
  mkdirSync(data, { recursive: true });
  if (!acquire()) {
    notes.push("another session is installing kya right now; recording starts once it finishes (restart the session if this persists).");
    return;
  }
  if (await completeAt(data)) return; // another session finished while we waited for the lock
  const oldWorks = await loadsAt(data); // some earlier version still runs: say "keeping it", not "NOT recording"
  const fail = (msg) => (oldWorks ? warns.push(`update to ${spec} failed: ${msg} Keeping the previous version.`) : notes.push(msg));
  for (const f of readdirSync(data)) {
    if (/^\.(install|old|rc)-/.test(f)) try { rmSync(join(data, f), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { rmSync(join(data, ".npmrc"), { force: true }); } catch { /* best effort */ } // a planted project npmrc must not beat --registry
  const stage = join(data, `.install-${process.pid}`);
  const rc = mkdtempSync(join(data, ".rc-"));
  scratch.add(stage).add(rc);
  mkdirSync(stage);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k) && k !== "NODE_OPTIONS"));
  const r = await run(
    win ? "npm.cmd" : "npm",
    [
      "install", "--prefix", q(stage), "--registry=https://registry.npmjs.org/",
      `--userconfig=${q(emptyRc(rc, "user-npmrc"))}`, `--globalconfig=${q(emptyRc(rc, "global-npmrc"))}`,
      "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", spec,
    ],
    { shell: win, cwd: stage, env },
    70_000,
  );
  if (r.error?.code === "ENOENT") return void fail("npm was not found on PATH, so kya was not installed. Install Node.js 24+ (it ships npm).");
  if (r.error || r.status !== 0) {
    const lines = (r.stderr || String(r.error?.message ?? "")).trim().split("\n");
    const why = lines.find((l) => /^npm error (code|404|network)/.test(l))?.replace(/^npm error /, "") ?? lines[0];
    return void fail(`npm install failed (${why || (r.status === null ? "timed out" : `exit ${r.status}`)}).`);
  }
  if (!(await completeAt(stage))) return void fail("the new copy installed incompletely (version, dist/cli.js or load check failed).");
  // Swap: old node_modules aside, staged one in, old deleted last. Any failure restores the old tree.
  const live = join(data, "node_modules");
  const aside = join(data, `.old-${process.pid}`);
  scratch.add(aside);
  const had = (() => { try { return !!lstatSync(live); } catch { return false; } })();
  try {
    if (had) renameSync(live, aside);
    renameSync(join(stage, "node_modules"), live);
  } catch (e) {
    if (had) try { renameSync(aside, live); } catch { /* nothing more to do */ }
    return void fail(`could not move the new kya into place (${e?.message}).`);
  }
}

if (!pin) notes.push(`bad kya pin "${spec}" in hooks.json (an exact semver version is required).`);
else if (!data) notes.push("CLAUDE_PLUGIN_DATA is not set, cannot install kya.");
else if (!(await completeAt(data))) {
  try {
    await install();
  } catch (e) {
    notes.push(`kya install crashed (${e?.message}).`);
  }
}

if (Number.parseInt(process.versions.node, 10) < 24) {
  warns.push(`Node ${process.versions.node} is below 24; kya targets Node 24+ and is only lightly tested on this version.`);
}
done();
