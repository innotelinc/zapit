#!/usr/bin/env bash
# zapit — one-shot setup: hooks, env, and quick start.
#
#   ./scripts/setup.sh            # hooks + .env bootstrap + instructions
#   ./scripts/setup.sh --help
#
# Idempotent: safe to re-run. There is no local secret service to bootstrap:
# Cerulean Vault is hosted by the platform, and plain values move into it with
# scripts/vault-migrate.py (see docs/stack.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg (see ./scripts/setup.sh --help)" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;34m>>\033[0m %s\n' "$*"; }

# Enable the version-controlled commit-guard hooks (.githooks) if this is a
# git checkout (blocks attribution to anyone but Darnel Hunter).
if [ -d "$ROOT/.githooks" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.hooksPath "$ROOT/.githooks"
  log "commit guard hook enabled (core.hooksPath -> .githooks)"
fi

# Root env carries the Cerulean Vault (SecretOps) contract; the app env lives
# at zapit/.env (copied from zapit/.env.example by the app's own workflow).
if [ ! -f .env ]; then
  cp .env.example .env
  cat <<'EOF'

Created .env from .env.example.
  * To resolve the app's ADMIN_PASSWORD / AUTHENTIK_CLIENT_SECRET from Cerulean
    Vault, set VAULT_ADDR plus VAULT_TOKEN (or VAULT_TOKEN_FILE) in .env and use
    vault://<mount>/<path>#<key> values; otherwise leave plain values in place.
  * App config (PORT, ADMIN_PASSWORD, Authentik SSO) lives in zapit/.env —
    copy zapit/.env.example to zapit/.env and edit it.
EOF
fi

# App env bootstrap (the app reads zapit/.env).
if [ ! -f zapit/.env ]; then
  cp zapit/.env.example zapit/.env
  log "created zapit/.env from zapit/.env.example — edit ADMIN_PASSWORD, Authentik SSO"
fi

log "quick start (npm):  cd zapit && npm install && ADMIN_PASSWORD=... npm start"
log "quick start (docker): docker compose -f zapit/docker-compose.yml up -d --build"
log "landing page: https://github.com/innotelinc/zapit (Pages: https://innotelinc.github.io/zapit/)"