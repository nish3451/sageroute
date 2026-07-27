# Configuration

SageRoute reads a JSON config file through `loadConfigFile()`, validates it with `proxyConfigIssues()`, then applies defaults with `prepareConfig()` and `resolveSageRouteConfig()`.

The CLI default config path is `./sageroute.config.json`, unless `SAGEROUTE_CONFIG` is set or `--config <path>` is passed.

There is no required setup step before `serve`. If the config path does not exist, `serve`
generates a config from the credentials on the machine, validates it, prints the ladder,
and continues into the listener. `sageroute init` runs the same generator explicitly when
you want to inspect or edit the file before booting.

Bun loads a `.env` file from the working directory automatically, so `SAGE_API_KEY` and
any provider keys can live there instead of being re-exported in every shell. `.env` is
gitignored; `.env.example` documents the variables.

## Generating A Config With `init`

`sageroute init` writes a config built around the credentials that already exist on the
machine, so the first run either works or names a real problem instead of failing on a
placeholder. It never invents a provider you cannot authenticate against.

```bash
sageroute init [--config <path>] [--force]
```

Detection runs in `planInit()` in `src/init.ts` and prefers a subscription login over an
API key, because a subscription turn is the cheaper way to pay for the same work:

| Detected | Cheap tier | Strong tier |
| --- | --- | --- |
| ChatGPT and Claude logins | `openai/gpt-5.4-mini` | `anthropic/claude-sonnet-4-5-20250929` |
| Claude login only | `anthropic/claude-haiku-4-5-20251001` | `anthropic/claude-sonnet-4-5-20250929` |
| ChatGPT login only | `openai/gpt-5.4-mini` | `openai/gpt-5.6-sol` |
| `OPENAI_API_KEY` only | `openai/gpt-4.1-mini` | `openai/gpt-4.1` |
| `ANTHROPIC_API_KEY` only | `anthropic/claude-haiku-4-5-20251001` | `anthropic/claude-sonnet-4-5-20250929` |
| Nothing | `openai/gpt-4.1-mini` | `openai/gpt-4.1` |

Notes on the generated file:

- An OpenAI provider backed by a subscription login is pinned to `https://chatgpt.com/backend-api/codex`. Subscription tokens are rejected by `https://api.openai.com/v1`.
- Subscription tiers are written with `inputPerMTok` and `outputPerMTok` of `0`, since a subscription turn is not separately metered. Set real rates if you want the budget guardrail to bite.
- API-key tiers carry list prices that drift. Correct them against your own billing.
- `apiKey` is written as `${SAGE_API_KEY}` / `${OPENAI_API_KEY}` indirection, never a literal secret.
- With no credentials detected, an `OPENAI_API_KEY` config is still written as a starting point and the CLI prints the exact commands needed to make it valid.

`init` refuses to overwrite an existing config and exits `1` unless `--force` is passed.
After writing, it immediately loads the file through the same validator as `check`, so the
ladder and the credential each tier resolves to are printed before you ever run `serve`.

`serve`'s first-run bootstrap uses the same code path, so a generated config is identical
either way. The bootstrap only triggers when the file is absent: an existing config that
fails validation is still a hard error, because silently overwriting a config someone
edited would be worse than refusing to start. When a generated config still needs a
credential, `serve` prints what is missing and exits `1` rather than listening in a state
that would fail on the first request.

## Top-Level `ProxyConfig`

| Field | Type | Default | What it controls |
| --- | --- | --- | --- |
| `port` | `number` | `8787` when omitted | Listen port used by `sageroute serve`. Must be an integer from `0` to `65535` if present. |
| `hostname` | `string` | `"127.0.0.1"` when omitted or blank | Bind address used by `sageroute serve`. There is no dedicated validator for hostname beyond the defaulting behavior in `prepareConfig()`. |
| `authToken` | `string \| undefined` | `null` after resolution | Optional bearer token clients must send as `Authorization: Bearer <token>`. Supports secret indirection. If it resolves to no value, auth is disabled. |
| `providers` | `Record<string, ProviderConfig>` | Required | Named upstream providers. Provider names are also used in concrete model refs like `openai/gpt-4.1-mini`. |
| `sageRoute` | `SageRouteConfig` | Required | The routing ladder and Sage decision settings. The proxy requires this object because this proxy exists to route. |

## `ProviderConfig`

