# Decision Model

SageRoute makes a routing decision from execution evidence, not from a prompt-only difficulty estimate. The proxy receives the full `/v1/responses` request every turn, so the `input` array contains the tool calls, tool outputs, assistant turns, and user task statement the agent has accumulated so far. The router turns that history into deterministic signals, asks Sage only at configured checkpoints, then applies local guardrails.

This project is early. The detectors are intentionally simple heuristics. They are useful because they are cheap, factual, and inspectable, not because they are a complete theory of agent failure.

## What Counts As Evidence

`extractTrajectory(input)` in `src/core/evidence.ts` produces:

| Field | Meaning |
| --- | --- |
| `steps` | Ordered `TrajectoryStep[]` recovered from tool calls. |
| `assistantTurns` | Total assistant message items seen. |
| `noToolTurns` | Assistant turns with no paired tool call, derived as `assistantTurns - steps.length` and clamped at zero. |
| `goal` | First user message, trimmed and capped at `600` characters. If `input` is a string, the goal is the first `600` characters of that string. |
| `pendingCalls` | Tool calls that do not yet have an output item. |

Each `TrajectoryStep` has:

| Field | Meaning |
| --- | --- |
| `index` | 1-based action sequence position. |
| `tool` | Tool name from `function_call`, `custom_tool_call`, or `"unknown"`. |
| `argsDigest` | SHA-256 digest of `tool|args`, truncated to `12` hex characters by default. |
| `argsPreview` | Whitespace-normalized arguments, capped at `220` characters. |
| `outputDigest` | SHA-256 digest of the tool output, truncated to `12` hex characters by default. Empty while pending. |
| `outputPreview` | Whitespace-normalized output text, capped at `220` characters. |
| `ok` | Explicit `output.success` if present, otherwise the inverse of `looksLikeFailure(outputText)`. |
| `errorClass` | Empty on success, otherwise the coarse class from `classifyError()`. |

Only answered steps are used by `computeSignals()`. A pending tool call has not produced an observation yet, so it does not count as success, failure, progress, or a loop.

## What Does Not Count As Evidence

Raw model reasoning is not sent to Sage as evidence. `extractTrajectory()` does not read `reasoning` items. Assistant message text is not included in the rendered evidence either. Assistant items affect only the `assistantTurns` and `noToolTurns` counters.

Tool calls and tool outputs are not forwarded to Sage as full transcripts. They are reduced to digests, bounded previews, counts, classes, and recent action summaries. That keeps the decision grounded in what the agent did while avoiding a second full conversation transcript.

On a clean restart, `concreteRequestBody()` removes `reasoning` items and assistant messages from the next upstream request. It keeps the user task, tool calls, and tool outputs, so the next model inherits facts and artifacts rather than provider-specific encrypted reasoning or stale narration.

## Failure Classification

`looksLikeFailure(text)` treats non-empty output as a failure when the lowercase text contains one of these markers:

```text
traceback (most recent call last)
error:
error <space>
exception
failed
failing
no such file
command not found
permission denied
timed out
exit code 1
exit code 2
assertionerror
syntaxerror
cannot find module
```

`classifyError(text)` maps output text to the first matching class in this order:

| Match text | Error class |
| --- | --- |
| `modulenotfounderror` | `ModuleNotFoundError` |
| `importerror` | `ImportError` |
| `syntaxerror` | `SyntaxError` |
| `indentationerror` | `IndentationError` |
| `nameerror` | `NameError` |
| `typeerror` | `TypeError` |
| `valueerror` | `ValueError` |
| `attributeerror` | `AttributeError` |
| `keyerror` | `KeyError` |
| `indexerror` | `IndexError` |
| `zerodivisionerror` | `ZeroDivisionError` |
| `assertionerror` | `AssertionError` |
| `segmentation fault` | `SegFault` |
| `no such file` | `FileNotFound` |
| `cannot find module` | `ModuleNotFoundError` |
| `command not found` | `CommandNotFound` |
| `permission denied` | `PermissionDenied` |
| `timed out` | `Timeout` |
| `traceback (most recent call last)` | `PythonTraceback` |
| `exit code 1` | `NonZeroExit` |
| `test failed` | `TestFailure` |
| `tests failed` | `TestFailure` |
| `failing` | `TestFailure` |
| `failed` | `GenericFailure` |
| `error` | `GenericError` |
| no match | `Unknown` |

