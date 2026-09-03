# ⚡ zapit — Platform Stack Role

**Classification: TransferOps** (edge utility)

Ephemeral, device-to-device file transfer: drag-and-drop sharing over WebRTC
with a server-relay fallback, room-code based, zero login by default.

This page declares zapit's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in exactly one
place; this page links zapit to it and states what this platform owns, consumes,
provides, and explicitly does not own.

## Owns

- **Peer-to-peer transfer** — WebRTC data channels between devices; files stream
  device-to-device, never written to the server's disk
- **Room codes** — ephemeral, auto-expiring codes that act as the "password"
- **Relay fallback** — server-side relay when NAT/UDP blocks direct paths
- **Zings** — text snippets, links and code zapped alongside files
- **QR pairing** — one-scan phone pairing for LAN addresses (`QR_URL`)

## Provides

- **Transfer service to users** — `zapit.innotel.us` public instance and
  self-hosted deploys, via the zapit portal
- **Optional Authentik blueprint** — one-click SSO provider YAML
  (`/api/authentik/blueprint` or `zapit/authentik/blueprint.yaml`)

## Consumes

- Authentik — identity, SSO (optional; zero-login is the default)

## Explicitly does NOT own

- **Storage** (ONYX) — files are ephemeral; nothing is persisted server-side
- Identity (Authentik)
- Secrets (Infisical)
- Billing / revenue (Magnate)
- Certificates / trust (Cerulean)

> **Placement:** zapit is an edge utility — a business function, not a foundation
> layer. It sits alongside the business platforms but stays deliberately small:
> one Node process, two runtime dependencies, ~zero config.

## Secrets (Infisical)

Secrets for this platform live in **Infisical** (SecretOps): the admin password and
Authentik credentials are imported into an Infisical workspace and the stack's `.env`
is derived from it. Enable it with:

```bash
# generate the required keys and add them to .env
openssl rand -base64 32   # INFISICAL_ENCRYPTION_KEY
openssl rand -hex 16      # INFISICAL_AUTH_SECRET
openssl rand -hex 16      # INFISICAL_DB_PASSWORD

# start the profile and provision the workspace + import .env secrets
docker compose -f zapit/docker-compose.yml -f compose.infisical.yml --profile infisical up -d
bash scripts/infisical-setup.sh
```

See [compose.infisical.yml](../compose.infisical.yml) and
[scripts/infisical-setup.py](../scripts/infisical-setup.py) for details.

*zapit · TransferOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*