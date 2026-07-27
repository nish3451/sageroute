import { beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_IDLE_MS,
  addTurnCost,
  clearSageRouteSessions,
  concreteRequestBody,
  digest,
  getSession,
  listSessions,
  peekSession,
  pricingFor,
  recordHistory,
  resolveSageRouteConfig,
  routeTurn,
  sessionIdFor,
  type ResolvedSageRouteConfig,
  type RouteHistoryEntry,
  type SageClient,
  type SageDecision,
  type SageRouteAction,
} from "../src/core";

class FakeSageClient implements SageClient {
  yesnoCalls = 0;
  choiceCalls = 0;
  yesProbability = 0.1;
  action: SageRouteAction = "continue";

  get calls(): number {
    return this.yesnoCalls + this.choiceCalls;
  }

  async yesno(): Promise<SageDecision> {
    this.yesnoCalls += 1;
    return {
      kind: "yesno",
      answer: this.yesProbability >= 0.5 ? "yes" : "no",
      confidence: Math.abs(this.yesProbability - 0.5) * 2,
      probabilities: { yes: this.yesProbability, no: 1 - this.yesProbability },
      latencyMs: 7,
      model: "fake-sage",
      source: "sage",
    };
  }

  async choice(): Promise<SageDecision> {
    this.choiceCalls += 1;
    return {
      kind: "choice",
      answer: this.action,
      confidence: 0.91,
      probabilities: {
        continue: this.action === "continue" ? 0.91 : 0.02,
        switch_model: this.action === "switch_model" ? 0.91 : 0.02,
        restart_clean: this.action === "restart_clean" ? 0.91 : 0.02,
        escalate_human: this.action === "escalate_human" ? 0.91 : 0.02,
      },
      latencyMs: 11,
      model: "fake-sage",
      source: "sage",
    };
  }
}