The ordering matters. For example, output containing `SyntaxError` maps to `SyntaxError` before the later generic `error` rule can match.

## Deterministic Signals

`computeSignals()` derives a `SignalReport` from answered steps and `SignalInputs`.

| Signal | Exact rule | Why it exists |
| --- | --- | --- |
| `toolCalls` | Count of answered steps. | Avoid judging pending calls. |
| `toolErrors` | Count of answered steps where `ok` is false. | Measures raw failure volume. |
| `recentErrorRate` | Failed steps in the last `RECENT_WINDOW = 6` answered steps divided by recent step count. | Catches a current failure spike without letting older successes dominate. |
| `distinctErrorClasses` | Sorted unique non-empty error classes from failures. | Shows whether failures are the same problem or several unrelated ones. |
| `lastErrorPreview` | `outputPreview` from the last failed step. | Gives Sage a bounded concrete observation. |
| `distinctFilesTouched` | Unique `argsDigest` values among successful write-tool steps. | Approximates rewrite surface without parsing provider-specific tool arguments. It is a heuristic. |
| `failedVerifications` | Failed execution-tool steps. | Execution tools are the closest source of actual verification. |
| `consecutiveFailedVerifications` | Trailing streak of failed execution-tool steps. | Detects when the agent keeps checking and failing. |
| `lastVerificationPassed` | `true` or `false` from the last execution-tool step, or `null` if none exists. | Separates no verification from passing and failing verification. |
| `rewriteRetestCycles` | Count of successful write-tool step followed later by a failed execution-tool step, then reset. | Catches write, test, write, test thrash even when actions are not identical. |
| `stepsSinceProgress` | Answered steps since the last successful execution-tool step. | Progress means a command ran successfully, not merely that a file changed. |
| `budgetBurn` | `costUsd / budgetUsd` when `budgetUsd > 0`, else `0`. | Supports local budget escalation before Sage is called. |
| `recentActions` | Last 6 answered steps as `tool(argsPreview up to 40 chars)->ok` or error class. | Compact trajectory context for Sage. |

### Tool Sets

Write tools:

```text
apply_patch
write_file
edit_file
str_replace_editor
Edit
Write
MultiEdit
```

Execution tools:

```text
shell
exec_command
run_command
bash
Bash
container.exec
```

`stepsSinceProgress` counts a successful execution as progress rather than a file write because a rewrite can be part of a loop. The source comment is explicit: if a naive counter resets on each rewrite, an agent can keep changing files, failing tests, changing files again, and appear healthy while burning the budget.

`rewriteRetestCycles` exists for a related failure mode. Some stuck agents do not repeat the exact same action or produce the exact same observation, so simple duplicate-action loop detection stays silent. The write, failing-exec, write, failing-exec pattern captures an agent that knows the shape of the problem but is not converging.

## Loop Detectors

Loop detection runs in `detectLoops(report, steps)`.

| Detector | Threshold | Loop kind | Failure mode |
| --- | --- | --- | --- |
| Identical action and observation | `REPEAT_ACTION_OBS_THRESHOLD = 3` consecutive identical `tool|argsDigest|outputDigest` keys | `action_observation_repeat` | The agent is doing the same thing and seeing the same result. |
| Same error class back to back | `REPEAT_ERROR_CLASS_THRESHOLD = 3` consecutive failed steps with the same `errorClass` | `repeated_error_class` | The agent is stuck on the same class of failure even if exact text changes. |
| Ping-pong between two actions | Last `PING_PONG_THRESHOLD * 2 = 8` action keys, at least `PING_PONG_THRESHOLD = 4`, exactly two unique `tool|argsDigest` keys, never equal to the adjacent key | `ping_pong` | The agent alternates between two actions without settling. |

These are heuristics. They deliberately prefer interpretable, low-cost signals over broad behavioral inference.

## Evidence Rendering

`renderEvidence(report, goal)` sends Sage a compact factual summary:

```text
TASK: ...

STATUS: ...

current_model=...
tool_calls=... tool_errors=... recent_error_rate=...
error_classes=...
repeated_error_class=...
loop_detected=... loop_kind=...
consecutive_failed_verifications=...
rewrite_retest_fail_cycles=...
steps_since_progress=... no_tool_call_streak=...
files_touched=...
verifications_run=... last_verification_passed=...
cost_usd=... budget_usd=... budget_burn=...
model_switches_already_used=...
recent_actions: ...
last_error: ...
```

