#!/usr/bin/env bash
# Revert Claude Code back to the standard Anthropic API by removing the
# OmniRoute-related keys from a settings.json file. Everything else in
# the file is left untouched.
#
# Usage:
#   bash disable.sh                        # edits ~/.claude/settings.json
#   bash disable.sh .claude/settings.json  # edits a project-local settings file

set -euo pipefail

SETTINGS_FILE="${1:-$HOME/.claude/settings.json}"

if [ ! -f "$SETTINGS_FILE" ]; then
    echo "No file at $SETTINGS_FILE - nothing to revert."
    exit 0
fi

python3 - "$SETTINGS_FILE" <<'PYEOF'
import json, sys

settings_file = sys.argv[1]

with open(settings_file) as f:
    content = f.read().strip()
    data = json.loads(content) if content else {}

env = data.get("env", {})
removed = []
for key in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"):
    if key in env:
        removed.append(key)
        env.pop(key)

if env:
    data["env"] = env
else:
    data.pop("env", None)

with open(settings_file, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

if removed:
    print(f"Removed from {settings_file}: {', '.join(removed)}")
else:
    print(f"No OmniRoute keys were set in {settings_file}.")
PYEOF

echo "Claude Code will use the default Anthropic API again after a restart."
