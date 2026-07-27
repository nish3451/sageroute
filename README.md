# SageRoute

**A trajectory-aware model router.** SageRoute is an OpenAI-compatible proxy that starts every task on a cheap model, watches what the agent actually *does*, and escalates only when the execution evidence says it is struggling.

Conventional routers classify difficulty from the prompt, before any work has happened. That is a guess made at the worst possible moment: prompts lie about difficulty in both directions. SageRoute makes the opposite bet. It puts the decision *after* the evidence exists, re-deciding each turn from tool calls, error classes, loops, failed verifications, and budget burn, using the [Levanto Sage](https://docs.levanto.ai/) decision API for the verdict.

---

## Why a proxy

An agent harness resends its entire conversation on every turn. That request body *is* the execution history: every tool call the agent made, every output it got back, every error it hit. A proxy sees it for free, on a request it is already handling, for every turn of every session.

So the proxy is not packaging around the router. It is the only place in the stack where trajectory-aware routing is possible without asking anyone to change their agent.

```
  agent harness  ->  SageRoute proxy  ->  cheap model
                          |                   |
                          |  evidence recovered from the request body
                          v
                     Levanto Sage  -->  continue / switch / restart / escalate
                          |
                          +---------->  strong model
```

## Install

```bash
git clone https://github.com/codejunkie99/sageroute
cd sageroute
bun install
```

Requires [Bun](https://bun.sh) 1.1+.

## Quick start

```bash
cp sageroute.config.example.json sageroute.config.json
export OPENAI_API_KEY=sk-...
export SAGE_API_KEY=lv_...        # from https://docs.levanto.ai/

bun run check                     # validate config, then exit
bun run serve                     # listens on 127.0.0.1:8787
```

Point any OpenAI-compatible client at it and ask for the router by name:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"sageroute","input":"refactor the auth module","prompt_cache_key":"task-1"}'
```

For a harness that reads the standard environment variables:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_MODEL=sageroute
```

Nothing else changes. The harness thinks it is talking to one model; it is talking to a ladder.

## How the decision works

### 1. Evidence, not self-report

Every turn, the inbound `input` array is replayed into a typed trajectory: `function_call` items paired to their `function_call_output` by `call_id`, in the order the agent actually issued them.

The model's own reasoning never becomes evidence on its own. It is reduced to counts, classes, and digests. A model saying "I've got this now" for the fifth time is not evidence of progress; a passing test is.

### 2. Deterministic signals first

Cheap local detectors run before Sage is consulted at all:

- **Action/observation repeat** - same call, same output, three or more times: the agent has stopped learning.
- **Repeated error class** - the same failure category back to back.
- **Ping-pong** - alternating between two actions indefinitely.
- **Rewrite/retest cycles** - write, fail, write, fail. The signature of a model that understands the problem's shape but cannot solve it. It never repeats an identical action, so naive loop detection stays silent while it burns the entire budget.
- **Steps since progress** - where progress means *a successful execution*, not a file write. Counting a rewrite as progress is exactly what lets a thrashing agent look healthy.

### 3. A two-stage Sage call

Stage one is a binary `yesno` gate: is this agent failing badly enough to intervene at all? Most checkpoints end there, for the price of one cheap call.

Stage two runs only when the gate fires, and asks which of four actions to take: `continue`, `switch_model`, `restart_clean`, `escalate_human`.

The split was not the original design. Asking only the four-way question under-escalated badly, because `choice` probabilities are independent sigmoids that do not sum to 1, so every option clustered in the same narrow band and a confidence floor on the argmax rejected real signal. A binary gate separates the same trajectories cleanly.

### 4. Guardrails around the verdict

A model's opinion is not a routing policy. Every verdict passes through:

- **Local budget stop, before any network call.** Spend limits are policy, never delegated to the model. An exhausted budget cannot spend more money asking whether it should stop.
- **Capability before retry.** A restart hands the same task back to the same weak model. That helps only when the context is polluted, never when the model simply cannot do the work. On the cheap tier with a switch available, climb first.
- **Asymmetric hysteresis.** The first cheap-to-strong hop is the cheapest, most reversible move on the ladder, so it fires on one bad checkpoint. Restarts and human escalation are disruptive, so they need repeated agreement.
- **A one-way ladder.** Already on strong and still failing? The next rung is a restart, then a human. Never a demotion.
- **Fail open.** If Sage is unreachable the agent keeps working on its current model. A router outage must not take the agent down with it.

### 5. Restarts keep the artifacts, drop the confusion

On `restart_clean` the forwarded request is rebuilt: the task, the tool calls, and their real outputs are kept, while the assistant's narration and `reasoning` items are dropped. The next model inherits facts and artifacts, not the dead ends that caused the escalation. This is also required for correctness across vendors, since reasoning items carry provider-specific encrypted payloads another provider cannot decrypt.

## Configuration

```json
{
  "port": 8787,
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "anthropic": {
      "adapter": "openai-chat",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  },
  "sageRoute": {
    "cheap":  { "provider": "openai", "model": "gpt-4.1-mini", "inputPerMTok": 0.4, "outputPerMTok": 1.6 },
    "strong": { "provider": "openai", "model": "gpt-4.1", "inputPerMTok": 2.0, "outputPerMTok": 8.0 },
    "apiKey": "${SAGE_API_KEY}",
    "budgetUsd": 5.0
  }
}
```

The two tiers may live on different providers, so a ladder can cross vendors.

| Key | Default | Meaning |
| --- | --- | --- |
| `alias` | `sageroute` | Model id clients request to get routed |
| `checkpointEvery` | `3` | Turns between Sage consultations |
| `firstCheckpointAt` | `3` | Never judge before this many recorded actions exist |
| `interventionThreshold` | `0.6` | Stage-one gate: P(intervene) at or above this asks the four-way question |
| `consecutiveBadRequired` | `2` | Hysteresis for restarts and human escalation |
| `maxSwitches` | `1` | Cheap to strong hops per session |
| `maxRestarts` | `1` | Clean restarts per session |
| `budgetUsd` | `0` (off) | Session spend cap in USD |
| `budgetEscalateFraction` | `0.85` | Fraction of budget that triggers human escalation |
| `escalateHumanMode` | `notice` | `notice` stops the run with an explanation; `continue` only records the verdict |
| `offline` | `false` | Use the deterministic local stub instead of the network |

Every credential field supports `${VAR}`, `$VAR`, and `env:VAR` indirection. A reference to an unset variable fails validation at startup rather than being forwarded upstream as a nonsense key and coming back as an opaque 401.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /v1/responses` | Main path. Routed when `model` is the alias, passed through otherwise |
| `POST /v1/chat/completions` | Passthrough for non-alias models |
| `GET /v1/models` | The router alias plus every configured `provider/model` |
| `GET /v1/sageroute/sessions` | Per-session tier, cost, switches, and full decision history |
| `GET /health` | Liveness |

Every routed response carries its decision on the wire:

```
x-sageroute-model:        openai/gpt-4.1
x-sageroute-tier:         strong
x-sageroute-action:       switch_model
x-sageroute-intervention: 0.920
x-sageroute-source:       sage
```

## Sessions

HTTP is stateless; routing is not. Session identity is recovered from the request, in order of reliability: `prompt_cache_key`, then the `x-codex-parent-thread-id` header, then a digest of the first user message. When nothing identifying is present the turn is routed to the cheap tier and left stateless, rather than inventing an identity that would silently merge unrelated conversations into one budget.

Sessions expire after six hours idle, with an LRU cap, so a long-lived proxy does not accumulate state forever.

## Testing

```bash
bun test tests/
bun run typecheck
```

`examples/live-e2e.ts` drives a real failing trajectory through the real proxy against the live Sage API, with a local stub standing in for the model provider. It prints which model each turn actually reached, because the routing decision is only real if it changes what the upstream receives.

```bash
export SAGE_API_KEY=lv_...
bun run examples/live-e2e.ts
```

## Status

Early but real. The decision engine and the proxy are both covered by tests, and the ladder has been exercised end to end against the live Sage API. Not yet battle-tested at scale.

## License

MIT
