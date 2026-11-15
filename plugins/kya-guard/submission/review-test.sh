#!/usr/bin/env bash
# Two-minute reviewer test for KYA Guard. Needs bash and Node.js 22 or later. Takes about one second.
#
# It runs the shipped bundle (dist/guard.mjs) on 3 inputs that must be denied and 3 that must be allowed, and
# checks the exit codes (2 = denied, 0 = allowed). It also checks the ask rule and the status command.
# It uses a temporary HOME. It never touches your real ~/.kya or ~/.claude, makes no network call, and deletes
# the temporary folder when it ends.
#
#   bash review-test.sh                  test the bundle next to this folder
#   GUARD_BUNDLE=/path/guard.mjs bash review-test.sh   test another bundle (the repository tests use this)
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle="${GUARD_BUNDLE:-$here/../dist/guard.mjs}"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH (KYA Guard needs Node.js 22 or later)"; exit 1; }
[ -f "$bundle" ] || { echo "FAIL: no bundle at $bundle"; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/kya-guard-review.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)" # a clean path: TMPDIR may end in a slash, and the rm -rf ~ rule does not match a HOME that has "//" in it
mkdir -p "$tmp/home" "$tmp/project/.git"
export HOME="$tmp/home" KYA_HOME="$tmp/home" USERPROFILE="$tmp/home"
unset KYA_API_KEY KYA_BASE_URL CLAUDE_CONFIG_DIR
cd "$tmp/project" || exit 1

fails=0
# call <host> <command>: print the guard's exit code on stdout, its stdout in $tmp/out
call() {
  printf '{"hook_event_name":"PreToolUse","session_id":"review","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$tmp/project" "$2" |
    node "$bundle" --host "$1" >"$tmp/out" 2>"$tmp/err"
  echo $?
}
expect() { # <label> <want exit> <got exit>
  if [ "$2" = "$3" ]; then echo "ok   $1 (exit $3)"; else echo "FAIL $1: wanted exit $2, got $3"; fails=$((fails + 1)); fi
}

echo "3 inputs that must be denied"
expect "terraform destroy"       2 "$(call claude 'terraform destroy -auto-approve')"
expect "rm -rf on the home dir"  2 "$(call claude 'rm -rf ~')"
expect "force push to main"      2 "$(call claude 'git push --force origin main')"
echo "3 inputs that must be allowed"
expect "ls"                      0 "$(call claude 'ls -la')"
expect "git status"              0 "$(call claude 'git status')"
expect "npm test"                0 "$(call claude 'npm test')"

echo "The ask rule: Claude Code is asked (exit 0), a host with no ask gets a deny (exit 2)"
expect "prisma migrate reset on claude" 0 "$(call claude 'prisma migrate reset')"
grep -q '"permissionDecision":"ask"' "$tmp/out" || { echo "FAIL claude ask: no ask decision in the output"; fails=$((fails + 1)); }
expect "prisma migrate reset on cursor" 2 "$(call cursor 'prisma migrate reset')"

echo "A payload that is not JSON must not block (the guard fails open)"
printf 'not json' | node "$bundle" --host claude >/dev/null 2>&1
expect "bad payload" 0 "$?"

echo "The trail and the status command"
rows=$(grep -c . "$HOME/.kya/trail.jsonl" 2>/dev/null || echo 0)
[ "$rows" -ge 8 ] && echo "ok   trail has $rows rows in the temporary HOME" || { echo "FAIL trail has $rows rows, wanted 8 or more"; fails=$((fails + 1)); }
node "$bundle" --status >"$tmp/status" 2>&1
grep -q "Calls blocked in 7 days: 4" "$tmp/status" && echo "ok   status reports 4 blocked (3 denies and the ask on cursor)" || { echo "FAIL status: $(grep 'blocked' "$tmp/status")"; fails=$((fails + 1)); }

[ -e "$tmp/project/.claude" ] && { echo "FAIL the guard wrote a Claude settings file"; fails=$((fails + 1)); }

if [ "$fails" -eq 0 ]; then echo "PASS: KYA Guard behaved as documented"; else echo "$fails check(s) failed"; exit 1; fi
