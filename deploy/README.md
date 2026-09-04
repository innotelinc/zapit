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

The **ZapIt app runs from the published image** `ghcr.io/innotelinc/zapit` (built by
the `docker.yml` workflow on every release tag: `1.4.1`, `1.4`, `1`, and rolling
`latest`). Deploying a release is a single `docker compose pull zapit` — the app
host does **not** need a repo checkout to update the app. Pin a specific version
with `ZAPIT_TAG` in `.env` for reproducible deploys.

The **landing page still builds from this checkout** (static HTML; no landing image
is published to GHCR — the `pages.yml` workflow also deploys it to GitHub Pages).
It only needs a rebuild when the landing page itself changes.

Files in this directory:

- `docker-compose.prod.yml` — landing + ZapIt services (app pulled from GHCR)
- `.env.example` — environment template (`ZAPIT_TAG` pins the app release)
- [`../web/landing/Dockerfile`](../web/landing/Dockerfile) — landing image definition
- [`../zapit/authentik/blueprint.yaml`](../zapit/authentik/blueprint.yaml) — Authentik provider/application blueprint

## Steps

1. **App host env** — copy `.env.example` to `.env` next to `docker-compose.prod.yml`:

   ```bash
   ZAPIT_TAG=latest                          # optional: pin a release, e.g. 1.4.1
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
   docker compose -f docker-compose.prod.yml up -d    # pulls the app image; builds landing only if missing
   docker compose -f docker-compose.prod.yml ps       # wait for (healthy)
   ```

   First deploy only: if the app image is not yet present locally, `up -d` pulls
   it automatically. To force a fresh pull of the configured tag:

   ```bash
   docker compose -f docker-compose.prod.yml pull zapit
   docker compose -f docker-compose.prod.yml up -d zapit
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

**App releases** (no repo checkout on the app host needed):

```bash
docker compose -f docker-compose.prod.yml pull zapit   # grabs the newest tag / ZAPIT_TAG pin
sudo docker compose -f docker-compose.prod.yml up -d zapit
```

- Default (`ZAPIT_TAG=latest`) tracks the newest tagged release on GHCR.
- Set `ZAPIT_TAG=1.4.1` in `.env` to stay on a known-good release; bump it when
  you're ready to move.
- The container keeps its `zapit-data` volume, so admin state (kill-switch,
  saved rooms are client-side) survives the swap.

**Landing page** changes still need the checkout on the app host:

```bash
git pull   # on the app host checkout
sudo docker compose -f docker-compose.prod.yml up -d --build landing
```
