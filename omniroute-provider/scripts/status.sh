#!/usr/bin/env bash
# Show the current Claude Code provider settings and check whether
# OmniRoute is reachable on the network.
#
# Usage:
#   bash status.sh                        # reads ~/.claude/settings.json
#   bash status.sh .claude/settings.json  # reads a project-local settings file
#
# By default this checks whatever ANTHROPIC_BASE_URL is already set in the
# settings file. Pass OMNIROUTE_BASE_URL=... to check a different host
# instead (or it'll prompt for one if nothing is configured yet).

set -euo pipefail

SETTINGS_FILE="${1:-$HOME/.claude/settings.json}"

echo "== $SETTINGS_FILE =="
CONFIGURED_BASE_URL=""
if [ -f "$SETTINGS_FILE" ]; then
    python3 - "$SETTINGS_FILE" <<'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    content = f.read().strip()
    data = json.loads(content) if content else {}

env = data.get("env", {})
print("ANTHROPIC_BASE_URL  :", env.get("ANTHROPIC_BASE_URL", "(not set - using Anthropic's API)"))
print("ANTHROPIC_AUTH_TOKEN:", "(set)" if env.get("ANTHROPIC_AUTH_TOKEN") else "(not set)")
print("ANTHROPIC_MODEL     :", env.get("ANTHROPIC_MODEL", "(not set - Claude Code default)"))
print("MAX_CONTEXT_TOKENS  :", env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "(not set)"))
PYEOF
    CONFIGURED_BASE_URL="$(python3 - "$SETTINGS_FILE" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    content = f.read().strip()
    data = json.loads(content) if content else {}
print(data.get("env", {}).get("ANTHROPIC_BASE_URL", ""))
PYEOF
)"
else
    echo "File does not exist - Claude Code is using its default Anthropic API settings."
fi

BASE_URL="${OMNIROUTE_BASE_URL:-$CONFIGURED_BASE_URL}"
if [ -z "$BASE_URL" ] && [ -t 0 ]; then
    read -r -p "OmniRoute base URL to check (e.g. http://192.168.1.46:20128/v1): " BASE_URL
fi
if [ -z "$BASE_URL" ]; then
    echo
    echo "No OmniRoute base URL configured or given - skipping reachability check."
    exit 0
fi

echo
echo "== Reachability check: $BASE_URL =="
if curl -sS -m 5 -o /dev/null -w "HTTP %{http_code}\n" "$BASE_URL/models" 2>/dev/null; then
    :
else
    echo "Could not reach $BASE_URL (network unreachable, wrong address, or OmniRoute is down)."
fi
echo "(Note: a 2xx/4xx response here only proves the network path works -"
echo " it doesn't confirm OmniRoute speaks the Anthropic Messages API.)"
