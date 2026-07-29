"""the worker's model call, routed.

two different jobs, two different products, and the factory uses both:

  Sage       gates the OUTPUT. one closed question after the agent answers.
  SageRoute  gates the RUN.    it reads the trajectory mid-task and escalates
                               a stuck agent before it produces that output.

when SAGEROUTE_URL is set, completions go through the proxy and the routing
decision comes back in x-sageroute-* headers, which the control tower records.
when it is not set, calls go straight to the vendor. when no key exists at all,
a deterministic offline backend answers so the line still runs end to end.

every completion reports which backend answered. a run that quietly fell back
to offline and a run that talked to a frontier model must never look alike in
the trace.
"""
import json
import os
import urllib.request

VENDOR = "https://api.anthropic.com/v1/messages"

# usd per million tokens (input, output). a ceiling computed from a stale price
# table is a ceiling that does not hold -- update this when pricing moves.
PRICES = {
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

LAST = {"cost_usd": 0.0, "route": None}


def complete(prompt, model, offline, max_tokens=512, timeout=30.0):
    """Return (text, backend). Cost and routing land in LAST."""
    LAST.update(cost_usd=0.0, route=None)

    proxy = os.environ.get("SAGEROUTE_URL")
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not proxy and not key:
        return offline(prompt), "offline"

    # through SageRoute the model name is the router alias -- the point is that
    # nobody picks the tier up front, the trajectory picks it mid-run.
    url = f"{proxy.rstrip('/')}/v1/messages" if proxy else VENDOR
    sent_model = "sageroute" if proxy else model

    body = json.dumps({
        "model": sent_model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "x-api-key": key or "unused",
        "authorization": f"Bearer {key}" if key else "Bearer unused",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.load(response)
            headers = response.headers
    except Exception:
        # failing over is a fact the control tower needs, not something to swallow.
        return offline(prompt), "offline-after-error"

    text = "".join(b.get("text", "") for b in data.get("content", []))
    usage = data.get("usage", {})
    priced = headers.get("x-sageroute-model") or model
    pin, pout = PRICES.get(priced.split("/")[-1], PRICES.get(model, (0.0, 0.0)))
    LAST["cost_usd"] = (usage.get("input_tokens", 0) * pin
                        + usage.get("output_tokens", 0) * pout) / 1_000_000

    if headers.get("x-sageroute-action"):
        LAST["route"] = {
            "tier": headers.get("x-sageroute-tier"),
            "action": headers.get("x-sageroute-action"),
            "intervention": headers.get("x-sageroute-intervention"),
            "source": headers.get("x-sageroute-source"),
        }
        return text, f"sageroute:{headers.get('x-sageroute-model', '?')}"
    return text, priced
