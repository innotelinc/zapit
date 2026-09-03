# Deploying https://zapit.innotel.us

Reverse proxy: **Nginx Proxy Manager (NPM)**, running on its **own host** (e.g.
`192.168.1.71`, admin UI at `http://192.168.1.71:81`). NPM owns ports 80/443 and
TLS. The zapit container runs on a **separate app host** (e.g. the nas at
`192.168.1.10`) and publishes port 5150 on that host's LAN address — the two
boxes are **not** on a shared docker network, so NPM forwards over the LAN by
IP, not by container name.

Files in this directory:

- `docker-compose.prod.yml` — zapit (GHCR image) with port 5150 published on the app host
- `.env.example` — env template
- [`../zapit/authentik/blueprint.yaml`](../zapit/authentik/blueprint.yaml) — Authentik provider/application blueprint

## Steps

1. **App host env** — copy `.env.example` to `.env` next to `docker-compose.prod.yml`:

   ```bash
   ADMIN_PASSWORD=<your-admin-secret>
   AUTHENTIK_BASE_URL=https://<your-authentik-host>   # only if you use SSO
   AUTHENTIK_CLIENT_ID=zapit
   ```

   No `NPM_NETWORK` is needed — zapit is reached over the LAN, not a shared
   docker network.

2. **DNS** — `zapit.innotel.us` must resolve to the **NPM host** (in the innotel
   setup the wildcard `*.innotel.us` record already covers every subdomain, so
   there is nothing to add).

3. **Up** (on the app host):

   ```bash
   docker compose -f docker-compose.prod.yml up -d
   docker compose -f docker-compose.prod.yml ps   # wait for (healthy)
   ```

   This publishes `5150` on the app host's LAN address (e.g. `192.168.1.10:5150`).
   Verify from the NPM host: `curl http://192.168.1.10:5150/healthz`.

4. **NPM proxy host** — on the NPM host, Hosts → Proxy Hosts → **Add Proxy Host**
   (or `POST /api/nginx/proxy-hosts` via the API):

   | Field | Value |
   | --- | --- |
   | Domain Names | `zapit.innotel.us` |
   | Scheme | `http` |
   | Forward Hostname / IP | `<app-host LAN IP>` (e.g. `192.168.1.10`) |
   | Forward Port | `5150` |
   | Websockets Support | ✅ (required — transfers ride WebSockets) |
   | Block Common Exploits | ✅ |
   | SSL tab | Request a new Let's Encrypt certificate · Force SSL · HTTP/2 |

   Notes from the live deployment:
   - HTTP-01 issuance works because the domain already routes through NPM —
     no DNS-01/TSIG needed for a single-name cert.
   - The current NPM build rejects `letsencrypt_email` inside `meta` on
     `POST /api/nginx/certificates` (schema allows only `letsencrypt_agree`
     and `dns_challenge`) — the account default email is used.

   https://zapit.innotel.us should now be live, and the QR code on the page
   advertises whatever `QR_URL`/`PUBLIC_URL` is set.

5. **Authentik** (only if you use SSO) — apply the blueprint once (either way):
   - `https://zapit.innotel.us/admin` → *Download blueprint YAML* → paste into
     Authentik under **Customize → Blueprints → Create**, or
   - mount `zapit/authentik/blueprint.yaml` into the authentik worker as `/blueprints/zapit.yaml`.

   Ensure zapit's `AUTHENTIK_CLIENT_ID` matches the blueprint's `client_id`
   (`ZAPIT_CLIENT_ID` on authentik; default `zapit`).

6. **Lock it down (optional)** — flip **Require Authentik login** in `/admin`.
   The state persists on the `zapit-data` volume.

## QR code customization

Set `QR_URL` in `.env` to change the link address the QR code on the page encodes —
handy when you want the QR to point at a different join URL (a vanity domain, a
reverse-proxy entry, a specific room) than the canonical `PUBLIC_URL`:

```bash
QR_URL=https://zapit.innotel.us/?room=zap-421   # what the live site uses
```

When unset, the QR encodes `PUBLIC_URL` (or the LAN URL on plain local runs).

## Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

CI re-pushes `:latest` on every commit to `main`; pin
`ghcr.io/innotelinc/zapit:1.2.1` instead if you want fixed versions.