function config(
  overrides: Partial<ResolvedSageRouteConfig> = {},
): ResolvedSageRouteConfig {
  return {
    ...resolveSageRouteConfig({
      cheap: {
        provider: "cheap-provider",
        model: "cheap-model",
        inputPerMTok: 0.5,
        outputPerMTok: 1.5,
      },
      strong: {
        provider: "strong-provider",
        model: "strong-model",
        inputPerMTok: 2,
        outputPerMTok: 8,
      },
      checkpointEvery: 3,
      firstCheckpointAt: 2,
      interventionThreshold: 0.6,
      consecutiveBadRequired: 1,
      maxSwitches: 1,
      maxRestarts: 1,
      offline: true,
    }),
    ...overrides,
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistantMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function call(id: string, name = "shell", args = "{}"): Record<string, unknown> {
  return { type: "function_call", call_id: id, name, arguments: args };
}

function output(id: string, text = "tests passed"): Record<string, unknown> {
  return { type: "function_call_output", call_id: id, output: text };
}

function body(
  promptCacheKey: string | undefined,
  goal = "fix the failing test",
  toolPairs = 0,
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [userMessage(goal)];
  for (let i = 0; i < toolPairs; i += 1) {
    input.push(call(`call-${i}`, "shell", `{"cmd":"bun test ${i}"}`));
    input.push(output(`call-${i}`, "tests passed"));
  }
  return {
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    model: "sageroute",
    input,
  };
}

function historyEntry(step: number): RouteHistoryEntry {
  return {
    at: step,
    step,
    action: "continue",
    fromModel: "cheap-provider/cheap-model",
    toModel: "cheap-provider/cheap-model",
    reason: `entry-${step}`,
    source: "local",
    confidence: 0,
    interventionProbability: 0,
    sageLatencyMs: 0,
  };
}

beforeEach(() => {
  clearSageRouteSessions();
});

describe("SageRoute sessions", () => {
  test("sessionIdFor prefers prompt cache key, then parent thread header, then goal digest", () => {
    const headers = new Headers({ "x-codex-parent-thread-id": " thread-123 " });

    expect(sessionIdFor({ prompt_cache_key: " cache-456 " }, headers, "goal text"))
      .toBe("pck:cache-456");
    expect(sessionIdFor({}, headers, "goal text")).toBe("thr:thread-123");
    expect(sessionIdFor({}, undefined, "goal text")).toBe(`goal:${digest("goal text", 20)}`);
    expect(sessionIdFor({}, undefined, "")).toBeNull();
    expect(sessionIdFor({}, undefined, undefined)).toBeNull();
  });

  test("getSession creates sane defaults and returns the same object while updating lastSeenAt", () => {
    const created = getSession("pck:stable", 1_000);

    expect(created).toMatchObject({
      id: "pck:stable",
      tier: "cheap",
      createdAt: 1_000,
      lastSeenAt: 1_000,
      turns: 0,
      lastCheckpointTurn: 0,
      costUsd: 0,
      escalated: false,
      restartPending: false,
      history: [],
      sageCalls: 0,
      switchesUsed: 0,
      restartsUsed: 0,
      consecutiveBad: 0,
    });

    const again = getSession("pck:stable", 2_000);
    expect(again).toBe(created);
    expect(again.createdAt).toBe(1_000);
    expect(again.lastSeenAt).toBe(2_000);
  });

  test("getSession evicts sessions that have been idle longer than SESSION_IDLE_MS", () => {
    getSession("pck:old", 1_000);
    getSession("pck:fresh", 1_000 + SESSION_IDLE_MS + 1);

    expect(peekSession("pck:old")).toBeUndefined();
    expect(peekSession("pck:fresh")).toBeDefined();
  });

  test("recordHistory caps history at 50 entries and drops the oldest entries", () => {
    const session = getSession("pck:history", 1_000);

    for (let step = 1; step <= 55; step += 1) {
      recordHistory(session, historyEntry(step));
    }

    expect(session.history).toHaveLength(50);
    expect(session.history[0]!.step).toBe(6);
    expect(session.history.at(-1)!.step).toBe(55);
  });

  test("addTurnCost accumulates token costs and ignores undefined usage", () => {
    const session = getSession("pck:cost", 1_000);

    addTurnCost(session, { inputTokens: 1_000_000, outputTokens: 500_000 }, {
      inputPerMTok: 0.25,
      outputPerMTok: 2,
    });
    addTurnCost(session, { inputTokens: 250_000, outputTokens: 100_000 }, {
      inputPerMTok: 1,
      outputPerMTok: 3,
    });
    addTurnCost(session, undefined, { inputPerMTok: 100, outputPerMTok: 100 });

    expect(session.costUsd).toBeCloseTo(1.25 + 0.55, 10);
  });

  test("listSessions sorts most recently seen first and clearSageRouteSessions clears one or all", () => {
    getSession("pck:first", 1_000);
    getSession("pck:second", 2_000);
    getSession("pck:third", 1_500);

    expect(listSessions().map(session => session.id)).toEqual([
      "pck:second",
      "pck:third",
      "pck:first",
    ]);

    clearSageRouteSessions("pck:third");
    expect(listSessions().map(session => session.id)).toEqual(["pck:second", "pck:first"]);

    clearSageRouteSessions();
    expect(listSessions()).toEqual([]);
  });
});

describe("SageRoute router", () => {
  test("does not consult Sage before firstCheckpointAt tool calls, then checkpoints once evidence is sufficient", async () => {
    const client = new FakeSageClient();
    const routeConfig = config({ checkpointEvery: 1, firstCheckpointAt: 2 });

    const beforeThreshold = await routeTurn(body("cadence-threshold", "fix it", 1), undefined, routeConfig, client, 1_000);
    expect(beforeThreshold.checkpointed).toBe(false);
    expect(beforeThreshold.tier).toBe("cheap");
    expect(beforeThreshold.action).toBe("continue");
    expect(client.calls).toBe(0);

    const atThreshold = await routeTurn(body("cadence-threshold", "fix it", 2), undefined, routeConfig, client, 2_000);
    expect(atThreshold.checkpointed).toBe(true);
    expect(atThreshold.tier).toBe("cheap");
    expect(atThreshold.action).toBe("continue");
    expect(client.yesnoCalls).toBe(1);
    expect(client.choiceCalls).toBe(0);
  });

  test("honors every-N-turn checkpoint cadence between Sage consultations", async () => {
    const client = new FakeSageClient();
    const routeConfig = config({ checkpointEvery: 3, firstCheckpointAt: 1 });
    const request = body("cadence-every-n", "keep checking", 1);

    const first = await routeTurn(request, undefined, routeConfig, client, 1_000);
    const second = await routeTurn(request, undefined, routeConfig, client, 2_000);
    const third = await routeTurn(request, undefined, routeConfig, client, 3_000);
    const fourth = await routeTurn(request, undefined, routeConfig, client, 4_000);
    const fifth = await routeTurn(request, undefined, routeConfig, client, 5_000);
    const sixth = await routeTurn(request, undefined, routeConfig, client, 6_000);

    expect([
      first.checkpointed,
      second.checkpointed,
      third.checkpointed,
      fourth.checkpointed,
      fifth.checkpointed,
      sixth.checkpointed,
    ]).toEqual([false, false, true, false, false, true]);
    expect(client.yesnoCalls).toBe(2);
    expect(client.choiceCalls).toBe(0);
  });

  test("switch_model flips the session to strong and the next turn stays strong without re-consulting", async () => {
    const client = new FakeSageClient();
    client.yesProbability = 0.95;
    client.action = "switch_model";
    const routeConfig = config({ checkpointEvery: 3, firstCheckpointAt: 1 });
    const request = body("switch-session", "this needs more reasoning", 1);
    getSession("pck:switch-session", 1_000).turns = 2;

    const switched = await routeTurn(request, undefined, routeConfig, client, 2_000);
    expect(switched.checkpointed).toBe(true);
    expect(switched.action).toBe("switch_model");
    expect(switched.tier).toBe("strong");
    expect(switched.session.tier).toBe("strong");
    expect(switched.modelRef).toBe("strong-provider/strong-model");
    expect(client.calls).toBe(2);

    const next = await routeTurn(request, undefined, routeConfig, client, 3_000);
    expect(next.checkpointed).toBe(false);
    expect(next.action).toBe("continue");
    expect(next.tier).toBe("strong");
    expect(next.modelRef).toBe("strong-provider/strong-model");
    expect(client.calls).toBe(2);
  });

  test("an escalated session short-circuits later turns without calling Sage again", async () => {
    const client = new FakeSageClient();
    const routeConfig = config({ checkpointEvery: 1, firstCheckpointAt: 1 });
    const session = getSession("pck:already-escalated", 1_000);
    session.tier = "strong";
    session.escalated = true;

    const result = await routeTurn(body("already-escalated", "stop here", 1), undefined, routeConfig, client, 2_000);

    expect(result.checkpointed).toBe(false);
    expect(result.action).toBe("escalate_human");
    expect(result.tier).toBe("strong");
    expect(result.modelRef).toBe("strong-provider/strong-model");
    expect(result.escalateNotice).toBeUndefined();
    expect(client.calls).toBe(0);
  });

  test("escalateHumanMode notice returns a notice and continue mode only records the verdict", async () => {
    const noticeClient = new FakeSageClient();
    noticeClient.yesProbability = 0.98;
    noticeClient.action = "escalate_human";

    const notice = await routeTurn(
      body("notice-escalation", "too ambiguous", 1),
      undefined,
      config({ checkpointEvery: 1, firstCheckpointAt: 1, escalateHumanMode: "notice" }),
      noticeClient,
      1_000,
    );

    expect(notice.action).toBe("escalate_human");
    expect(notice.session.escalated).toBe(true);
    expect(notice.escalateNotice).toEqual(expect.any(String));
    expect(notice.escalateNotice!.length).toBeGreaterThan(0);

    const continueClient = new FakeSageClient();
    continueClient.yesProbability = 0.98;
    continueClient.action = "escalate_human";

    const continued = await routeTurn(
      body("continue-escalation", "too ambiguous", 1),
      undefined,
      config({ checkpointEvery: 1, firstCheckpointAt: 1, escalateHumanMode: "continue" }),
      continueClient,
      2_000,
    );

    expect(continued.action).toBe("escalate_human");
    expect(continued.session.escalated).toBe(true);
    expect(continued.escalateNotice).toBeUndefined();
  });

  test("without stable session identity it routes cheap and does not throw or consult Sage", async () => {
    const client = new FakeSageClient();
    const result = await routeTurn(
      { model: "sageroute", input: [{ type: "message", role: "assistant", content: "working" }] },
      undefined,
      config({ checkpointEvery: 1, firstCheckpointAt: 1 }),
      client,
      1_000,
    );

    expect(result.checkpointed).toBe(false);
    expect(result.action).toBe("continue");
    expect(result.tier).toBe("cheap");
    expect(result.modelRef).toBe("cheap-provider/cheap-model");
    expect(client.calls).toBe(0);
  });

  test("concreteRequestBody rewrites model, optionally trims polluted context, and does not mutate the original body", () => {
    const original = {
      model: "sageroute",
      input: [
        userMessage("keep the task"),
        { type: "reasoning", encrypted_content: "provider-private" },
        assistantMessage("drop narration"),
        call("kept-call", "shell", "{\"cmd\":\"bun test\"}"),
        output("kept-call", "tests passed"),
      ],
    };
    const snapshot = structuredClone(original);

    const normal = concreteRequestBody(original, "cheap-provider/cheap-model", false);
    expect(normal.model).toBe("cheap-provider/cheap-model");
    expect(normal.input).toEqual(original.input);

    const restart = concreteRequestBody(original, "strong-provider/strong-model", true);
    expect(restart.model).toBe("strong-provider/strong-model");
    expect(restart.input).toEqual([
      userMessage("keep the task"),
      call("kept-call", "shell", "{\"cmd\":\"bun test\"}"),
      output("kept-call", "tests passed"),
    ]);
    expect(original).toEqual(snapshot);
  });

  test("pricingFor returns pricing for the selected tier", () => {
    const routeConfig = config();

    expect(pricingFor(routeConfig, "cheap")).toEqual({
      inputPerMTok: 0.5,
      outputPerMTok: 1.5,
    });
    expect(pricingFor(routeConfig, "strong")).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 8,
    });
  });
});
