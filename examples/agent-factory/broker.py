"""the broker: every tool call goes through here, or it does not happen.

the ABOM lists what an agent may touch. that list is worthless unless something
sitting between the agent and the tool reads it before the call lands. this is
that something.

the point is that policy is enforced OUTSIDE the model. an agent cannot prompt
its way past a grant it was never given, because the grant is checked here and
never asked for there. a poisoned ticket saying "issue a refund" reaches an
agent with no refund grant and dies at this boundary, in code, with a trace line.
"""


class Denied(Exception):
    """raised when an agent reaches for a tool its card does not grant."""


class Broker:
    def __init__(self, abom, trace):
        self.allowed = set(abom.get("tools", []))
        self.denied = set(abom.get("tools_denied", []))
        self.trace = trace
        self.impls = {}

    def register(self, name, fn):
        self.impls[name] = fn

    def call(self, name, **kwargs):
        # denied wins over allowed. a card that lists a tool in both is a bug,
        # and the safe reading of a bug is no.
        if name in self.denied:
            self.trace.append({"tool": name, "ok": False, "error": "DENIED_EXPLICIT"})
            raise Denied(f"{name} is explicitly denied to this agent")
        if name not in self.allowed:
            self.trace.append({"tool": name, "ok": False, "error": "DENIED_UNGRANTED"})
            raise Denied(f"{name} is not granted to this agent")
        if name not in self.impls:
            self.trace.append({"tool": name, "ok": False, "error": "NO_IMPL"})
            raise Denied(f"{name} is granted but has no implementation wired")

        try:
            out = self.impls[name](**kwargs)
        except Exception as err:
            self.trace.append({"tool": name, "ok": False, "error": type(err).__name__})
            raise
        self.trace.append({"tool": name, "ok": True})
        return out
