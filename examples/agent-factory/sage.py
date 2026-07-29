"""the gate: one closed question, one calibrated number.

contract lifted from the live client in sageroute (src/core/sage.ts):

    POST {endpoint}/decide
    Authorization: Bearer <key>
    {"content": "...",
     "question": {"id": "...", "kind": "yesno"|"choice",
                  "instructions": "...", "options": [{"option","description"}]}}

    -> {"result": {"answer"|"chosen", "confidence", "probability"|"probabilities"},
        "meta": {"latency_ms", "model"}}

two properties matter, both deliberate:

single-shot with a hard deadline. retrying inside a turn trades a decision you
can live without for latency you cannot.

fails open. no key, timeout, or outage returns (None, 0.0) and the caller routes
to a human. the gate is a checkpoint, never a dependency.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ENDPOINT = os.environ.get("SAGE_ENDPOINT", "https://sage.levanto.ai")
TIMEOUT = 8.0

# 400 bad request, 401 bad key, 402 no balance. worth printing, never worth retrying.
PERMANENT = {400, 401, 402}


def yesno(content, question_id, instructions, timeout=TIMEOUT):
    """Return (answer, p_yes). Threshold p_yes -- that is the calibrated number."""
    raw = _post(
        {"content": content,
         "question": {"id": question_id, "kind": "yesno", "instructions": instructions}},
        timeout,
    )
    if raw is None:
        return None, 0.0
    result = raw.get("result") or {}
    return result.get("answer"), _num(result.get("probability"))


def scale(content, question_id, instructions, levels, timeout=TIMEOUT):
    """levels: [{"level": 0..N, "description": str}]. Return (expectation, confidence).

    exact-match scoring can tell you a label is wrong. it cannot tell you the
    draft promised a refund. that is what a rubric is for."""
    raw = _post({"content": content,
                 "question": {"id": question_id, "kind": "scale",
                              "instructions": instructions, "levels": levels}}, timeout)
    if raw is None:
        return None, 0.0
    result = raw.get("result") or {}
    return _num(result.get("expectation"), None), _num(result.get("confidence"))


def choice(content, question_id, instructions, options, timeout=TIMEOUT):
    """options: [{"option": str, "description": str}]. Return (chosen, {option: p})."""
    if not 2 <= len(options) <= 120:
        raise ValueError("choice requires between 2 and 120 options")
    raw = _post(
        {"content": content,
         "question": {"id": question_id, "kind": "choice",
                      "instructions": instructions, "options": options}},
        timeout,
    )
    if raw is None:
        return None, {}
    result = raw.get("result") or {}
    probs = {p["option"]: _num(p.get("probability"))
             for p in result.get("probabilities") or [] if "option" in p}
    return result.get("chosen"), probs


def batch(groups, timeout=TIMEOUT):
    """groups: [{"content": str, "questions": [ {...}, ... ]}]

    one content, many questions, and the content is sent once. the factory asks
    two things about every output -- is the draft safe, does the whole thing
    pass -- so batching halves the round trips and stops paying twice for the
    same input tokens.
    """
    raw = _post({"requests": groups}, timeout)
    if raw is None:
        return []
    return raw.get("responses") or raw.get("results") or []


def _post(payload, timeout):
    key = os.environ.get("SAGE_API_KEY")
    if not key:
        return None
    path = "/decide/batch" if "requests" in payload else "/decide"
    req = urllib.request.Request(
        f"{ENDPOINT}{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 # without a UA the edge returns 403 (cloudflare 1010) and the
                 # fail-open silently routes every run to a human. a gate that
                 # is never reached looks exactly like a gate that always says no.
                 "User-Agent": "agent-factory/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        if err.code in PERMANENT:
            detail = err.read()[:200].decode(errors="replace")
            print(f"sage {err.code}: {detail}", file=sys.stderr)
        return None
    except Exception:
        return None


def _num(value, fallback=0.0):
    return float(value) if isinstance(value, (int, float)) else fallback