`headline(report)` leads the evidence with a plain-language status. It prioritizes three or more consecutive failed verifications, then two failed verifications, loops, one failed check, a passing last verification, no actions, and finally apparent progress.

## Two-Stage Sage Protocol

`HttpSageClient` sends POST requests to `${endpoint}/decide`. The default endpoint is `https://sage.levanto.ai`, so the default decision URL is `https://sage.levanto.ai/decide`.

Stage 1 is a `yesno` question with id `sageroute_needs_intervention`.

```text
The evidence below describes an autonomous coding agent running on a CHEAP, low-capability model. Answer yes if this agent is failing and should be handed off to a stronger, more expensive model. Answer no if it is on track and should keep going on the cheap model.
```

If `P(intervene)` is below `interventionThreshold`, default `0.6`, the router continues and does not ask the four-way action question.

Stage 2 is a `choice` question with id `sageroute_action`. It uses these instructions:

```text
You are governing an autonomous coding agent. You are shown only factual execution evidence from its run so far: tool calls, error classes, loop detection, progress, and budget. Based strictly on this evidence, choose the single best next action. Prefer 'continue' unless the evidence clearly shows the agent is struggling, stuck, or wasting budget. Escalating too early wastes money; escalating too late wastes time and produces failed runs.
```

The options are:

| Option | Description |
| --- | --- |
| `continue` | The trajectory is healthy. Errors are absent, novel, or already being resolved, checks are passing or still pending, and there is no repetition. Keep the current low-cost model working. |
| `switch_model` | The agent is genuinely struggling with the reasoning: repeated failures, failing checks, or no progress for several steps, but the workspace state is still sound. Hand the task to a stronger, more expensive model. |
| `restart_clean` | The trajectory itself is polluted: the agent is looping on the same action, or has baked in a wrong assumption it keeps building on. Discard the context and restart from a clean state with distilled hints. |
| `escalate_human` | No model should continue: the task looks impossible or underspecified, the budget is nearly exhausted, or repeated recovery attempts have failed. Stop and ask a human. |

The two-stage split exists because the original four-way-only design under-escalated. The code comment says `choice` probabilities are independent sigmoids that do not sum to `1`, so options clustered in a narrow band and a confidence floor on the argmax rejected real signal. The binary `yesno` gate separated the same trajectories cleanly. The router therefore asks whether to intervene first, and only asks what to do when the gate fires.

## Sage Client Behavior

`HttpSageClient` is single-shot and deadline-bounded. It sets an `AbortController` timeout using `timeoutMs`, default `8000`. It sends:

```http
POST /decide
Authorization: Bearer <apiKey>
Content-Type: application/json
```

For `yesno`, it reads `result.answer`, `result.confidence`, `result.probability`, `meta.latency_ms`, and `meta.model`. The returned probabilities are `{ yes: probability, no: 1 - probability }`.

For `choice`, it requires between `2` and `120` options, otherwise it throws permanent `SageError("choice requires between 2 and 120 options", true)`. It reads `result.chosen`, `result.confidence`, `result.probabilities[]`, `meta.latency_ms`, and `meta.model`.

HTTP `400`, `401`, and `402` responses are marked permanent with message `Sage <status>: <detail>`. Other fetch or timeout failures become `Sage request failed: <reason>`. `decide()` fails open on Sage errors by returning `continue` from local policy.

`OfflineSageClient` is a deterministic stub. It parses key-value facts from `renderEvidence()` and applies transparent heuristics. It exists for tests and local end-to-end exercise, not as a claim about live Sage scoring.

## Guardrails In `decide()`

The guardrails apply in this order:

