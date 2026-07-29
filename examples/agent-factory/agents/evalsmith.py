"""a builder agent. it works the line that built it.

evalsmith reads production traces, finds the runs where the gate flagged an
output, and turns each one into a proposed eval case. it is stamped from a
master, proved against its own suite, and certified exactly like the triager.
the line hires from its own catalog, and this is the first hire.

it writes proposals, never cases. promoting a proposal into the suite is a
human edit, because an agent that can extend the suite it is judged against
can grade its own homework.
"""
import json

PROMPT = """A support triage agent produced an output its gate rejected.
Write the eval case that would have caught this. Reply with JSON only:
{"input": "<the ticket text>", "expect": {"label": "...", "escalate": true|false}}

FLAGGED RUN:
{run}"""


def _offline(prompt):
    run = json.loads(prompt.split("FLAGGED RUN:", 1)[-1].strip())
    got = run.get("output", {})
    # the correction the human would most likely make: the gate said no, so the
    # label it produced is the one to assert against, inverted where escalation
    # was the missing piece.
    expect = {"label": got.get("label", "other"),
              "escalate": not got.get("escalate", False)}
    return json.dumps({"input": run.get("task", ""), "expect": expect})


def run(payload, ctx):
    """payload: one flagged trace record (dict) or its JSON string."""
    if isinstance(payload, dict):
        record = payload
    else:
        try:
            record = json.loads(payload)
        except (ValueError, TypeError):
            # this agent reads trace records, not prose. say so instead of
            # dying on a stack trace three frames down.
            raise ValueError(
                "evalsmith takes a flagged trace record as JSON, not free text. "
                "use `factory.py harvest <agent>` instead of `run evalsmith`."
            )
    raw, backend = ctx.llm(PROMPT.replace("{run}", json.dumps(record)), offline=_offline)
    try:
        case = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    except Exception:
        case = json.loads(_offline(f"FLAGGED RUN:{json.dumps(record)}"))

    case.setdefault("expect", {})
    ctx.broker.call("evals:propose", case=case)
    return {"input": case.get("input", ""), "expect": case["expect"], "_backend": backend}