| Field | Type | Default | What it controls |
| --- | --- | --- | --- |
| `adapter` | `"openai-responses" \| "openai-chat" \| "anthropic-messages"` | `"openai-responses"` | Wire format used for this provider. `openai-responses` sends to `/responses`, `openai-chat` sends to `/chat/completions`, and `anthropic-messages` sends to `/messages`. Non-Responses adapters convert provider input/output back to the Responses shape. |
| `baseUrl` | `string` | Required | Provider base URL including the version segment, for example `https://api.openai.com/v1`. |
| `apiKey` | `string \| undefined` | `null` when omitted at dispatch time | Optional provider key. Supports secret indirection. In `authMode: "auto"`, a key is used only when it resolves to a real value. |
| `authMode` | `"auto" \| "key" \| "oauth" \| undefined` | `"auto"` | Selects credential source. `auto` uses a resolved `apiKey` first, otherwise uses a stored subscription login when that provider supports OAuth and the base URL can accept it, otherwise stays on keys. `key` forces `apiKey`; `oauth` forces a stored login from `~/.sageroute/auth.json`. |
| `oauthProvider` | `"openai" \| "anthropic" \| undefined` | The provider's config key | Stored login to use when OAuth is selected. A provider named `openai` or `anthropic` needs no extra wiring. Use this when the config key is different, for example `"chatgpt": { "oauthProvider": "openai" }`. |
| `headers` | `Record<string, string> \| undefined` | `{}` | Extra headers merged into every upstream request. `dispatchUpstream()` also sets `Content-Type: application/json`. In key auth, `anthropic-messages` sends a resolved API key as `x-api-key` and sets `anthropic-version`; other adapters send it as `Authorization: Bearer <key>`. |
| `models` | `string[] \| undefined` | `[]` for `/v1/models` output and bare-model lookup | Cosmetic model list advertised by `/v1/models`. Routing uses the SageRoute ladder, not this list. For passthrough requests, a bare model id can resolve through this list when multiple providers exist. |
| `allowPrivateNetwork` | `boolean \| undefined` | Private-network URLs are refused unless this is `true` | Allows loopback and RFC1918 upstream `baseUrl` hosts. This guard exists because a credential-forwarding proxy can become an SSRF primitive. |
| `timeoutMs` | `number \| undefined` | `600000` | Upstream request timeout in milliseconds. This default is in `src/proxy/upstream.ts` because agent turns can be long. There is no provider-level range validator in `proxyConfigIssues()`. |

`authMode: "auto"` is the default. It preserves existing keyed configs because a configured `apiKey` that resolves to a real value wins over a subscription login. If no usable key is present, `anthropic` uses OAuth, and `openai` uses OAuth only when its `baseUrl` can accept a ChatGPT subscription token. Providers without a login flow, such as `xai` and `kimi`, stay on keys. An OpenAI provider whose `baseUrl` points at `api.openai.com` also stays on keys because a ChatGPT subscription token is only accepted at `https://chatgpt.com/backend-api/codex`.

In explicit `authMode: "oauth"`, do not set `apiKey`. Validation rejects that combination with `apiKey is not used when authMode is "oauth"; remove it to avoid ambiguity`. In `authMode: "auto"`, setting both is valid because the precedence is defined.

OAuth logins are stored at `~/.sageroute/auth.json`. The store directory is written with `0700` permissions and the file with `0600`. Access tokens refresh automatically five minutes before expiry, and concurrent refreshes for the same provider share one refresh request. If credentials are missing or cannot refresh, the proxy returns HTTP 401 with the exact `sageroute auth login <provider>` command and does not call upstream.

Supported login providers are `openai` and `anthropic`.

```bash
sageroute auth login openai
sageroute auth login anthropic
sageroute auth logout openai
sageroute auth logout anthropic
sageroute auth status
```

A subscription OAuth token is not a general API credential. It is issued to a specific first-party client, and the vendor validates the request shape as well as the token:

