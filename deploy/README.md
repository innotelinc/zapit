# Deploying https://droppy.innotel.us

Files in this directory:

- `docker-compose.prod.yml` — droppy (GHCR image) + Caddy (automatic HTTPS)
- `Caddyfile` — TLS termination + reverse proxy config
- [`authentik/blueprint.yaml`](../authentik/blueprint.yaml) — Authentik provider/application blueprint

## Steps

1. **DNS** — point `droppy.innotel.us` (A/AAAA) at the host. Ports 80 + 443 must be
   reachable so Caddy can complete the Let's Encrypt challenge.

2. **Env** — create `.env` next to `docker-compose.prod.yml` (see `.env.example` in the
   repo root) with at least:

   ```bash
   ADMIN_PASSWORD=<your-admin-secret>
   AUTHENTIK_BASE_URL=https://<your-authentik-host>
   AUTHENTIK_CLIENT_ID=droppy
   ```

3. **Up** —

   ```bash
   docker compose -f docker-compose.prod.yml up -d
   docker compose -f docker-compose.prod.yml ps   # wait for (healthy)
   ```

   Caddy obtains a certificate automatically; https://droppy.innotel.us should be live
   and the QR code on the page will advertise `https://droppy.innotel.us` (via `PUBLIC_URL`).

4. **Authentik** — apply the blueprint once (either way):
   - `https://droppy.innotel.us/admin` → *Download blueprint YAML* → paste into
     Authentik under **Customize → Blueprints → Create**, or
   - mount `authentik/blueprint.yaml` into the authentik worker as `/blueprints/droppy.yaml`.

   Ensure droppy's `AUTHENTIK_CLIENT_ID` matches the blueprint's `client_id`
   (`DROPPY_CLIENT_ID` on authentik; default `droppy`).

5. **Lock it down (optional)** — flip **Require Authentik login** in `/admin`.
   The state persists on the `droppy-data` volume.

## Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

CI re-pushes `:latest` on every commit to `main`; pin `ghcr.io/innotelinc/droppy:1.0.0`
instead if you want fixed versions.
