# Deploying ZapIt and its landing page

Public domains:

- Landing page: `https://zapit.innotel.us`
- Transfer app: `https://zapp.innotel.us`

Reverse proxy: **Nginx Proxy Manager (NPM)**, running on its **own host** (e.g.
`192.168.1.71`, admin UI at `http://192.168.1.71:81`). NPM owns public ports 80/443
and TLS. The unified Docker Compose stack runs on the app host (e.g. the NAS at
`192.168.1.10`) and publishes two internal ports on that host:

- `8080` -> static landing page
- `5150` -> ZapIt WebSocket app

The boxes are not on a shared Docker network, so NPM forwards over the LAN by IP,
not by container name.

Files in this directory:

- `docker-compose.prod.yml` — landing + ZapIt services
- `.env.example` — environment template
- [`../web/landing/Dockerfile`](../web/landing/Dockerfile) — landing image definition
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

2. **DNS** — both `zapit.innotel.us` and `zapp.innotel.us` must resolve to the
   **NPM host** (in the innotel setup the wildcard `*.innotel.us` record already
   covers every subdomain, so there is nothing to add).

3. **Up** (on the app host):

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml ps   # wait for (healthy)
   ```

   Verify both services from the NPM host:

   ```bash
   curl http://192.168.1.10:8080/
   curl http://192.168.1.10:5150/healthz
   ```

4. **NPM proxy hosts** — on the NPM host, Hosts → Proxy Hosts → **Add Proxy Host**
   twice (or use `POST /api/nginx/proxy-hosts` via the API):

   | Domain | Scheme | Forward host | Port | WebSockets |
   | --- | --- | --- | ---: | --- |
   | `zapit.innotel.us` | `http` | `<app-host LAN IP>` | `8080` | Off |
   | `zapp.innotel.us` | `http` | `<app-host LAN IP>` | `5150` | **On** |

   Enable **Block Common Exploits** on both. Request separate Let's Encrypt
   certificates for both domains and enable Force SSL / HTTP/2.

   Notes from the live deployment:
   - HTTP-01 issuance works because the domain already routes through NPM —
     no DNS-01/TSIG needed for a single-name cert.
   - The current NPM build rejects `letsencrypt_email` inside `meta` on
     `POST /api/nginx/certificates` (schema allows only `letsencrypt_agree`
     and `dns_challenge`) — the account default email is used.

   Both domains should now be live. The QR code on the app advertises `zapp.innotel.us`
   by default through `PUBLIC_URL` and `QR_URL`.

5. **Authentik** (only if you use SSO) — apply the blueprint once (either way):
   - `https://zapp.innotel.us/admin` → *Download blueprint YAML* → paste into
     Authentik under **Customize → Blueprints → Create**, or
   - mount `zapit/authentik/blueprint.yaml` into the authentik worker as `/blueprints/zapit.yaml`.

   Ensure zapit's `AUTHENTIK_CLIENT_ID` matches the blueprint's `client_id`
   (`ZAPIT_CLIENT_ID` on authentik; default `zapit`).

6. **Lock it down (optional)** — flip **Require Authentik login** at
   `https://zapp.innotel.us/admin`. The state persists on the `zapit-data` volume.

## QR code customization

Set `QR_URL` in `.env` to change the link address the QR code on the page encodes —
handy when you want the QR to point at a different join URL (a vanity domain, a
reverse-proxy entry, a specific room) than the canonical `PUBLIC_URL`:

```bash
QR_URL=https://zapp.innotel.us/?room=zap-421
```

When unset, the QR encodes `PUBLIC_URL` (or the LAN URL on plain local runs).

## Updates

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The production compose file builds both images from this repository, so changes to the
landing page or app are included after `up -d --build`.
