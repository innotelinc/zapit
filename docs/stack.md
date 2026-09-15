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

- **Transfer service to users** — `zapp.innotel.us` public instance and
  self-hosted deploys, via the zapit portal
- **Optional Authentik blueprint** — one-click SSO provider YAML
  (`/api/authentik/blueprint` or `zapit/authentik/blueprint.yaml`)

## Consumes

- Authentik — identity, SSO (optional; zero-login is the default)

## Explicitly does NOT own

- **Storage** (ONYX) — files are ephemeral; nothing is persisted server-side
- Identity (Authentik)
- Secrets (Cerulean Vault)
- Billing / revenue (Magnate)
- Certificates / trust (Cerulean)

> **Placement:** zapit is an edge utility — a business function, not a foundation
> layer. It sits alongside the business platforms but stays deliberately small:
> one Node process, two runtime dependencies, ~zero config.

## Secrets (Cerulean Vault)

The platform's SecretOps is **Cerulean Vault** — HashiCorp Vault, KV v2, hosted by
Cerulean — with `vault://<mount>/<path>#<key>` references in `.env`:

```bash
ADMIN_PASSWORD=vault://cerulean/zapit#ADMIN_PASSWORD
```

Cerulean mints this stack's **path-scoped** token (its policy covers only
`cerulean/data/zapit`, never a sibling's secrets) and renews it in place. Copy it
to `./data/vault/token/zapit.token`, then move any plaintext values across:

```bash
VAULT_ADDR=http://<cerulean-host>:8200 \
  VAULT_TOKEN_FILE=./data/vault/token/zapit.token \
  VAULT_PREFIX=cerulean VAULT_PATH=zapit \
  python3 scripts/vault-migrate.py --from-env-file .env \
    --keys ADMIN_PASSWORD,AUTHENTIK_CLIENT_SECRET
```

### Runtime resolution (`vault://`)

With `VAULT_ADDR` and `VAULT_TOKEN` (or `VAULT_TOKEN_FILE`) in `.env`, the server
resolves secrets at startup:

- `ADMIN_PASSWORD` and `AUTHENTIK_CLIENT_SECRET` may be `vault://<mount>/<path>#<key>`
  references — resolved synchronously at boot, before the admin hash is computed,
  in a child node process so the blocking read cannot stall the server's loop.
- A reference that cannot be resolved — unconfigured, unreachable, a missing key,
  an empty value — **fails the boot** rather than starting with a literal
  reference where a credential belongs. Plain values pass through untouched.
- A leftover `infisical://` value is refused outright: Infisical is retired here,
  not a fallback.

Client: `zapit/vault.js` (zero-dependency, same contract as Cerulean/Onyx/Zeus).
It is **read-only**: Cerulean grants this stack a read/list policy, so pushing
plain values into Vault is the operator's `scripts/vault-migrate.py`, not a
boot-time mirror.

*zapit · TransferOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*