- OpenAI subscription tokens are for the ChatGPT Codex backend. Set `baseUrl` to `https://chatgpt.com/backend-api/codex`. SageRoute sends bearer auth, `ChatGPT-Account-Id` when it was present in the login, an originator header, and a session id. It also pins `store: false` and strips stored item `id` fields from Responses input while preserving `call_id`, because `call_id` is what pairs tool calls to tool outputs for the evidence layer.
- Anthropic subscription tokens are scoped to Claude Code. SageRoute sends bearer auth instead of `x-api-key`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, Claude Code fingerprint headers, `X-Claude-Code-Session-Id`, and `x-client-request-id`. It also makes the first system block exactly `You are a Claude agent, built on Anthropic's Claude Agent SDK.`. If the caller supplied a system prompt, it is preserved as a later system block.

OAuth verification status: the flows were verified against the vendors' documented protocols and end to end against stub vendor servers over real sockets, including the credential store, expiry/refresh behavior, and exact on-the-wire request shaping. A real interactive `auth login` against live ChatGPT or Anthropic servers has not been executed in this environment. Subscription terms of service are the user's responsibility.

## `SageRouteConfig`

| Field | Type | Default | What it controls |
| --- | --- | --- | --- |
| `enabled` | `boolean \| undefined` | Enabled unless explicitly `false`, as long as `cheap` and `strong` exist | Master switch for alias resolution. When `false`, the alias stops resolving and normal routing applies. Validation still checks the `sageRoute` object. |
| `alias` | `string \| undefined` | `"sageroute"` | Public model id clients request to activate trajectory routing. |
| `cheap` | `SageRouteTier` | Required | Starting tier for every session. |
| `strong` | `SageRouteTier` | Required | Escalation tier for struggling sessions. Must differ from `cheap`. |
| `endpoint` | `string \| undefined` | `"https://sage.levanto.ai"` | Sage decision API base URL. `resolveSageRouteConfig()` trims trailing slashes, and `HttpSageClient` posts to `${endpoint}/decide`. |
| `apiKey` | `string \| undefined` | `null` after secret resolution | Sage API key. Supports secret indirection. If missing or unresolved, `clientFor()` uses `OfflineSageClient`. |
| `checkpointEvery` | `number \| undefined` | `3` | Turns between Sage consultations. Must be an integer from `1` to `100` if present. |
| `firstCheckpointAt` | `number \| undefined` | `3` | Minimum answered tool actions before Sage can be consulted. Must be an integer from `1` to `100` if present. |
| `interventionThreshold` | `number \| undefined` | `0.6` | Stage-one `yesno` gate. If `P(intervene)` is below this value, the action is `continue`. Must be a number from `0` to `1` if present. |
| `consecutiveBadRequired` | `number \| undefined` | `2` | Hysteresis for restarts and human escalation. Must be an integer from `1` to `10` if present. The first cheap-to-strong switch can fire after one bad checkpoint. |
| `maxSwitches` | `number \| undefined` | `1` | Cheap-to-strong switches allowed per session. Must be an integer from `0` to `10` if present. |
| `maxRestarts` | `number \| undefined` | `1` | Clean restarts allowed per session. Must be an integer from `0` to `10` if present. |
| `budgetUsd` | `number \| undefined` | `0` | Session spend cap in USD. `0` disables the budget rung. Must be a non-negative number if present. |
| `budgetEscalateFraction` | `number \| undefined` | `0.85` | Fraction of `budgetUsd` that triggers local `escalate_human` before any Sage call. Must be a number from `0` to `1` if present. |
| `offline` | `boolean \| undefined` | `false` | Uses the deterministic local decision stub instead of the Sage HTTP API when `true`. |
| `timeoutMs` | `number \| undefined` | `8000` | Sage HTTP timeout in milliseconds. Must be an integer from `250` to `120000` if present. |
| `escalateHumanMode` | `"notice" \| "continue" \| undefined` | `"notice"` | Wire behavior for `escalate_human`. `notice` returns a synthesized assistant message and stops the run. `continue` records the verdict but keeps the agent running on the strong tier. |

## `SageRouteTier`

| Field | Type | Default | What it controls |
| --- | --- | --- | --- |
| `provider` | `string` | Required | Name of a configured provider. |
| `model` | `string` | Required | Model id as the provider knows it. |
| `inputPerMTok` | `number \| undefined` | Cheap tier: `0.25`. Strong tier: `1.25` | USD per 1M input tokens for the session cost ledger. Must be non-negative if present. |
| `outputPerMTok` | `number \| undefined` | Cheap tier: `2.0`. Strong tier: `10.0` | USD per 1M output tokens for the session cost ledger. Must be non-negative if present. |

