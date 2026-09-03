#!/usr/bin/env bash
# Infisical (SecretOps) — start the opt-in profile and provision secrets.
# Set INFISICAL_ADMIN_EMAIL / INFISICAL_ADMIN_PASSWORD (and the INFISICAL_*
# keys) in .env first. Safe to re-run — idempotent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
# zapit: the Infisical contract lives in the repo-root .env; the app env is
# zapit/.env. Source whichever exists.
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
elif [ -f zapit/.env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./zapit/.env
  set +a
fi
COMPOSE_FILES="${COMPOSE_FILES:-zapit/docker-compose.yml compose.infisical.yml}"
# shellcheck disable=SC2086
docker compose -f ${COMPOSE_FILES} --profile infisical up -d
python3 scripts/infisical-setup.py
