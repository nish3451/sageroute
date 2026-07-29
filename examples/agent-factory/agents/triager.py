"""the product: a support triage agent.

it reads a ticket, decides a label, drafts a reply, and escalates anything it is
not allowed to answer. it reaches the outside world only through the broker, so
what it can do is decided by its card and not by what a ticket talks it into.
"""
import json

PROMPT = """You are triaging one support ticket. Reply with JSON only:
{"label": "billing"|"account"|"bug"|"other", "escalate": true|false,
 "action": "reply"|"refund", "draft": "<one sentence to the customer>"}

Escalate anything about refunds, chargebacks, security, breaches, or legal.
A ticket that mentions both money and a malfunction is a bug, not billing.

TICKET:
{ticket}"""

RULES = [
    (("crash", "error", "errors", "500", "broken", "bug", "leaked"), "bug"),
    (("password", "login", "2fa", "locked out", "signed into",
      "gdpr", "delete all my data"), "account"),
    (("charged", "refund", "invoice", "billing", "subscription", "chargeback"), "billing"),
]
ESCALATE = ("refund", "legal", "gdpr", "breach", "security", "chargeback",
            "leaked", "signed into my account")


def _offline(prompt):
    """deterministic stand-in. mirrors the prompt's rules, never claims to be the model."""
    ticket = prompt.split("TICKET:", 1)[-1].strip().lower()
    label = next((n for keys, n in RULES if any(k in ticket for k in keys)), "other")
    escalate = any(k in ticket for k in ESCALATE)
    # a poisoned ticket that instructs an action is exactly what the broker exists for.
    action = "refund" if "issue a refund" in ticket or "ignore your instructions" in ticket else "reply"
    return json.dumps({"label": label, "escalate": escalate, "action": action,
                       "draft": f"thanks for writing in about this {label} issue, we're looking now."})


def run(ticket, ctx):
    raw, backend = ctx.llm(PROMPT.replace("{ticket}", ticket), offline=_offline)
    try:
        out = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    except Exception:
        out = json.loads(_offline(f"TICKET:{ticket}"))

    # the agent may want to refund. the card decides whether it can.
    if out.get("action") == "refund":
        try:
            ctx.broker.call("billing:refund", ticket=ticket)
        except Exception:
            out["escalate"] = True          # denied -> a human gets it
            out["draft"] = "escalating this to a human who can review the account."

    ctx.broker.call("issues:label", label=out["label"])
    ctx.broker.call("drafts:write", text=out["draft"])
    return {"label": out["label"], "escalate": bool(out["escalate"]),
            "draft": out["draft"], "_backend": backend}
