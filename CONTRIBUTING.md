# Contributing to SageRoute

Thanks for helping make SageRoute sharper. This project is a trajectory-aware model router shipped as an OpenAI-compatible HTTP proxy, so changes should stay grounded in observable execution evidence and be easy to verify.

## Prerequisites

- Bun 1.1 or newer. The current local test run used Bun 1.3.8.
- A shell with standard Unix tools.
- Optional: `SAGE_API_KEY` for the live end-to-end proof against the Levanto Sage API.

## Setup

Install dependencies:

```sh
bun install
```

Validate the example config with dummy secrets:

```sh
OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy SAGE_API_KEY=dummy bun run src/cli.ts check --config sageroute.config.example.json
```

Run the proxy with a config:

```sh
bun run src/cli.ts serve --config sageroute.config.example.json
```

The CLI also supports `--port <n>`, `--host <addr>`, `-h`, and `--help`. If `--config` is omitted, the CLI reads `$SAGEROUTE_CONFIG` and then falls back to `./sageroute.config.json`.

## Verification

Run the test suite:

```sh
bun test tests/
```

Run the TypeScript typecheck:

```sh
bun run typecheck
```

Run the live end-to-end proof only when you have a real Sage key:

```sh
SAGE_API_KEY=lv_... bun run examples/live-e2e.ts
```

The live proof calls the real Levanto Sage API and can consume real Sage quota or balance. It boots a local stub upstream and a local SageRoute proxy, then proves that failing trajectories can route to the strong model while healthy trajectories stay cheap.

## Project Layout

Core routing logic lives in `src/core`:

- `evidence.ts`: recovers trajectory steps from `/v1/responses` input, pairs tool calls to outputs by `call_id`, classifies failures, and builds digests and previews.
- `signals.ts`: computes deterministic signals such as loop detection, error rates, failed verifications, rewrite/retest cycles, budget burn, and the compact evidence string sent to Sage.
- `sage.ts`: implements the Levanto Sage HTTP client and deterministic offline stub.
- `policy.ts`: converts the two-stage Sage verdict into stable actions with local guardrails.
- `session.ts`: tracks per-session tier, turns, cost ledger, switches, restarts, escalation state, and routing history.
- `router.ts`: decides the model for one inbound Responses turn and rewrites routed request bodies.
- `types.ts`: defines SageRoute config, actions, defaults, and resolved config shape.
- `resolve.ts`: validates SageRoute config and checks whether an inbound model id matches the alias.
- `index.ts`: exports the public core API used by the proxy.

Proxy and CLI code lives in `src/proxy` and `src/cli.ts`:

- `config.ts`: loads JSON config, resolves `${VAR}`, `$VAR`, and `env:VAR` secrets, validates providers, applies defaults, and rejects private-network upstreams unless `allowPrivateNetwork: true`.
- `upstream.ts`: dispatches routed turns to Responses or Chat Completions upstreams, translates between wire formats when needed, and tees SSE streams to meter usage.
- `server.ts`: implements `SageRouteProxy.handle()`, auth, `/health`, `/v1/models`, `/v1/sageroute/sessions`, `/v1/responses`, and `/v1/chat/completions`.
- `cli.ts`: implements `sageroute serve` and `sageroute check`.

Tests live in `tests/`. `examples/live-e2e.ts` is the live proof against the real Sage API and should not run in CI.

## Code Style

- Use 2-space indentation.
- Use double-quoted strings.
- Keep trailing commas where the existing code uses them.
- Add explicit return types on exported functions.
- Keep committed text ASCII-only.
- Write comments to explain why a block exists, not what each line mechanically does.

## Decision Policy Changes

The sensitive part of SageRoute is `src/core/policy.ts`. Changes there affect when the router spends more money, restarts a run, or asks for human review. Policy changes need focused tests, and ideally evidence from `examples/live-e2e.ts` when the behavior depends on the real Sage API.

## Submitting a Pull Request

Before opening a PR:

1. Keep the change scoped to one behavior or documentation update.
2. Run `bun run typecheck`.
3. Run `bun test tests/`.
4. Add or update tests for behavior changes.
5. Do not commit secrets. Use `${VAR}` indirection in configs and redact tokens in logs.
6. Fill out the PR template, including the verification commands you ran.
