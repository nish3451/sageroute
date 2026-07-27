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
- 84 tests across core routing, signals, evidence, sessions, config, upstream dispatch, the Anthropic adapter, and proxy endpoints.

### Changed

- Provider `authMode` now defaults to `auto`, which keeps resolved API keys on key auth and otherwise uses subscription OAuth for keyless Anthropic providers and keyless OpenAI providers pointed at the ChatGPT Codex backend. `authMode` accepts `auto`, `key`, or `oauth`.
- `sageroute check` now annotates each ladder tier with the credential it will actually use: `[oauth subscription]`, `[api key]`, or `[no credential]`.
