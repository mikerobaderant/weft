# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Weft is

A programming language for AI systems. Programs are typed graphs of nodes (LLM, HTTP, Human Query, Postgres, Discord, etc.) compiled and executed durably on top of [Restate](https://restate.dev). Projects are written in a small DSL (`.weft`) and have two native views — code and graph — that stay in sync.

Read `DESIGN.md` before making architectural changes. Also read `.claude/CLAUDE.md` for working-style rules (modes, voice, the "no em dashes" rule, etc.).

## Commands

```bash
./dev.sh server           # Backend: Postgres + Restate + orchestrator + weft-api + node-runner (+ kind cluster if INFRASTRUCTURE_TARGET=local)
./dev.sh dashboard        # SvelteKit dev server
./dev.sh all              # Both (server in background)
./dev.sh extension        # Build browser extension (WXT)

./cleanup.sh              # Stop everything, wipe Restate data + DB
./cleanup.sh --no-db      # Stop, keep DB
./cleanup.sh --services   # Just stop running services

cargo build               # No DB needed — .sqlx is committed
cargo test                # Same
cargo test -p weft-core   # Single crate
cargo test <name>         # Single test by substring
cargo clippy
pnpm -C dashboard check   # Svelte type check
pnpm -C dashboard lint
```

Dashboard dev port is **5174** (not the 5173 the README mentions — `dashboard/package.json` overrides via `vite dev --port 5174`). Weft API is `3000`. Default Restate ports are `8080` (ingress) and `9070` (admin); set `RESTATE_PORT` / `RESTATE_ADMIN_PORT` in `.env` if something else is holding 8080 — code in `crates/weft-api/src/state.rs` already recognises the `8180`/`9170` alternate pair.

All API keys in `.env` are optional. Nodes surface a clear error at runtime if a missing key is needed.

### LLM providers

`LlmConfig` has a `provider` field (`openrouter` | `bedrock`, default `openrouter`):

- **OpenRouter** uses `OPENROUTER_API_KEY` (or a BYOK key in the `apiKey` field) and routes through `minillmlib`.
- **Bedrock** uses the default AWS credential chain (env vars, `~/.aws/credentials`, SSO, IAM role). The `apiKey` field is ignored. The `model` field takes a Bedrock model ID or inference profile ID (e.g. `us.anthropic.claude-sonnet-4-20250514-v1:0`). Pricing table lives in `crates/weft-nodes/src/bedrock.rs::pricing` — add an entry when you enable a new model.

Cost reporting is identical for both paths: `usage_events` rows with `subtype = "llm"` and token counts + USD cost.

## Architecture

### The catalog is the source of truth

Every node lives in `catalog/<category>/<name>/` as two files: `backend.rs` (Rust `Node` trait impl) and `frontend.ts` (dashboard template). `scripts/catalog-link.sh` (run by `dev.sh`) symlinks these into `crates/weft-nodes/src/catalog/` and `dashboard/src/lib/nodes/`. The `inventory` crate auto-discovers every registered node at startup via `register_node!`. **Never edit the symlinked copies — edit the originals under `catalog/`.**

### Service topology (all one process tree under `./dev.sh server`)

```
dashboard (5174) ──HTTP──► weft-api (3000) ──RPC──► Restate ingress (8080)
                                                          │
                                                          ▼
                                                  orchestrator (9080 Restate services, 9081 Axum)
                                                          │ dispatches by node type
                                                          ▼
                                                  node-runner (9082, handles all node types)
```

- **Restate** is the durable executor. It persists service invocations so a program can survive crashes and resume mid-flow (e.g. a Human Query waiting 3 days).
- **`orchestrator`** (`crates/weft-orchestrator/`) exposes three Restate services: `NodeInstanceRegistry`, `TaskRegistry`, `InfrastructureManager`. It's registered as a deployment with Restate on startup (`restate deployments register http://localhost:9080`).
- **`node-runner`** (`crates/weft-nodes/src/bin/node_runner.rs`) is a separate process that registers itself with orchestrator via `NodeInstanceRegistry/register`, then receives HTTP callbacks to execute individual node invocations. One runner can claim a subset of node types via the `NODE_TYPES` env var, or handle all of them (default).
- **`weft-api`** (`crates/weft-api/`) is the plain REST surface the dashboard talks to — projects, triggers, files, infra provisioning, usage events.

### The core crate

`crates/weft-core/` holds the language itself: parser, type system (generics, unions, null propagation), edge resolution, group folding, parallel execution planning. Touch this last — changes here affect every user project silently. Tests live in `crates/weft-core/src/tests/`.

### How a node runs end to end

1. User triggers a project via dashboard → `weft-api` → Restate invocation on orchestrator.
2. Orchestrator walks the compiled graph, and for each node calls `NodeInstanceRegistry` to pick a runner that handles that node type.
3. Orchestrator POSTs to the runner's Axum endpoint (`http://localhost:9082/execute`) with the `ExecutionContext` (input ports, config, node/project/execution IDs).
4. Runner's `Node::execute` returns a `NodeResult`. Cost (if any) is reported back via `ExecutionContext::tracked_ai_context` → `weft-api`'s `/api/v1/usage/events`.

### Infrastructure nodes (stateful workloads)

Nodes like Postgres Database or WhatsApp Bridge provision real Kubernetes resources. They don't just `execute` — their `NodeFeatures` carries an `InfrastructureSpec` (K8s manifests with `__INSTANCE_ID__` / `__SIDECAR_IMAGE__` placeholders). The platform provisions them into the local `kind` cluster (`weft-local`) and polls `/health` before consuming `/outputs` for runtime values.

Each infra node ships with a paired sidecar under `sidecars/<name>/` (which is itself a symlink into `catalog/.../sidecar/`). Sidecar HTTP contract: `POST /action`, `GET /health`, `GET /outputs`. Consumer nodes (e.g. `MemoryQuery`) take an `endpointUrl` input and call `/action` via `InfraClient`.

`dev.sh` auto-builds every sidecar's Docker image at boot, hashes sources to skip unchanged ones, and `kind load`s the image into the cluster. Sidecars auto-restart if the image hash changes.

## Adding a node

Two files under `catalog/<category>/<name>/`. Backend and frontend port names + types must match exactly. `inventory` picks up the backend on next `cargo build`; dashboard picks up the frontend on next reload. Full walkthrough in `CONTRIBUTING.md`.

Design rules (from `DESIGN.md`, summarised): no special cases, typed end-to-end (no `Any`), one capability per node, fail loudly (no silent fallbacks).

## Dashboard

SvelteKit + Svelte 5 with runes (`$state`, `$derived`, `$effect`) — no legacy reactive statements. Types live in `$lib/types`; don't duplicate. The frontend parser in `$lib/parser` must stay in lockstep with the Rust parser in `crates/weft-core/` until the frontend parser is retired (see `ROADMAP.md`).

## What not to do

- Don't add a new primitive type to the language without discussion.
- Don't add a quick fix that bypasses the type checker.
- Don't add silent fallbacks — fail loud.
- Don't edit symlinked copies of catalog nodes; edit `catalog/` originals.
- Don't duplicate interfaces between dashboard and types module.
