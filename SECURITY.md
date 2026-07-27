# Security Policy

## Supported Versions

SageRoute is currently pre-1.0. Security fixes are provided for the latest released version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately. Use GitHub private security advisories if they are enabled for this repository, or email email@email.com.

Include the affected version or commit, a description of the impact, reproduction steps, and any relevant redacted config or request details. Do not post exploitable reports publicly until a fix is available.

## Security Model

SageRoute is an HTTP proxy in front of paid model providers. It handles provider API keys, applies routing decisions, and forwards routed or passthrough requests upstream. Treat the machine, container, and network where it runs as part of the trusted boundary.

Store provider keys, `SAGE_API_KEY`, and any `authToken` in environment variables. Config files support `${VAR}`, `$VAR`, and `env:VAR` indirection. Do not commit real secrets in `sageroute.config.json`, examples, logs, issue reports, or tests.

`src/proxy/config.ts` validates upstream `baseUrl` values and refuses loopback, link-local, and RFC1918 private-network hosts unless a provider explicitly sets `allowPrivateNetwork: true`. This guard reduces SSRF risk because the proxy forwards credentials to upstreams.

If `authToken` is configured, clients must send it as a bearer token in the `Authorization` header. Without `authToken`, SageRoute trusts the network boundary around the proxy.

The decision request sent to Sage is reduced evidence, not a raw transcript. `src/core/evidence.ts` converts tool calls and outputs into digests, bounded previews, success flags, and error classes. `src/core/signals.ts` renders counts, loop signals, verification state, budget burn, recent action summaries, and the first task goal. Raw reasoning items and raw chain-of-thought are not sent as evidence, but short previews of tool arguments, tool outputs, recent actions, and the task goal can be included. Do not put secrets in prompts, tool arguments, tool outputs, or logs.
