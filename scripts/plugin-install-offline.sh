#!/usr/bin/env bash
# Spec G1, two clauses:
#   "In a clean Claude Code profile with networking disabled: /plugin install kya-guard@shield-kya completes".
#   "/plugin uninstall leaves no file outside ~/.kya/trail.jsonl".
# Run by .woodpecker/kya-plugin-install.yml (weekly cron).
#
# 1. Fetch the pinned Claude Code CLI into a temp prefix. Only this step has the network.
# 2. Turn the network off with an OS sandbox. A canary proves it: a fetch must fail with a network error inside the
#    sandbox, and a plain node command must work inside it.
# 3. In a new profile (temp HOME and TMPDIR), add this checkout as the shield-kya marketplace. Then install, uninstall
#    and remove it with the real `claude plugin` commands.
# 4. Fail when a command fails or when the install did not register the plugin.
#    Also fail when uninstall leaves a file in HOME outside the Claude Code profile, other than ~/.kya/trail.jsonl.
#
#   plugin-install-offline.sh [MARKETPLACE_DIR]    default: the sdks/kya folder of this checkout
set -euo pipefail
CLAUDE_CODE="@anthropic-ai/claude-code@2.1.318"
here="$(cd "$(dirname "$0")/.." && pwd)"
market="${1:-$here}"
work="$(mktemp -d)"
trap 'if [ -n "${KEEP_WORK:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi' EXIT
prefix="$work/prefix" home="$work/home" tmp="$work/tmp"
mkdir -p "$prefix" "$home" "$tmp"
say() { echo "plugin-install-offline: $*"; }
fail() { echo "plugin-install-offline: FAIL: $*" >&2; exit 1; }

say "fetch $CLAUDE_CODE (network on)"
npm install --silent --no-audit --no-fund --ignore-scripts --prefix "$prefix" "$CLAUDE_CODE" >/dev/null
# --ignore-scripts keeps every package script off. The CLI needs its own postinstall to place its native binary.
(cd "$prefix" && node node_modules/@anthropic-ai/claude-code/install.cjs >/dev/null)
claude="$prefix/node_modules/.bin/claude"

# The OS sandbox gives a network namespace with only loopback, or denies outbound IP:
#   Linux, first choice: `unshare -rn`.
#   Linux, when the host blocks unprivileged user namespaces (pipeline 6330): `podman unshare unshare -n`.
#     The host policy allows rootless Podman to make a user namespace. Inside it, `unshare -n` makes the network namespace.
#   macOS: `sandbox-exec`. It denies outbound IP and file writes under /Users, /private and /tmp, except in the work folder.
# With none of them, the check fails and prints why each one could not start.
sandbox=() why=""
probe() { # probe NAME CMD...: true when CMD runs; else adds "NAME: reason" (one line, 160 chars) to $why
  local name="$1" e; shift
  if ! command -v "$1" >/dev/null; then why="${why:+$why; }$name: $1 not found"; return 1; fi
  if e="$("$@" 2>&1)"; then return 0; fi
  e="${e//$'\n'/ }"; e="${e:-failed, no output}"; why="${why:+$why; }$name: ${e:0:160}"; return 1
}
if probe "unshare -rn" unshare -rn true; then
  sandbox=(unshare -rn); say "network off by unshare -rn"
elif probe "podman unshare" podman unshare unshare -n true; then
  sandbox=(podman unshare unshare -n); say "network off by podman unshare unshare -n"
elif probe "sandbox-exec" sandbox-exec -p '(version 1)(allow default)' true; then
  real="$(cd "$work" && pwd -P)"
  sandbox=(sandbox-exec -p "(version 1)(allow default)(deny network-outbound (remote ip))(deny file-write* (subpath \"/Users\") (subpath \"/private\") (subpath \"/tmp\"))(allow file-write* (subpath \"$real\") (literal \"/dev/null\"))")
  say "network off by sandbox-exec (writes only inside the work folder)"
else
  fail "cannot turn the network off on this host ($why)"
fi
offline() { "${sandbox[@]}" env -i PATH="$PATH" HOME="$home" TMPDIR="$tmp" CLAUDE_CONFIG_DIR="$home/.claude" DISABLE_AUTOUPDATER=1 "$@"; }

# The canary. Positive control first: node runs inside the sandbox, and the same fetch works outside it.
probe='fetch("https://registry.npmjs.org/",{signal:AbortSignal.timeout(10000)}).then(()=>process.exit(0),(e)=>{const c=String(e.cause?.code||e.name);console.log(c);process.exit(/EPERM|EACCES|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|TimeoutError/.test(c)?3:4)})'
offline node -e 'process.exit(0)' || fail "node does not run inside the sandbox, so the canary would prove nothing"
env -i PATH="$PATH" HOME="$home" TMPDIR="$tmp" node -e "$probe" >/dev/null || fail "the canary fetch fails outside the sandbox too, so its failure inside would prove nothing"
set +e; code="$(offline node -e "$probe")"; rc=$?; set -e
[ "$rc" -eq 0 ] && fail "the canary fetch worked, so the network was not off"
[ "$rc" -eq 3 ] || fail "the canary fetch failed for a reason that is not a network error (exit $rc, $code)"
say "canary fetch failed with a network error as it must ($code)"
offline "$claude" --version

offline "$claude" plugin marketplace add "$market"
offline "$claude" plugin install kya-guard@shield-kya
installed="$home/.claude/plugins/installed_plugins.json"
[ -f "$installed" ] && grep -q '"kya-guard@shield-kya"' "$installed" || fail "kya-guard@shield-kya is not in installed_plugins.json after install"
find "$home/.claude/plugins/cache" -path '*/kya-guard/*' -print -quit | grep -q . || fail "no kya-guard files in the plugin cache after install"
say "install completed with the network off"

offline "$claude" plugin uninstall kya-guard@shield-kya
offline "$claude" plugin marketplace remove shield-kya
# Left in HOME: everything outside the Claude Code profile must be ~/.kya/trail.jsonl or nothing (links included).
left="$(cd "$home" && find . ! -type d ! -path './.claude/*' ! -path './.kya/trail.jsonl' | sort)"
[ -z "$left" ] || fail "files left after uninstall: $(echo "$left" | tr '\n' ' ')"
# Inside the profile, kya-guard must not stay registered. Claude Code keeps its own download cache of an uninstalled
# plugin. It marks that cache .orphaned_at and deletes it later. Any other kya-guard file in the profile fails.
[ -f "$installed" ] || fail "installed_plugins.json is gone, so the uninstall check would prove nothing"
grep -q 'kya-guard' "$installed" && fail "kya-guard is still in installed_plugins.json after uninstall"
dirs=""
if [ -d "$home/.claude/plugins/cache" ]; then dirs="$(find "$home/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d -path '*/kya-guard/*')"; fi
while IFS= read -r d; do
  [ -z "$d" ] || [ -f "$d/.orphaned_at" ] || fail "$d stays after uninstall with no .orphaned_at marker"
done <<<"$dirs"
if find "$home/.claude" -name '*kya-guard*' ! -path "$home/.claude/plugins/cache/*" -print -quit | grep -q .; then
  fail "kya-guard files stay in the profile outside the Claude Code cache"
fi
say "uninstall left no file outside ~/.kya/trail.jsonl"