Pricing is used only by `addTurnCost()` after a completed turn reports usage. It is not passed to Sage and does not directly affect the decision except through accumulated `costUsd`, `budgetUsd`, and `budgetBurn`.

## Secret Indirection

`resolveSecret()` supports these forms anywhere the code calls it: provider `apiKey`, proxy `authToken`, and Sage `apiKey`.

| Form | Example | Resolution behavior |
| --- | --- | --- |
| Literal string | `"sk-live"` | Trims surrounding whitespace and returns the literal value. |
| Braced env | `"${OPENAI_API_KEY}"` | Reads `process.env.OPENAI_API_KEY`. |
| Bare env | `"$OPENAI_API_KEY"` | Reads `process.env.OPENAI_API_KEY`. |
| Prefixed env | `"env:OPENAI_API_KEY"` | Reads `process.env.OPENAI_API_KEY`. |
| Blank string | `"   "` | Resolves to `undefined`. |
| Missing env var | `"${MISSING}"` | Resolves to `undefined`. |

Environment variable names must match `[A-Za-z_][A-Za-z0-9_]*` for the indirection form to apply. A non-matching string is treated as a literal after trimming.

Provider `apiKey` values are validated only when that key is the credential `resolveAuthMode()` will actually use. Under `authMode: "auto"`, an unresolved provider key is tolerated if a subscription login can cover the tier. Sage `apiKey` and proxy `authToken` are resolved during `prepareConfig()` and can become `null`. A missing Sage key makes `clientFor()` choose the offline stub. A missing auth token disables bearer auth.

## Validation Rules

`proxyConfigIssues()` returns all issues at once.

| Path | Rule | Error message |
| --- | --- | --- |
| `(root)` | Config must be a JSON object. | `config must be a JSON object` |
| `port` | If present, must be an integer from `0` to `65535`. | `port must be an integer from 0 to 65535` |
| `providers` | Must be an object. | `providers must be an object of named providers` |
| `providers` | Must have at least one provider. | `at least one provider is required` |
| `providers.<name>` | Provider value must be an object. | `provider must be an object` |
| `providers.<name>.baseUrl` | Required. | `baseUrl is required` |
| `providers.<name>.baseUrl` | Must parse as a URL. | `baseUrl "<value>" is not a valid URL` |
| `providers.<name>.baseUrl` | Must use `http:` or `https:`. | `baseUrl must be http or https` |
| `providers.<name>.baseUrl` | Private hosts require `allowPrivateNetwork: true`. | `baseUrl "<hostname>" is a private address; set allowPrivateNetwork: true to permit it` |
| `providers.<name>.adapter` | If present, must be one of `openai-responses`, `openai-chat`, or `anthropic-messages`. | `adapter must be one of "openai-responses", "openai-chat", "anthropic-messages"` |
| `providers.<name>.authMode` | If present, must be `auto`, `key`, or `oauth`. | `authMode must be one of "auto", "key", "oauth"` |
| `providers.<name>.oauthProvider` | In explicit `authMode: "oauth"`, must name a supported login provider. Defaults to the provider name. | `no OAuth login flow for "<provider>"; supported: openai, anthropic. Set oauthProvider, or use authMode "key".` |
| `providers.<name>.apiKey` | Must be omitted in explicit `authMode: "oauth"`. | `apiKey is not used when authMode is "oauth"; remove it to avoid ambiguity` |
| `providers.<name>.baseUrl` | Explicit OpenAI OAuth cannot point at `api.openai.com`; ChatGPT subscription tokens require the ChatGPT Codex backend. | `a ChatGPT subscription token is not accepted at api.openai.com; set baseUrl to https://chatgpt.com/backend-api/codex, or use authMode "key" with an API key` |
| `providers.<name>.apiKey` | If it is the selected credential, it must resolve through `resolveSecret()`. | `apiKey references an environment variable that is not set: <value>` |
| `sageRoute` | Required. | `sageRoute is required; this proxy exists to route` |

Private hosts matched by the guard are `localhost`, `127.*`, `0.0.0.0`, `10.*`, `192.168.*`, `169.254.*`, `::1`, and `172.16.*` through `172.31.*`.

`sageRouteConfigIssues()` validates the nested routing config:

