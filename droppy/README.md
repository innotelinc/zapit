# ⚡ droppy

Zap files between your devices in real time — drag & drop, no accounts, no uploads to disk.
Open the same URL on both devices (or scan the QR), type the same room code, drop files. Done.

- **Zero login by default** — room code is the "password"
- **Peer-to-peer via WebRTC** when possible — files go device-to-device, skipping the server;
  automatic fallback to server relay if the handshake can't complete
- **Multi-file & folder drops arrive as one ZIP** (built in-browser, store method, zero deps)
- **Room codes auto-expire** — 15 min after pairing (paused while devices are connected),
  the code rotates automatically; rotate manually anytime with **↻ New code**
- **QR code** of your LAN address so phones can join in one scan
- **Text snippets** shared alongside files
- **Optional Authentik SSO** (OIDC + PKCE) with a **flip of a switch** in the admin panel
- **Admin password** required to flip that switch (and to lock the panel)
- Single Node process, two tiny dependencies (`ws`, `qrcode`), ~zero config

## Quick start

```bash
npm install
npm start
# open http://localhost:5150
```

On your phone: open the LAN URL printed at startup (or scan the QR on the page), enter the
same room code, and drop files both ways.

## How transfers work

Devices join a **room** (an ephemeral ID you invent, e.g. `zap-421`). On pairing, the devices
negotiate a **WebRTC data channel** (STUN-assisted, one file at a time per peer) — transfers
then flow directly device-to-device and never touch the server. If the negotiation fails
(strict NATs, blocked UDP), droppy silently falls back to relaying chunks through the server
over the same WebSocket, so transfers always work. The footer shows the active mode:
`mode: p2p` or `mode: relay`.

Nothing is persisted server-side; close the tab and it's gone. Multi-file and folder drops
are assembled into a **single ZIP on the receiving device** (store method — fast, no
compression overhead). Progress bars show send/receive status, received files get a **Save**
button, and **⬇ Save all as ZIP** bundles everything received.

## Room expiry

Room codes are capabilities, so they expire: **15 minutes** after pairing (or last activity).
The countdown shows next to the room field and **pauses while other devices are paired** —
an active session never gets yanked mid-transfer. When idle, the code auto-rotates and the
new code is shown; share it again. Prefer manual control? **↻ New code** rotates on demand.

## Admin & the auth kill-switch

1. Set an admin password so only you can manage the switch:

   ```bash
   ADMIN_PASSWORD=my-secret npm start
   ```

2. Open `/admin`, enter the password.
3. Flip **"Require Authentik login"**:
   - **ON** — everyone must sign in via Authentik before pairing (existing sessions are
     revoked instantly; WebSocket upgrades without a session are refused).
   - **OFF** — open access again.

The switch state is persisted in `data/state.json` and survives restarts. Turning auth ON
when Authentik isn't configured is rejected (that would lock everyone out).

## Authentik setup

1. In Authentik: **Applications → Providers → Create** an *OAuth2/OpenID Connect* provider.
2. Set the **redirect URI** to `https://your-droppy-host/api/auth/callback`
   (use `http://...:5150/api/auth/callback` for plain LAN).
3. Choose **public** client (PKCE — no secret needed) or confidential (paste the secret).
4. Configure droppy via env (or `data/config.json`):

   ```bash
   AUTHENTIK_BASE_URL=https://authentik.example.com
   AUTHENTIK_CLIENT_ID=your_client_id
   # AUTHENTIK_CLIENT_SECRET=...        # only for confidential clients
   # AUTHENTIK_SLUG=droppy              # provider/application slug, default: droppy
   ```

5. Restart, flip the switch in `/admin`. A "Sign in with Authentik" button appears in the UI,
   and unauthenticated pairings are refused until you toggle it back off.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5150` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_PASSWORD` | *(unset)* | Enables the admin API + panel |
