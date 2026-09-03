<div align="center">

# ⚡ zapit

**Zap files between your devices in real time — drag & drop, no accounts, no uploads to disk.**

<img src="zapit/docs/logo.svg" alt="ZAPIT — golden lightning bolt" width="420" />

[![CI](https://github.com/innotelinc/zapit/actions/workflows/docker.yml/badge.svg)](https://github.com/innotelinc/zapit/actions/workflows/docker.yml)
[![Latest release](https://img.shields.io/github/v/release/innotelinc/zapit)](https://github.com/innotelinc/zapit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Open the same URL on two devices (or scan the QR), type the same room code, and drop
files. They stream **device-to-device over WebRTC** when possible, with an automatic
**server-relay fallback**, so it works on your LAN and across the internet.

</div>

## About

zapit is the ecosystem's **TransferOps** edge utility — ephemeral, peer-to-peer file
transfer with no storage layer. Files never touch a server's disk: the room code is
the password, codes auto-expire, and everything vanishes when the tab closes. Try the
[public instance](https://zapit.innotel.us), or browse the
[landing page](https://innotelinc.github.io/zapit/) for the full picture.

## ✨ Highlights

- **Zero login by default** — the room code is the "password"; codes auto-expire and rotate
- **Peer-to-peer** via WebRTC data channels (files never touch the server's disk)
- **Relay fallback** through the server when NATs/UDP block direct paths
- **Multi-file & folder drops arrive as one ZIP**, assembled in the browser (zero deps)
- **Zings** — text snippets, links, code, anything — zapped alongside files
- **Optional Authentik SSO** (OIDC + PKCE) with an admin kill-switch to flip login on/off
- **Customizable QR code** of your LAN address for one-scan phone pairing — point it at any
  link address with `QR_URL`
- Single Node process, two runtime dependencies, ~zero config
- **Docker-ready** — non-root image, healthcheck, multi-arch builds published to GHCR by CI
  (tests gate every build: protocol suite + a browser simulation driving the real UI)
- **One-click Authentik blueprint** — zapit generates the provider YAML for you at
  `/api/authentik/blueprint`, or mount the static one in `zapit/authentik/blueprint.yaml`

## 🚀 Quick start

```bash
cd zapit
npm install
ADMIN_PASSWORD=your-secret npm start   # → http://localhost:5150
```

Or with Docker:

```bash
cd zapit
ADMIN_PASSWORD=your-secret docker compose up -d --build
```

Full documentation — Authentik setup, env vars, the admin panel, CI, and tests — lives in
[`zapit/README.md`](zapit/README.md).

## 📚 Documentation

- [`zapit/README.md`](zapit/README.md) — full app documentation (Authentik, env, admin, CI, tests)
- [`deploy/README.md`](deploy/README.md) — production deployment (`zapit.innotel.us`)
- [`docs/stack.md`](docs/stack.md) — platform role in the Innotel Platform Stack (TransferOps)

## 🏛️ Platform stack

zapit is the ecosystem's **TransferOps** edge utility — ephemeral device-to-device transfer
in the [**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity, Infisical owns
secrets, Cerulean owns trust, ONYX owns storage, Magnate owns revenue, and every other
platform is a business function that consumes them. zapit explicitly does **not** own
storage (ONYX), identity (Authentik), or billing (Magnate). See
[docs/stack.md](docs/stack.md) for its owns/consumes boundaries and Infisical secret setup.

## Public instance

A public deployment runs at **[https://zapit.innotel.us](https://zapit.innotel.us)** —
scan its QR from your phone and start zapping.

## Repository layout

```
.github/workflows/docker.yml   CI: test → build → push to GHCR (amd64/arm64)
.github/dependabot.yml         Weekly action + npm dependency updates
zapit/                         The app: server, UI, Dockerfile, tests, docs
```

## About

**Darnel Hunter** — [dhunter@innotel.us](mailto:dhunter@innotel.us)

Author and maintainer of zapit. Building small, sharp tools that respect privacy:
no accounts, no tracking, files that go directly from device to device and vanish when
the tab closes. If you find zapit useful, contributions and bug reports are welcome —
open an issue or a PR.

## License

[MIT](LICENSE) © Darnel Hunter