| Path under `sageRoute` | Rule | Error message |
| --- | --- | --- |
| `(sageRoute)` | Must be an object. | `sageRoute must be an object` |
| `enabled` | If present, must be boolean. | `enabled must be a boolean` |
| `alias` | If present, must be string. | `alias must be a string` |
| `alias` | Must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$`. | `alias must use letters, numbers, dot, underscore, or hyphen, with at most one "/" segment` |
| `alias` | Bare aliases starting with `gpt-`, `o1-`, `o3-`, `o4-`, `codex-`, or `claude-` are rejected. The emitted message currently lists the OpenAI/Codex prefixes and omits `claude-*`, but the regex includes it. | `bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are not allowed` |
| `alias` | Alias must not equal a configured provider name. | `alias "<alias>" collides with configured provider name "<alias>"` |
| `cheap` | Must be an object with provider and model. | `cheap must be an object with provider and model` |
| `strong` | Must be an object with provider and model. | `strong must be an object with provider and model` |
| `cheap.provider` | Required. | `cheap.provider is required` |
| `strong.provider` | Required. | `strong.provider is required` |
| `cheap.provider` | Must name a configured provider. | `cheap.provider "<provider>" is not configured` |
| `strong.provider` | Must name a configured provider. | `strong.provider "<provider>" is not configured` |
| `cheap.model` | Required. | `cheap.model is required` |
| `strong.model` | Required. | `strong.model is required` |
| `cheap.inputPerMTok`, `cheap.outputPerMTok` | If present, must be finite and non-negative. | `cheap.<field> must be a non-negative number` |
| `strong.inputPerMTok`, `strong.outputPerMTok` | If present, must be finite and non-negative. | `strong.<field> must be a non-negative number` |
| `strong` | `cheap.provider` and `cheap.model` cannot both equal `strong.provider` and `strong.model`. | `strong must differ from cheap; a ladder with one rung cannot escalate` |
| `checkpointEvery` | Integer from `1` to `100`. | `checkpointEvery must be an integer from 1 to 100` |
| `firstCheckpointAt` | Integer from `1` to `100`. | `firstCheckpointAt must be an integer from 1 to 100` |
| `consecutiveBadRequired` | Integer from `1` to `10`. | `consecutiveBadRequired must be an integer from 1 to 10` |
| `maxSwitches` | Integer from `0` to `10`. | `maxSwitches must be an integer from 0 to 10` |
| `maxRestarts` | Integer from `0` to `10`. | `maxRestarts must be an integer from 0 to 10` |
| `timeoutMs` | Integer from `250` to `120000`. | `timeoutMs must be an integer from 250 to 120000` |
| `interventionThreshold` | Number from `0` to `1`. | `interventionThreshold must be a number from 0 to 1` |
| `budgetEscalateFraction` | Number from `0` to `1`. | `budgetEscalateFraction must be a number from 0 to 1` |
| `budgetUsd` | If present, must be finite and non-negative. | `budgetUsd must be a non-negative number` |
| `offline` | If present, must be boolean. | `offline must be a boolean` |
| `endpoint` | If present, must be a nonblank string. | `endpoint must be a nonblank string` |
| `apiKey` | If present, must be string. | `apiKey must be a string` |
| `escalateHumanMode` | If present, must be `notice` or `continue`. | `escalateHumanMode must be "notice" or "continue"` |

## Worked Examples

### Single-Provider OpenAI

This keeps both ladder rungs on the same provider. The provider uses the default `openai-responses` adapter.

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4.1-mini", "gpt-4.1"]
    }
  },
  "sageRoute": {
    "enabled": true,
    "alias": "sageroute",
    "cheap": {
      "provider": "openai",
      "model": "gpt-4.1-mini"
    },
    "strong": {
      "provider": "openai",
      "model": "gpt-4.1"
    },
    "apiKey": "${LEVANTO_API_KEY}"
  }
}
```

### Cross-Vendor Ladder With A Chat-Only Strong Tier