| `AUTHENTIK_BASE_URL` | *(unset)* | e.g. `https://authentik.example.com` |
| `AUTHENTIK_SLUG` | `droppy` | Provider application slug |
| `AUTHENTIK_CLIENT_ID` | *(unset)* | OIDC client id |
| `AUTHENTIK_CLIENT_SECRET` | *(empty)* | Only for confidential clients |
| `AUTHENTIK_SCOPES` | `openid profile email` | Requested scopes |
| `AUTH_ENABLED` | `false` | Initial kill-switch state (persisted afterwards) |
| `DROPPY_DATA_DIR` | `./data` | Where `state.json` / `config.json` live |

## Docker

Prebuilt multi-arch images (amd64 + arm64) are published to GHCR by CI on every push to
`main` and every `v*` tag — tests gate the build:

```bash
docker run -d -p 5150:5150 -e ADMIN_PASSWORD=secret ghcr.io/<owner>/<repo>:latest
```

Or build locally:

```bash
docker compose up -d --build
# → http://localhost:5150
```

Or without compose:

```bash
docker build -t droppy .
docker run -d -p 5150:5150 -e ADMIN_PASSWORD=secret -v droppy-data:/data droppy
```

Notes:

- The image runs as a **non-root user** (uid 1000) with `tini` as PID 1 for clean shutdown,
  and ships a **healthcheck** (`docker ps` shows `(healthy)`).
- State (`state.json` / `config.json`) persists in the `droppy-data` volume. Prefer a bind
  mount? Use `-v ./data:/data` and make it writable by uid 1000: `chown 1000:1000 ./data`.
  If the data dir isn't writable, the admin API now **rejects changes with an error** instead
  of silently losing the kill-switch state on restart.
- The admin password is hashed and persisted on first boot, so you can later remove the
  `ADMIN_PASSWORD` env and it keeps working (set a new one the same way to rotate).
- Behind a reverse proxy, forward `X-Forwarded-Proto` and `X-Forwarded-Host` so the Authentik
  redirect URI is computed correctly.

## Notes

- **HTTPS**: most browsers only allow the clipboard API on secure origins. On plain LAN HTTP
  everything still works except one-click clipboard copy (you can select/copy manually).
  Terminate TLS at a reverse proxy if you expose it publicly, and add the same redirect URI
  (https) in Authentik. `X-Forwarded-Proto` / `X-Forwarded-Host` are honored for OIDC redirects.
- **Security**: the room code is a capability — anyone who knows it can pair. Keep codes
  random, or leave the auth switch on when exposing beyond your LAN.
- **Large files**: streamed in 256 KB chunks with backpressure via the socket buffer; tested
  with multi-GB files on LAN.

## CI

`.github/workflows/docker.yml` runs on pushes to `main`, version tags, and PRs:

1. **test** — installs with `npm ci`, runs the protocol suite and the browser simulation.
2. **build** — only after tests pass: multi-arch (amd64/arm64) build pushed to
   `ghcr.io/<owner>/<repo>` with semver tags (`1.2.3` / `1.2` / `1`), `:main`, `:sha-<short>`,
   and `:latest` on tag builds. PRs build but don't push.

The first push creates the GHCR package as **private** — flip it to public under
repo → Packages → droppy → Package settings for anonymous pulls. Dependabot keeps the
action pins and npm deps fresh.

## Development & tests

```bash
npm test          # protocol suite + browser simulation
npm run test:unit # protocol suite only (server API, relay, admin, kill-switch)
npm run test:ui   # browser simulation (drives the real UI in two jsdom tabs)
```

The unit suite covers static pages, config/LAN endpoints, room pairing, a real 1 MiB binary
transfer through the relay, signaling relay, admin login, the kill-switch toggle, and its
persistence.

The browser simulation is the interesting one: it loads the **actual `index.html` UI** into
two jsdom "tabs" connected to a real server, with `RTCPeerConnection` swapped for a local
implementation with identical semantics. It then verifies: p2p negotiation, byte-identical
p2p transfer, multi-file drop → single ZIP (magic bytes + payload checked), text zap,
relay-mode fallback with byte verification, and room auto-rotation after the peer leaves.
Network transports are the only shimmed piece — chunking, backpressure, ZIP building, and
all UI logic run for real.
