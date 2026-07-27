import { describe, expect, test } from "bun:test";
import {
  decide,
  type LadderState,
  ROUTE_OPTIONS,
  type Verdict,
} from "../src/core/policy";
import {
  OfflineSageClient,
  SageError,
  type SageChoiceOption,
  type SageClient,
  type SageDecision,
} from "../src/core/sage";
import type { SignalReport } from "../src/core/signals";
import {
  resolveSageRouteConfig,
  SAGEROUTE_ACTIONS,
  type SageRouteConfig,
  type ResolvedSageRouteConfig,
} from "../src/core/types";

type QueuedDecision = SageDecision | Error;

class FakeSageClient implements SageClient {
  yesnoCalls = 0;
  choiceCalls = 0;
  choiceOptions: SageChoiceOption[][] = [];

  constructor(
    private readonly yesnoQueue: QueuedDecision[] = [],
    private readonly choiceQueue: QueuedDecision[] = [],
  ) {}

  async yesno(_content: string, _questionId: string, _instructions: string): Promise<SageDecision> {
    this.yesnoCalls += 1;
    return this.next(this.yesnoQueue, "yesno");
  }

  async choice(
    _content: string,
    _questionId: string,
    _instructions: string,
    options: SageChoiceOption[],
  ): Promise<SageDecision> {
    this.choiceCalls += 1;
    this.choiceOptions.push(options);
    return this.next(this.choiceQueue, "choice");
  }

  private next(queue: QueuedDecision[], kind: "yesno" | "choice"): SageDecision {
    const result = queue.shift();
    if (result instanceof Error) throw result;
    if (result) return result;
    throw new Error(`unexpected ${kind} call`);
  }
}

function yesno(probability: number, overrides: Partial<SageDecision> = {}): SageDecision {
  return {
    kind: "yesno",
    answer: probability >= 0.5 ? "yes" : "no",
    confidence: Math.abs(probability - 0.5) * 2,
    probabilities: { yes: probability, no: 1 - probability },
    latencyMs: 7,
    model: "fake-sage",
    source: "sage",
    ...overrides,
  };
}

function choice(
  answer: string,
  probabilities: Record<string, number>,
  overrides: Partial<SageDecision> = {},
): SageDecision {
  return {
    kind: "choice",
    answer,
    confidence: probabilities[answer] ?? 0.77,
    probabilities,
    latencyMs: 11,
    model: "fake-sage",
    source: "sage",
    ...overrides,
  };
}

function config(overrides: Partial<SageRouteConfig> = {}): ResolvedSageRouteConfig {
  return resolveSageRouteConfig({
    cheap: { provider: "cheap-provider", model: "cheap-model" },
    strong: { provider: "strong-provider", model: "strong-model" },
    ...overrides,
  });
}

function report(overrides: Partial<SignalReport> = {}): SignalReport {
  return {
    step: 4,
    model: "cheap-model",
    tier: "cheap",
    toolCalls: 4,
    toolErrors: 0,
    recentErrorRate: 0,
    distinctErrorClasses: [],
    repeatedErrorClass: "",
    loopDetected: false,
    loopKind: "",
    noToolCallStreak: 0,
    distinctFilesTouched: 1,
    failedVerifications: 0,
    consecutiveFailedVerifications: 0,
    lastVerificationPassed: true,
    rewriteRetestCycles: 0,
    stepsSinceProgress: 0,
    costUsd: 0.01,
    budgetUsd: 10,
    budgetBurn: 0.001,
    switchesUsed: 0,
    recentActions: ["shell(bun test)->ok"],
    lastErrorPreview: "",
    ...overrides,
  };
}

function state(overrides: Partial<LadderState> = {}): LadderState {
  return {
    switchesUsed: 0,
    restartsUsed: 0,
    consecutiveBad: 0,
    ...overrides,
  };
}

async function route(
  client: SageClient,
  cfg: ResolvedSageRouteConfig,
  rpt: SignalReport,
  ladder: LadderState,
): Promise<Verdict> {
  return decide(client, cfg, rpt, "stabilize the agent trajectory", ladder);
}

