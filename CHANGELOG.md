# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [0.1.0] - 2026-07-27

### Added

- Initial trajectory-aware routing engine for the `sageroute` model alias.
- Two-stage Sage gate using intervention detection followed by action selection.
- Guardrails for local budget stops, capability-before-retry, asymmetric hysteresis, one-way ladder behavior, and fail-open Sage outages.
- OpenAI-compatible proxy with Responses routing and Chat Completions passthrough and adapter support.
- Provider support for OpenAI, Anthropic, xAI, and Kimi (Moonshot) through three upstream adapters: `openai-responses`, `openai-chat`, and `anthropic-messages`.
- OAuth-backed provider authentication for ChatGPT Plus/Pro and Claude Pro/Max subscriptions, including `sageroute auth login`, `sageroute auth logout`, `sageroute auth status`, secure local credential storage, automatic refresh, and vendor-specific request shaping.
- Native Anthropic Messages adapter handling top-level `system`, required `max_tokens`, tool calls and results as content blocks, consecutive same-role message merging, and the typed streaming event protocol.
- Streaming usage metering through SSE stream teeing, including Anthropic token counts split across the `message_start` and `message_delta` frames.
- Session tracking, routing history, and cost ledger.
- `sageroute serve` and `sageroute check` CLI commands.
- `sageroute init` command that detects existing subscription logins and API keys, writes a config valid for the current machine, validates it immediately, and prints the resulting ladder plus the next command to run. Refuses to overwrite an existing config without `--force`.
- First-run bootstrap in `sageroute serve`: with no config at the resolved path, the same generator `init` uses writes one, validates it, prints the ladder, and continues into the listener. An existing config is never overwritten, and a generated config that still needs a credential exits `1` with the missing variable named rather than listening in a state that would fail on the first request.
- `sageroute auth import [provider]` adopts subscription logins other CLIs already completed on this machine, reading `~/.codex/auth.json` and `~/.claude/.credentials.json`. Source files are only ever read, never written, so no new grant is created and revoking the original tool's login revokes this one too. This is the only path that works headless, where the browser flow cannot run.
- `examples/live-subscription.ts`, the first example that forwards to a real vendor instead of a stub upstream and returns genuine model output.

### Fixed

- ChatGPT subscription turns are now forced to `stream: true` upstream. The backend rejects a non-streaming body with `400 Stream must be set to true`, and a forced stream is reassembled into a single JSON object when the caller asked for one. Keyed providers are untouched.
- Streamed replies from the ChatGPT backend arrive with **no** `content-type` header, so sniffing the header alone misclassified an SSE body as JSON and returned an empty object. Detection now trusts the forced-stream decision over the missing header.
- Output items are recovered from `response.output_item.done` frames. The backend's terminal `response.completed` frame carries an empty `output` array, so trusting it alone dropped the assistant's answer and made a real reply look like a successful empty one.
- Hand-authored light and dark architecture diagrams in `docs/assets/`, embedded in the README through a `<picture>` element so both color schemes render on GitHub.
- 120 tests across core routing, signals, evidence, sessions, config, config scaffolding, upstream dispatch, OAuth PKCE, the Anthropic adapter, and proxy endpoints.

### Changed

- Provider `authMode` now defaults to `auto`, which keeps resolved API keys on key auth and otherwise uses subscription OAuth for keyless Anthropic providers and keyless OpenAI providers pointed at the ChatGPT Codex backend. `authMode` accepts `auto`, `key`, or `oauth`.
- `sageroute check` now annotates each ladder tier with the credential it will actually use: `[oauth subscription]`, `[api key]`, or `[no credential]`.
