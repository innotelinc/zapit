# droppy ⚡

Zap files between your devices in real time — drag & drop, no accounts, no uploads to disk.

Open the same URL on two devices (or scan the QR), type the same room code, and drop files.
They stream device-to-device over WebRTC when possible, with an automatic server-relay
fallback, so it works on your LAN and across the internet.

## Highlights

- **Zero login by default** — the room code is the "password"; codes auto-expire and rotate
- **Peer-to-peer** via WebRTC data channels (files never touch the server's disk)
- **Relay fallback** through the server when NATs/UDP block direct paths
- **Multi-file & folder drops arrive as one ZIP**, assembled in the browser (zero deps)
- **Text snippets** shared alongside files
- **Optional Authentik SSO** (OIDC + PKCE) with an admin kill-switch to flip login on/off
- **QR code** of your LAN address for one-scan phone pairing
- Single Node process, two runtime dependencies, ~zero config
- **Docker-ready** — non-root image, healthcheck, multi-arch builds published to GHCR by CI
  (tests gate every build: protocol suite + a browser simulation driving the real UI)
- **One-click Authentik blueprint** — droppy generates the provider YAML for you at
  `/api/authentik/blueprint`, or mount the static one in `authentik/blueprint.yaml`

## Public instance

A public deployment runs at **[https://droppy.innotel.us](https://droppy.innotel.us)** —
scan its QR from your phone and start zapping.

## Quick start

```bash
cd droppy
npm install
ADMIN_PASSWORD=your-secret npm start   # → http://localhost:5150
```

Or with Docker:

```bash
cd droppy
ADMIN_PASSWORD=your-secret docker compose up -d --build
```

Full documentation — Authentik setup, env vars, the admin panel, CI, and tests — lives in
[`droppy/README.md`](droppy/README.md).

## Repository layout

```
.github/workflows/docker.yml   CI: test → build → push to GHCR (amd64/arm64)
.github/dependabot.yml         Weekly action + npm dependency updates
droppy/                        The app: server, UI, Dockerfile, tests, docs
```

## About

**Darnel Hunter** — [dhunter@inotel.us](mailto:dhunter@inotel.us)

Author and maintainer of droppy. Building small, sharp tools that respect privacy:
no accounts, no tracking, files that go directly from device to device and vanish when
the tab closes. If you find droppy useful, contributions and bug reports are welcome —
open an issue or a PR.

## License

[MIT](LICENSE) © Darnel Hunter