describe("sageroute policy ladder", () => {
  test("stops locally on budget burn before calling Sage", async () => {
    const client = new FakeSageClient([yesno(0.99)], [choice("switch_model", { switch_model: 0.99 })]);
    const ladder = state({ consecutiveBad: 1 });

    const verdict = await route(
      client,
      config({ budgetUsd: 10, budgetEscalateFraction: 0.5 }),
      report({ budgetBurn: 0.5 }),
      ladder,
    );

    expect(verdict.action).toBe("escalate_human");
    expect(verdict.source).toBe("local");
    expect(client.yesnoCalls).toBe(0);
    expect(client.choiceCalls).toBe(0);
    expect(ladder).toEqual({ switchesUsed: 0, restartsUsed: 0, consecutiveBad: 1 });
  });

  test("continues and resets bad streak when the intervention gate is below threshold", async () => {
    const client = new FakeSageClient([yesno(0.42)], [choice("switch_model", { switch_model: 0.99 })]);
    const ladder = state({ consecutiveBad: 3 });

    const verdict = await route(client, config(), report(), ladder);

    expect(verdict.action).toBe("continue");
    expect(verdict.source).toBe("sage");
    expect(verdict.interventionProbability).toBe(0.42);
    expect(client.yesnoCalls).toBe(1);
    expect(client.choiceCalls).toBe(0);
    expect(ladder.consecutiveBad).toBe(0);
  });

  test("fails open when Sage is unavailable at either stage", async () => {
    const sageErrorClient = new FakeSageClient([new SageError("quota unavailable")]);
    const sageErrorState = state({ consecutiveBad: 2 });
    const sageErrorVerdict = await route(sageErrorClient, config(), report(), sageErrorState);

    expect(sageErrorVerdict.action).toBe("continue");
    expect(sageErrorVerdict.source).toBe("local");
    expect(sageErrorVerdict.reason).toContain("quota unavailable");
    expect(sageErrorClient.yesnoCalls).toBe(1);
    expect(sageErrorClient.choiceCalls).toBe(0);
    expect(sageErrorState.consecutiveBad).toBe(2);

    const plainErrorClient = new FakeSageClient([new Error("socket reset")]);
    const plainErrorVerdict = await route(plainErrorClient, config(), report(), state());
    expect(plainErrorVerdict.action).toBe("continue");
    expect(plainErrorVerdict.source).toBe("local");
    expect(plainErrorVerdict.reason).toContain("socket reset");

    const choiceErrorClient = new FakeSageClient([yesno(0.9)], [new Error("choice timeout")]);
    const choiceErrorState = state();
    const choiceErrorVerdict = await route(choiceErrorClient, config(), report(), choiceErrorState);

    expect(choiceErrorVerdict.action).toBe("continue");
    expect(choiceErrorVerdict.source).toBe("local");
    expect(choiceErrorVerdict.interventionProbability).toBe(0.9);
    expect(choiceErrorClient.yesnoCalls).toBe(1);
    expect(choiceErrorClient.choiceCalls).toBe(1);
    expect(choiceErrorState.consecutiveBad).toBe(0);
  });

  test("uses the highest-probability non-continue action when the gate fires but choice says continue", async () => {
    const client = new FakeSageClient([
      yesno(0.91),
    ], [
      choice("continue", {
        continue: 0.96,
        switch_model: 0.2,
        restart_clean: 0.4,
        escalate_human: 0.74,
      }),
    ]);
    const ladder = state();

    const verdict = await route(
      client,
      config({ consecutiveBadRequired: 1 }),
      report(),
      ladder,
    );

    expect(verdict.action).toBe("escalate_human");
    expect(verdict.probabilities.escalate_human).toBe(0.74);
    expect(client.choiceOptions[0]).toEqual(ROUTE_OPTIONS);
    expect(ladder.consecutiveBad).toBe(0);
  });

  test("defaults to switch_model when the gate fires but choice says continue with no probabilities", async () => {
    const client = new FakeSageClient([yesno(0.9)], [choice("continue", {})]);
    const ladder = state();

    const verdict = await route(client, config(), report(), ladder);

    expect(verdict.action).toBe("switch_model");
    expect(verdict.reason).toBe("agent struggling on cheap model; escalating capability");
    expect(ladder.switchesUsed).toBe(1);
    expect(ladder.consecutiveBad).toBe(0);
  });

  test("upgrades capability before retrying clean on the cheap tier", async () => {
    const client = new FakeSageClient([yesno(0.9)], [choice("restart_clean", { restart_clean: 0.88 })]);
    const ladder = state();

    const verdict = await route(client, config(), report(), ladder);

    expect(verdict.action).toBe("switch_model");
    expect(ladder.switchesUsed).toBe(1);
    expect(ladder.restartsUsed).toBe(0);
  });

  test("switches from cheap to strong after one bad checkpoint even when other actions need two", async () => {
    const client = new FakeSageClient([yesno(0.9)], [choice("switch_model", { switch_model: 0.9 })]);
    const ladder = state();

    const verdict = await route(client, config({ consecutiveBadRequired: 2 }), report(), ladder);

    expect(verdict.action).toBe("switch_model");
    expect(ladder.switchesUsed).toBe(1);
    expect(ladder.consecutiveBad).toBe(0);
  });

  test("holds restart_clean until enough consecutive bad checkpoints accumulate", async () => {
    const client = new FakeSageClient([
      yesno(0.9),
      yesno(0.9),
    ], [
      choice("restart_clean", { restart_clean: 0.9 }),
      choice("restart_clean", { restart_clean: 0.9 }),
    ]);
    const ladder = state();
    const cfg = config({ consecutiveBadRequired: 2 });
    const strongReport = report({ tier: "strong", model: "strong-model", switchesUsed: 1 });

    const first = await route(client, cfg, strongReport, ladder);
    expect(first.action).toBe("continue");
    expect(first.source).toBe("local");
    expect(first.reason).toBe("bad checkpoint 1/2, holding");
    expect(ladder).toEqual({ switchesUsed: 0, restartsUsed: 0, consecutiveBad: 1 });

    const second = await route(client, cfg, strongReport, ladder);
    expect(second.action).toBe("restart_clean");
    expect(ladder).toEqual({ switchesUsed: 0, restartsUsed: 1, consecutiveBad: 0 });
  });

  test("holds escalate_human until enough consecutive bad checkpoints accumulate", async () => {
    const client = new FakeSageClient([
      yesno(0.9),
      yesno(0.9),
    ], [
      choice("escalate_human", { escalate_human: 0.9 }),
      choice("escalate_human", { escalate_human: 0.9 }),
    ]);
    const ladder = state();
    const cfg = config({ consecutiveBadRequired: 2 });

    const first = await route(client, cfg, report(), ladder);
    expect(first.action).toBe("continue");
    expect(first.reason).toBe("bad checkpoint 1/2, holding");
    expect(ladder.consecutiveBad).toBe(1);

    const second = await route(client, cfg, report(), ladder);
    expect(second.action).toBe("escalate_human");
    expect(second.reason).toBe("sage escalated to human review");
    expect(ladder.consecutiveBad).toBe(0);
  });

  test("never demotes from strong tier and escalates when clean restarts are exhausted", async () => {
    const cfg = config({ consecutiveBadRequired: 1, maxRestarts: 1 });
    const strongReport = report({ tier: "strong", model: "strong-model", switchesUsed: 1 });

    const restartClient = new FakeSageClient([yesno(0.9)], [choice("switch_model", { switch_model: 0.9 })]);
    const restartState = state();
    const restartVerdict = await route(restartClient, cfg, strongReport, restartState);
    expect(restartVerdict.action).toBe("restart_clean");
    expect(restartVerdict.reason).toBe("already on strong model; restarting clean instead");
    expect(restartState.restartsUsed).toBe(1);

    const exhaustedClient = new FakeSageClient([yesno(0.9)], [choice("switch_model", { switch_model: 0.9 })]);
    const exhaustedState = state({ restartsUsed: 1 });
    const exhaustedVerdict = await route(exhaustedClient, cfg, strongReport, exhaustedState);
    expect(exhaustedVerdict.action).toBe("escalate_human");
    expect(exhaustedVerdict.reason).toBe("strong model still failing and restarts exhausted");
    expect(exhaustedState.restartsUsed).toBe(1);
  });

  test("escalates to human when switch or restart rungs are exhausted", async () => {
    const switchClient = new FakeSageClient([yesno(0.9)], [choice("switch_model", { switch_model: 0.9 })]);
    const switchState = state({ switchesUsed: 1 });
    const switchVerdict = await route(
      switchClient,
      config({ consecutiveBadRequired: 1, maxSwitches: 1 }),
      report(),
      switchState,
    );

    expect(switchVerdict.action).toBe("escalate_human");
    expect(switchVerdict.reason).toBe("switch budget exhausted");
    expect(switchState.switchesUsed).toBe(1);
    expect(switchState.consecutiveBad).toBe(0);

    const restartClient = new FakeSageClient([yesno(0.9)], [choice("restart_clean", { restart_clean: 0.9 })]);
    const restartState = state({ restartsUsed: 1 });
    const restartVerdict = await route(
      restartClient,
      config({ consecutiveBadRequired: 1, maxRestarts: 1 }),
      report({ tier: "strong", model: "strong-model", switchesUsed: 1 }),
      restartState,
    );

    expect(restartVerdict.action).toBe("escalate_human");
    expect(restartVerdict.reason).toBe("restart budget exhausted");
    expect(restartState.restartsUsed).toBe(1);
    expect(restartState.consecutiveBad).toBe(0);
  });

  test("ignores unrecognized choice answers without producing an invalid action", async () => {
    const client = new FakeSageClient([
      yesno(0.9),
    ], [
      choice("launch_rocket", {
        launch_rocket: 0.99,
        continue: 0.01,
      }),
    ]);
    const ladder = state();

    const verdict = await route(client, config(), report(), ladder);

    expect(SAGEROUTE_ACTIONS).toContain(verdict.action);
    expect(verdict.action).toBe("switch_model");
    expect(ladder.switchesUsed).toBe(1);
  });

  test("routes end to end with OfflineSageClient", async () => {
    const healthyClient = new OfflineSageClient();
    const healthyState = state({ consecutiveBad: 1 });
    const healthy = await route(healthyClient, config(), report(), healthyState);

    expect(healthy.action).toBe("continue");
    expect(healthy.source).toBe("offline");
    expect(healthyState.consecutiveBad).toBe(0);
    expect(healthyClient.calls).toBe(1);

    const failingClient = new OfflineSageClient();
    const failingState = state();
    const failing = await route(
      failingClient,
      config(),
      report({
        toolErrors: 5,
        recentErrorRate: 0.83,
        distinctErrorClasses: ["TestFailure"],
        repeatedErrorClass: "TestFailure",
        loopDetected: true,
        loopKind: "repeated_error_class",
        failedVerifications: 3,
        consecutiveFailedVerifications: 3,
        lastVerificationPassed: false,
        rewriteRetestCycles: 3,
        stepsSinceProgress: 5,
        recentActions: [
          "shell(bun test)->TestFailure",
          "apply_patch(src/router.ts)->ok",
          "shell(bun test)->TestFailure",
        ],
        lastErrorPreview: "FAILED tests/sageroute-policy.test.ts",
      }),
      failingState,
    );

    expect(failing.action).toBe("switch_model");
    expect(failing.source).toBe("offline");
    expect(failingState.switchesUsed).toBe(1);
    expect(failingClient.calls).toBe(2);
  });
});
