#!/usr/bin/env bash
# Point Claude Code at OmniRoute by setting ANTHROPIC_BASE_URL (and friends)
# inside a Claude Code settings.json file.
#
# Usage:
#   bash enable.sh                        # edits ~/.claude/settings.json
#   bash enable.sh .claude/settings.json  # edits a project-local settings file
#
# Env overrides (skip the matching prompt if set):
#   OMNIROUTE_BASE_URL   e.g. http://192.168.1.46:20128/v1
#   OMNIROUTE_AUTH_TOKEN (default: local)
#   OMNIROUTE_MODEL      (default: unset -> Claude Code's own default model name)
#   OMNIROUTE_CONTEXT_TOKENS (default: 1048576 when OMNIROUTE_MODEL is set)

set -euo pipefail

SETTINGS_FILE="${1:-$HOME/.claude/settings.json}"

if [ -z "${OMNIROUTE_BASE_URL:-}" ]; then
    if [ -t 0 ]; then
        read -r -p "OmniRoute base URL (e.g. http://192.168.1.46:20128/v1): " OMNIROUTE_BASE_URL
    fi
    if [ -z "${OMNIROUTE_BASE_URL:-}" ]; then
        echo "Error: no OmniRoute base URL given. Pass one via OMNIROUTE_BASE_URL=... or answer the prompt." >&2
        exit 1
    fi
fi
BASE_URL="$OMNIROUTE_BASE_URL"
AUTH_TOKEN="${OMNIROUTE_AUTH_TOKEN:-local}"
MODEL="${OMNIROUTE_MODEL:-}"
# NOTE: no colon in the default expansion - set-but-empty must stay empty
# (empty = don't write CLAUDE_CODE_MAX_CONTEXT_TOKENS), only unset takes
# the default.
CONTEXT_TOKENS="${OMNIROUTE_CONTEXT_TOKENS-1048576}"

mkdir -p "$(dirname "$SETTINGS_FILE")"

python3 - "$SETTINGS_FILE" "$BASE_URL" "$AUTH_TOKEN" "$MODEL" "$CONTEXT_TOKENS" <<'PYEOF'
import json, os, shutil, sys, datetime

settings_file, base_url, auth_token, model, context_tokens = sys.argv[1:6]

data = {}
if os.path.exists(settings_file):
    backup = f"{settings_file}.bak.{datetime.datetime.now():%Y%m%d%H%M%S}"
    shutil.copy2(settings_file, backup)
    print(f"Backed up existing settings to {backup}")
    with open(settings_file) as f:
        content = f.read().strip()
        data = json.loads(content) if content else {}

env = data.setdefault("env", {})
env["ANTHROPIC_BASE_URL"] = base_url
env["ANTHROPIC_AUTH_TOKEN"] = auth_token
if model:
    env["ANTHROPIC_MODEL"] = model
    # Claude Code doesn't know gateway/combo model names, so it assumes a
    # 200k window and auto-compacts early. Tell it the real one.
    if context_tokens:
        env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = str(context_tokens)
    else:
        env.pop("CLAUDE_CODE_MAX_CONTEXT_TOKENS", None)
else:
    env.pop("ANTHROPIC_MODEL", None)
    env.pop("CLAUDE_CODE_MAX_CONTEXT_TOKENS", None)

with open(settings_file, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"Wrote {settings_file}:")
print(f"  ANTHROPIC_BASE_URL   = {base_url}")
print(f"  ANTHROPIC_AUTH_TOKEN = {'*' * len(auth_token)}")
if model:
    print(f"  ANTHROPIC_MODEL      = {model}")
    if context_tokens:
        print(f"  CLAUDE_CODE_MAX_CONTEXT_TOKENS = {context_tokens}")
PYEOF

echo
echo "Restart any running 'claude' sessions for this to take effect."