1. Local budget hard stop. If `budgetUsd > 0` and `budgetBurn >= budgetEscalateFraction`, return `escalate_human` with source `local` before making any Sage call. Spend limits are policy, not model judgment.
2. Render evidence with `renderEvidence(report, goal)`.
3. Ask the stage-one `yesno` gate. If Sage throws, fail open with `continue` and reason `sage unavailable (...); continuing`.
4. If `P(intervene) < interventionThreshold`, reset `state.consecutiveBad` to `0` and continue.
5. Ask the stage-two `choice` question. If Sage throws, fail open with `continue` and preserve the intervention probability.
6. Validate the proposed action. Unknown answers fall back to `continue`.
7. If the gate fired but the choice answer is `continue`, choose the highest-probability non-`continue` action from the returned probabilities. If none exists, use `switch_model`. This avoids ignoring the intervention gate outright.
8. Capability before retry. If Sage proposed `restart_clean` on the cheap tier and `state.switchesUsed < maxSwitches`, rewrite the action to `switch_model`. The same weak model should not retry a hard reasoning task just because its context is messy.
9. Asymmetric hysteresis. Start with `consecutiveBadRequired`, default `2`, but set the required count to `1` for the first cheap-to-strong switch when no switch has been used. Then increment `state.consecutiveBad`.
10. If `state.consecutiveBad` is still below the required count, return local `continue` with reason `bad checkpoint <n>/<required>, holding`.
11. For `switch_model`: if already on strong, convert to `restart_clean` when restarts remain, otherwise `escalate_human`. If still on cheap but `maxSwitches` is exhausted, escalate human. Otherwise increment `switchesUsed`, reset `consecutiveBad`, and switch to strong.
12. For `restart_clean`: if restart budget is exhausted, escalate human. Otherwise increment `restartsUsed`, reset `consecutiveBad`, and set the restart action.
13. For any remaining path, reset `consecutiveBad`, set `escalate_human`, and use reason `sage escalated to human review`.

`routeTurn()` then applies the action to the session. `switch_model` changes `session.tier` to `strong`. `restart_clean` sets `session.restartPending`, which the next concrete request consumes by trimming reasoning and assistant messages. `escalate_human` sets `session.escalated`, so later turns remain escalated until a new session starts.

## Worked Example

This is a concrete trajectory with three successful edits and three failed executions:

| Step | Tool | Result |
| --- | --- | --- |
| 1 | `apply_patch` | ok |
| 2 | `exec_command` with `bun test` | `GenericError` |
| 3 | `apply_patch` | ok |
| 4 | `exec_command` with `bun test` | `GenericError` |
| 5 | `apply_patch` | ok |
| 6 | `exec_command` with `bun test` | `GenericError` |

With `model=openai/gpt-4.1-nano`, tier `cheap`, `costUsd=0.0123`, `budgetUsd=0.05`, and `switchesUsed=0`, the actual `renderEvidence()` output is:

```text
TASK: Fix the failing TypeScript test.

STATUS: The agent has FAILED its own checks 3 times in a row and has not solved the task. It keeps rewriting its solution and re-running, without converging.

current_model=openai/gpt-4.1-nano (cheap tier) step=6
tool_calls=6 tool_errors=3 recent_error_rate=0.50
error_classes=GenericError
repeated_error_class=none
loop_detected=false loop_kind=none
consecutive_failed_verifications=3
rewrite_retest_fail_cycles=3
steps_since_progress=6 no_tool_call_streak=0
files_touched=3
verifications_run=3 last_verification_passed=false
cost_usd=0.0123 budget_usd=0.05 budget_burn=0.25
model_switches_already_used=0
recent_actions: apply_patch(fix parser)->ok | exec_command(bun test)->GenericError | apply_patch(adjust parser)->ok | exec_command(bun test)->GenericError | apply_patch(handle edge case)->ok | exec_command(bun test)->GenericError
last_error: error: expect(received).toEqual(expected) failed
```

Using the offline stub and default routing config, `decide()` returns:

```json
{
  "confidence": 0.82,
  "probabilities": {
    "continue": 0.05,
    "switch_model": 0.82,
    "restart_clean": 0.05,
    "escalate_human": 0.05
  },
  "interventionProbability": 0.99,
  "sageLatencyMs": 0,
  "action": "switch_model",
  "reason": "agent struggling on cheap model; escalating capability",
  "source": "offline"
}
```

That decision follows from the source heuristics: three consecutive failed executions push the intervention gate high, recent error rate is `0.50`, `stepsSinceProgress` is `6`, and `rewriteRetestCycles` is `3`. Because this is the first bad checkpoint on the cheap tier and no switch has been used, asymmetric hysteresis allows the first `switch_model` immediately and increments `switchesUsed` to `1`.