This starts on an OpenAI Responses-compatible provider and escalates to a provider that only exposes Chat Completions. The Chat provider uses the `openai-chat` adapter, so SageRoute converts Responses input into Chat messages and wraps Chat replies back into Responses.

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4.1-mini"]
    },
    "gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "headers": {
        "x-routing-profile": "strong"
      },
      "models": ["frontier-coder"]
    }
  },
  "sageRoute": {
    "alias": "sageroute",
    "cheap": {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "inputPerMTok": 0.25,
      "outputPerMTok": 2.0
    },
    "strong": {
      "provider": "gateway",
      "model": "frontier-coder",
      "inputPerMTok": 1.25,
      "outputPerMTok": 10.0
    },
    "apiKey": "env:LEVANTO_API_KEY",
    "checkpointEvery": 3,
    "firstCheckpointAt": 3,
    "interventionThreshold": 0.6
  }
}
```

### Subscription OAuth Ladder

This uses stored subscription logins instead of provider API keys. Run the login commands first:

```bash
sageroute auth login openai
sageroute auth login anthropic
sageroute auth status
```

Then omit `apiKey` for every OAuth-backed provider. With the default `authMode: "auto"`, keyless `anthropic` providers and keyless `openai` providers pointed at the ChatGPT Codex backend use the stored login:

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "models": ["gpt-5.4-mini"]
    },
    "anthropic": {
      "adapter": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "models": ["claude-sonnet-4-5-20250929"]
    }
  },
  "sageRoute": {
    "enabled": true,
    "alias": "sageroute",
    "cheap": {
      "provider": "openai",
      "model": "gpt-5.4-mini"
    },
    "strong": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929"
    },
    "apiKey": "${LEVANTO_API_KEY}"
  }
}
```

Use explicit `authMode: "oauth"` only when you want to force subscription auth and reject a stray `apiKey`. If the config key is not the same as the stored login provider, set `oauthProvider` explicitly:

```json
{
  "providers": {
    "chatgpt": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "oauth",
      "oauthProvider": "openai"
    }
  }
}
```

### Locked-Down Deployment With Offline Decisions

This binds to loopback, requires a bearer token, sets a budget cap, and uses the deterministic offline Sage stub. The upstream provider still needs its own API key because offline mode only replaces the Sage decision API.

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "authToken": "${SAGEROUTE_AUTH_TOKEN}",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4.1-mini", "gpt-4.1"],
      "timeoutMs": 600000
    }
  },
  "sageRoute": {
    "enabled": true,
    "alias": "sageroute",
    "cheap": {
      "provider": "openai",
      "model": "gpt-4.1-mini"
    },
    "strong": {
      "provider": "openai",
      "model": "gpt-4.1"
    },
    "offline": true,
    "budgetUsd": 0.5,
    "budgetEscalateFraction": 0.85,
    "maxSwitches": 1,
    "maxRestarts": 1,
    "escalateHumanMode": "notice"
  }
}
```

## Troubleshooting Validator Output

`prepareConfig()` throws a `ConfigError` with this prefix:

```text
invalid SageRoute config:
```

Each issue is formatted as:

```text
  - path.to.field: message
```

Examples:

```text
invalid SageRoute config:
  - providers.openai.apiKey: apiKey references an environment variable that is not set: ${OPENAI_API_KEY}
```

```text
invalid SageRoute config:
  - providers.openai.apiKey: apiKey is not used when authMode is "oauth"; remove it to avoid ambiguity
```

```text
invalid SageRoute config:
  - sageRoute.strong: strong must differ from cheap; a ladder with one rung cannot escalate
```

```text
invalid SageRoute config:
  - providers.local.baseUrl: baseUrl "127.0.0.1" is a private address; set allowPrivateNetwork: true to permit it
```

```text
invalid SageRoute config:
  - sageRoute.alias: bare aliases in the OpenAI native family (gpt-*, o1-*, o3-*, o4-*, codex-*) are not allowed
```

Config file loading can also fail before validation:

```text
cannot read config at <path>: <reason>
```

```text
config at <path> is not valid JSON: <reason>
```

For a deployment gate, use:

```bash
sageroute check --config ./sageroute.config.json
```

On success, it prints the alias, cheap tier, strong tier, which credential each tier will use, and either the Sage endpoint or `offline stub`.

```text
config ok: sageroute.config.oauth.example.json
  alias   sageroute
  cheap   openai/gpt-5.4-mini  [oauth subscription]
  strong  anthropic/claude-sonnet-4-5-20250929  [oauth subscription]
  sage    https://sage.levanto.ai
```

```text
config ok: sageroute.config.example.json
  alias   sageroute
  cheap   openai/gpt-4.1-mini  [api key]
  strong  openai/gpt-4.1  [api key]
  sage    https://sage.levanto.ai
```
