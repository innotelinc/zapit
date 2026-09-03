# Deploying https://droppy.innotel.us

Reverse proxy: **Nginx Proxy Manager (NPM)**. This compose only runs the droppy
container and joins your NPM network — NPM owns ports 80/443 and TLS.

Files in this directory:

- `docker-compose.prod.yml` — droppy (GHCR image) on your NPM docker network
- `.env.example` — env template
- [`authentik/blueprint.yaml`](../authentik/blueprint.yaml) — Authentik provider/application blueprint

## Steps

1. **Find your NPM network** — the docker network your NPM container is attached to:

   ```bash
   docker inspect <npm-container> --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}} {{end}}'
   ```

   (commonly `npm_default` or a manually created `proxy` network)

2. **DNS** — point `droppy.innotel.us` (A/AAAA) at the host running NPM.

3. **Env** — copy `.env.example` to `.env` next to `docker-compose.prod.yml`:

   ```bash
   ADMIN_PASSWORD=<your-admin-secret>
   AUTHENTIK_BASE_URL=https://<your-authentik-host>
   AUTHENTIK_CLIENT_ID=droppy
   NPM_NETWORK=<network from step 1>
   ```

4. **Up** —

   ```bash
   docker compose -f docker-compose.prod.yml up -d
   docker compose -f docker-compose.prod.yml ps   # wait for (healthy)
   ```

5. **NPM proxy host** — Hosts → Proxy Hosts → **Add Proxy Host**:

   | Field | Value |
   | --- | --- |
   | Domain Names | `droppy.innotel.us` |
   | Scheme | `http` |
   | Forward Hostname / IP | `droppy` |
   | Forward Port | `5150` |
   | Websockets Support | ✅ (required — transfers ride WebSockets) |
   | Block Common Exploits | ✅ |
   | SSL tab | Request a new Let's Encrypt certificate · Force SSL · HTTP/2 |

   https://droppy.innotel.us should now be live, and the QR code on the page
   advertises `https://droppy.innotel.us` (via `PUBLIC_URL`).

6. **Authentik** — apply the blueprint once (either way):
   - `https://droppy.innotel.us/admin` → *Download blueprint YAML* → paste into
     Authentik under **Customize → Blueprints → Create**, or
   - mount `authentik/blueprint.yaml` into the authentik worker as `/blueprints/droppy.yaml`.

   Ensure droppy's `AUTHENTIK_CLIENT_ID` matches the blueprint's `client_id`
   (`DROPPY_CLIENT_ID` on authentik; default `droppy`).

7. **Lock it down (optional)** — flip **Require Authentik login** in `/admin`.
   The state persists on the `droppy-data` volume.

## Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

CI re-pushes `:latest` on every commit to `main`; pin `ghcr.io/innotelinc/droppy:1.0.0`
instead if you want fixed versions.
