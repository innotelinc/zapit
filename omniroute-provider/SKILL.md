---
name: omniroute-provider
description: Switch Claude Code's model provider to a self-hosted OmniRoute gateway so it uses the user's own models instead of Anthropic's API, and switch back when needed. Asks for the OmniRoute host/URL rather than assuming one. Trigger this whenever the user asks to "use OmniRoute", "point Claude Code at my models", "switch to my local/self-hosted models", "use innotel models in Claude Code", or asks to check/undo that provider switch.
---

# OmniRoute Provider Switch

Claude Code reads its model-provider settings from `env` values in a
`settings.json` file. Pointing `ANTHROPIC_BASE_URL` (and, if OmniRoute
requires one, `ANTHROPIC_AUTH_TOKEN`) at OmniRoute makes Claude Code send
its requests there instead of to `api.anthropic.com`.

This skill wraps that edit in three scripts so it's a one-liner instead of
hand-editing JSON, and so there's always a backup to roll back to.

## Important assumption to flag to the user

Claude Code's Anthropic-compatible provider path expects an endpoint that
speaks the **Anthropic Messages API** (`POST {base_url}/v1/messages`). If
OmniRoute's `/v1` endpoint is only **OpenAI-compatible**
(`/v1/chat/completions`), Claude Code will not work against it directly —
OmniRoute would need an Anthropic-Messages-shaped route in front of the
same models (some routers/gateways expose both). If enabling the switch
below produces errors or garbled responses, that's the first thing to
check on the OmniRoute side.

## Scripts

- `scripts/enable.sh` — points Claude Code at OmniRoute. Backs up the
  existing `~/.claude/settings.json` first (or the project's
  `.claude/settings.json`, see Scope below), then sets:
  - `ANTHROPIC_BASE_URL` → OmniRoute's URL. **Not hardcoded** — if
    `OMNIROUTE_BASE_URL` isn't set in the environment, the script prompts
    for it interactively (e.g. `http://192.168.1.46:20128/v1`). If you're
    running this on the user's behalf non-interactively, ask the user for
    their OmniRoute host/port first and pass it as `OMNIROUTE_BASE_URL`.
  - `ANTHROPIC_AUTH_TOKEN` → a token/key, if OmniRoute requires one
    (default is a placeholder `local`; ask the user if OmniRoute needs
    real auth)
  - `ANTHROPIC_MODEL` → optionally pin a specific model/combo name the
    gateway exposes (e.g. `auto/coding`). **Strongly recommended** when
    pointing at a gateway: Claude Code's stock default model name can route
    to an upstream with no working credentials (observed live: HTTP 402
    "Insufficient credits" for `claude-opus-5` via an OpenRouter upstream),
    so the very first message fails until a working default is pinned.
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` → written alongside `ANTHROPIC_MODEL`
    so Claude Code knows the gateway model's real context window instead of
    assuming 200k and auto-compacting early. Defaults to `1048576` when a
    model is pinned; override with `OMNIROUTE_CONTEXT_TOKENS`, or set it
    empty to skip writing the key.

- `scripts/disable.sh` — removes those four keys again so Claude Code
  falls back to the standard Anthropic API. Leaves every other setting in
  the file untouched.

- `scripts/selftest.sh` — offline self-test for the other three scripts
  (asserts the enable → status → disable round-trip on a throwaway
  settings file). CI runs this on every change to the skill; run it
  locally with `bash scripts/selftest.sh` before editing, add `--online`
  to also probe a live gateway.

- `scripts/status.sh` — prints what's currently configured, including the
  pinned model and context-window setting. For the
  reachability check it uses, in order: `OMNIROUTE_BASE_URL` if set, else
  whatever `ANTHROPIC_BASE_URL` is already in the settings file, else
  prompts for a host.

All three take the target file as `$1` (default `~/.claude/settings.json`)
so the same scripts work for a global switch or a single-project switch.

## Usage

**Turn OmniRoute on (global, all projects) — will prompt for the host:**
```bash
bash scripts/enable.sh
```

**Turn it on non-interactively (e.g. scripted by Claude Code itself),
by supplying the host up front:**
```bash
OMNIROUTE_BASE_URL="http://192.168.1.46:20128/v1" bash scripts/enable.sh
```

**Turn it on for just the current project** (so other projects keep
using Anthropic's API):
```bash
bash scripts/enable.sh .claude/settings.json
```

**Pin a specific OmniRoute model as the default** (recommended — pick one
verified against the `/v1/messages` route with curl first):
```bash
OMNIROUTE_MODEL="your-model-name" bash scripts/enable.sh
```

**Pin a model and declare its context window explicitly:**
```bash
OMNIROUTE_MODEL="auto/coding" OMNIROUTE_CONTEXT_TOKENS=1000000 \
  bash scripts/enable.sh
```

**Check current state:**
```bash
bash scripts/status.sh
```

**Revert to Anthropic's API:**
```bash
bash scripts/disable.sh
```

## After enabling

Tell the user to fully restart any running `claude` sessions/terminals —
Claude Code reads `env` from `settings.json` at startup, so an
already-running session won't pick up the change. `scripts/status.sh`'s
`curl` check only confirms OmniRoute is reachable on the network, not
that it understands the Anthropic Messages format — the real test is
starting `claude` and sending one message.

If the user's OmniRoute setup needs no auth at all, that's fine —
`ANTHROPIC_AUTH_TOKEN` is written as `local` by default since Claude Code
expects *some* non-empty token to be present; it's simply ignored by
gateways that don't check it.

## Gateway gotchas learned the hard way

- **Base URL shape:** OmniRoute expects the base URL to *include* `/v1`
  (e.g. `http://192.168.1.46:20128/v1`); Claude Code then appends
  `/v1/messages` itself, and the gateway resolves the resulting doubled
  `/v1/v1/messages` path internally. `POST {host}/v1/v1/messages`
  returning 200 is the quickest curl probe that a base URL is correct.
- **Prefer `auto/*` combo models as defaults.** Bare upstream model names
  can be rejected ("Ambiguous model") or route to dead upstreams. Probe
  with curl before pinning — a 200 on `/v1/messages` with a real
  completion beats any catalog listing.
- **Unknown-model notice:** pinning a gateway model makes Claude Code log
  a cosmetic `[claude-code:unrecognized_model]` notice when generating
  session titles. It doesn't affect requests; the earlier
  "assumed 200k context window" warning is silenced by setting
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
- **Codex needs `wire_api = "responses"`.** Modern Codex CLI versions
  hard-error on `wire_api = "chat"`, and OmniRoute translates
  `/v1/responses` natively. A working Codex config needs:
  `openai_base_url = "http://<host>:20128/v1"`, default
  `model = "auto/coding"`, and a `[model_providers.omniroute]` block with
  `wire_api = "responses"` + `requires_openai_auth = true`. Generate
  per-model profiles with `omniroute setup-codex --remote
  http://<host>:20128 --api-key sk-...`. Key for Codex comes from
  `~/.codex/auth.json` (`auth_mode: apikey` + `OPENAI_API_KEY`); set
  `env_key = "OPENAI_API_KEY"` if you want the environment variable to
  supply it instead.
