#!/usr/bin/env bash
# Offline self-test for the omniroute-provider skill scripts.
#
# Runs enable.sh / status.sh / disable.sh against a throwaway settings file
# and asserts the resulting env keys, without touching any real config and
# without network access.
#
# Usage:
#   bash scripts/selftest.sh              # offline checks only
#   bash scripts/selftest.sh --online [base-url]
#                                         # additionally probe the gateway
#                                         # (default: OMNIROUTE_BASE_URL env,
#                                         #  else skip)
#
# Exit code 0 = all assertions passed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

assert_eq() { # assert_eq <name> <expected> <actual>
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "FAIL: $1"
        echo "  expected: $2"
        echo "  actual:   $3"
    fi
}

env_key() { # env_key <settings-file> <key> -> prints value or "(absent)"
    python3 - "$1" "$2" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("env", {}).get(sys.argv[2], "(absent)"))
PYEOF
}

# ---------------------------------------------------------------------------
# 1. enable.sh: full pin (base URL + token + model + context tokens)
# ---------------------------------------------------------------------------
settings="$tmpdir/one.json"
echo '{"env": {"PRESERVE_ME": "yes"}}' > "$settings"

OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
OMNIROUTE_AUTH_TOKEN="sk-test" \
OMNIROUTE_MODEL="auto/coding" \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1

assert_eq "pin: PRESERVE_ME untouched"       "yes"                          "$(env_key "$settings" PRESERVE_ME)"
assert_eq "pin: ANTHROPIC_BASE_URL"          "http://example.test:20128/v1" "$(env_key "$settings" ANTHROPIC_BASE_URL)"
assert_eq "pin: ANTHROPIC_AUTH_TOKEN"        "sk-test"                      "$(env_key "$settings" ANTHROPIC_AUTH_TOKEN)"
assert_eq "pin: ANTHROPIC_MODEL"             "auto/coding"                  "$(env_key "$settings" ANTHROPIC_MODEL)"
assert_eq "pin: MAX_CONTEXT_TOKENS default"  "1048576"                      "$(env_key "$settings" CLAUDE_CODE_MAX_CONTEXT_TOKENS)"

# Existing settings file must have been backed up (timestamped .bak sibling)
assert_eq "pin: backup file created"         "1"                            "$(ls "$settings".bak.* 2>/dev/null | wc -l)"

# ---------------------------------------------------------------------------
# 2. enable.sh: OMNIROUTE_CONTEXT_TOKENS override + explicit empty
# ---------------------------------------------------------------------------
settings="$tmpdir/two.json"
echo '{}' > "$settings"
OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
OMNIROUTE_MODEL="auto/coding" \
OMNIROUTE_CONTEXT_TOKENS=1000000 \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1
assert_eq "override: explicit context size" "1000000" "$(env_key "$settings" CLAUDE_CODE_MAX_CONTEXT_TOKENS)"
# No token given -> placeholder 'local' is written (Claude Code needs a value)
assert_eq "override: token defaults local"  "local"   "$(env_key "$settings" ANTHROPIC_AUTH_TOKEN)"

settings="$tmpdir/three.json"
echo '{}' > "$settings"
OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
OMNIROUTE_MODEL="auto/coding" \
OMNIROUTE_CONTEXT_TOKENS= \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1
assert_eq "empty: context key skipped"      "(absent)" "$(env_key "$settings" CLAUDE_CODE_MAX_CONTEXT_TOKENS)"

# ---------------------------------------------------------------------------
# 3. enable.sh: no model pinned -> no model/context keys, and idempotent
#    re-run removes a previously pinned model
# ---------------------------------------------------------------------------
settings="$tmpdir/four.json"
echo '{}' > "$settings"
OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1
assert_eq "no model: ANTHROPIC_MODEL absent"       "(absent)" "$(env_key "$settings" ANTHROPIC_MODEL)"
assert_eq "no model: MAX_CONTEXT_TOKENS absent"    "(absent)" "$(env_key "$settings" CLAUDE_CODE_MAX_CONTEXT_TOKENS)"

OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
OMNIROUTE_MODEL="auto/fast" \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1
OMNIROUTE_BASE_URL="http://example.test:20128/v1" \
bash "$SCRIPT_DIR/enable.sh" "$settings" >/dev/null 2>&1
assert_eq "unpin: re-run clears ANTHROPIC_MODEL"    "(absent)" "$(env_key "$settings" ANTHROPIC_MODEL)"
assert_eq "unpin: re-run clears MAX_CONTEXT_TOKENS" "(absent)" "$(env_key "$settings" CLAUDE_CODE_MAX_CONTEXT_TOKENS)"

# ---------------------------------------------------------------------------
# 4. status.sh: reports values (offline, no reachability prompt)
# ---------------------------------------------------------------------------
status_out="$(bash "$SCRIPT_DIR/status.sh" "$tmpdir/one.json" 2>/dev/null)"
case "$status_out" in
    *"ANTHROPIC_BASE_URL  : http://example.test:20128/v1"*) PASS=$((PASS + 1)) ;;
    *) FAIL=$((FAIL + 1)); echo "FAIL: status shows base URL"; echo "$status_out" ;;
esac
case "$status_out" in
    *"MAX_CONTEXT_TOKENS  : 1048576"*) PASS=$((PASS + 1)) ;;
    *) FAIL=$((FAIL + 1)); echo "FAIL: status shows context tokens"; echo "$status_out" ;;
esac

# ---------------------------------------------------------------------------
# 5. disable.sh: removes exactly the four keys, keeps the rest
# ---------------------------------------------------------------------------
bash "$SCRIPT_DIR/disable.sh" "$tmpdir/one.json" >/dev/null 2>&1
for key in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL CLAUDE_CODE_MAX_CONTEXT_TOKENS; do
    assert_eq "disable: $key removed" "(absent)" "$(env_key "$tmpdir/one.json" "$key")"
done
assert_eq "disable: PRESERVE_ME kept" "yes" "$(env_key "$tmpdir/one.json" PRESERVE_ME)"

# ---------------------------------------------------------------------------
# 6. Optional online probe (only with --online and a reachable base URL)
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--online" ]; then
    BASE_URL="${2:-${OMNIROUTE_BASE_URL:-}}"
    if [ -n "$BASE_URL" ]; then
        code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$BASE_URL/models" 2>/dev/null || echo 000)"
        if [ "$code" != "000" ]; then
            PASS=$((PASS + 1))
            echo "online: gateway reachable (HTTP $code)"
        else
            FAIL=$((FAIL + 1))
            echo "FAIL: online gateway $BASE_URL unreachable"
        fi
    else
        echo "online: no base URL given - skipped"
    fi
fi

echo
echo "selftest: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
