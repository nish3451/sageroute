import { describe, expect, test } from "bun:test";
import type { Trajectory, TrajectoryStep } from "../src/core/evidence";
import {
  computeSignals,
  headline,
  PING_PONG_THRESHOLD,
  RECENT_WINDOW,
  renderEvidence,
  REPEAT_ACTION_OBS_THRESHOLD,
  REPEAT_ERROR_CLASS_THRESHOLD,
  type SignalInputs,
  type SignalReport,
} from "../src/core/signals";

type StepFixture = Partial<TrajectoryStep> & { pending?: boolean };

const DEFAULT_INPUTS: SignalInputs = {
  model: "cheap-model",
  tier: "cheap",
  costUsd: 0,
  budgetUsd: 10,
  switchesUsed: 0,
};

function step(overrides: StepFixture = {}): TrajectoryStep {
  const index = overrides.index ?? 1;
  const tool = overrides.tool ?? "shell";
  const argsDigest = overrides.argsDigest ?? `args-${index}`;
  const outputDigest = overrides.outputDigest ?? (overrides.pending ? "" : `out-${index}`);
  const ok = overrides.ok ?? true;
  return {
    index,
    tool,
    argsDigest,
    argsPreview: overrides.argsPreview ?? argsDigest,
    outputDigest,
    outputPreview: overrides.outputPreview ?? (ok ? "ok" : "test failed"),
    ok,
    errorClass: overrides.errorClass ?? (ok ? "" : "TestFailure"),
  };
}

function trajectory(steps: StepFixture[], overrides: Partial<Trajectory> = {}): Trajectory {
  const built = steps.map((fixture, index) => step({ index: index + 1, ...fixture }));
  return {
    steps: built,
    noToolTurns: 0,
    assistantTurns: built.length,
    goal: "fix the failing tests",
    pendingCalls: built.filter(item => item.outputDigest === "").length,
    ...overrides,
  };
}

function signals(steps: StepFixture[], inputs: Partial<SignalInputs> = {}) {
  return computeSignals(trajectory(steps), { ...DEFAULT_INPUTS, ...inputs });
}

function emptyReport(overrides: Partial<SignalReport> = {}): SignalReport {
  return {
    ...signals([]),
    ...overrides,
  };
}

describe("sageroute signal detectors", () => {
  test("detects identical action and observation repeats at the threshold only", () => {
    const repeating = Array.from({ length: REPEAT_ACTION_OBS_THRESHOLD }, () => ({
      tool: "shell",
      argsDigest: "same-command",
      argsPreview: "bun test",
      outputDigest: "same-output",
      outputPreview: "same failure",
      ok: true,
    }));

    const report = signals(repeating);
    expect(report.loopDetected).toBe(true);
    expect(report.loopKind).toBe("action_observation_repeat");

    const belowThreshold = signals(repeating.slice(0, REPEAT_ACTION_OBS_THRESHOLD - 1));
    expect(belowThreshold.loopDetected).toBe(false);
    expect(belowThreshold.loopKind).toBe("");
  });

  test("detects repeated error classes at the threshold only", () => {
    const failures = Array.from({ length: REPEAT_ERROR_CLASS_THRESHOLD }, (_, index) => ({
      tool: "shell",
      argsDigest: `cmd-${index}`,
      outputDigest: `err-${index}`,
      outputPreview: `TypeError ${index}`,
      ok: false,
      errorClass: "TypeError",
    }));

    const report = signals(failures);
    expect(report.loopDetected).toBe(true);
    expect(report.loopKind).toBe("repeated_error_class");
    expect(report.repeatedErrorClass).toBe("TypeError");

    const belowThreshold = signals(failures.slice(0, REPEAT_ERROR_CLASS_THRESHOLD - 1));
    expect(belowThreshold.loopDetected).toBe(false);
    expect(belowThreshold.repeatedErrorClass).toBe("");
  });

  test("detects ping-pong action alternation at the threshold only", () => {
    const alternating = Array.from({ length: PING_PONG_THRESHOLD }, (_, index) => ({
      tool: index % 2 === 0 ? "read_file" : "shell",
      argsDigest: index % 2 === 0 ? "file-a" : "cmd-b",
      argsPreview: index % 2 === 0 ? "src/a.ts" : "bun test",
      outputDigest: `out-${index}`,
      ok: true,
    }));

    const report = signals(alternating);
    expect(report.loopDetected).toBe(true);
    expect(report.loopKind).toBe("ping_pong");

    const belowThreshold = signals(alternating.slice(0, PING_PONG_THRESHOLD - 1));
    expect(belowThreshold.loopDetected).toBe(false);
    expect(belowThreshold.loopKind).toBe("");
  });

  test("counts progress only from successful exec tools", () => {
    const report = signals([
      { tool: "exec_command", ok: true, outputPreview: "tests passed" },
      { tool: "apply_patch", argsDigest: "file-a", ok: true },
      { tool: "Write", argsDigest: "file-b", ok: true },
      { tool: "read_file", ok: true },
      { tool: "bash", ok: false, errorClass: "TestFailure" },
    ]);

    expect(report.stepsSinceProgress).toBe(4);

    const afterSuccessfulExec = signals([
      { tool: "apply_patch", ok: true },
      { tool: "bash", ok: true },
    ]);
    expect(afterSuccessfulExec.stepsSinceProgress).toBe(0);
  });

  test("counts write to failing-exec rewrite/retest cycles", () => {
    const thrashing = signals([
      { tool: "apply_patch", argsDigest: "file-a", ok: true },
      { tool: "shell", ok: false, errorClass: "TestFailure" },
      { tool: "Write", argsDigest: "file-a", ok: true },
      { tool: "bash", ok: false, errorClass: "TestFailure" },
    ]);
    expect(thrashing.rewriteRetestCycles).toBe(2);

    const converged = signals([
      { tool: "apply_patch", argsDigest: "file-a", ok: true },
      { tool: "shell", ok: true },
    ]);
    expect(converged.rewriteRetestCycles).toBe(0);
  });

  test("computes verification state from exec tools only", () => {
    const report = signals([
      { tool: "shell", ok: false, errorClass: "TestFailure" },
      { tool: "apply_patch", ok: true },
      { tool: "read_file", ok: false, errorClass: "FileNotFound" },
      { tool: "bash", ok: false, errorClass: "TestFailure" },
      { tool: "Write", ok: true },
    ]);

    expect(report.failedVerifications).toBe(2);
    expect(report.consecutiveFailedVerifications).toBe(2);
    expect(report.lastVerificationPassed).toBe(false);

    const withoutExec = signals([
      { tool: "read_file", ok: false, errorClass: "FileNotFound" },
      { tool: "apply_patch", ok: true },
    ]);
    expect(withoutExec.failedVerifications).toBe(0);
    expect(withoutExec.consecutiveFailedVerifications).toBe(0);
    expect(withoutExec.lastVerificationPassed).toBeNull();
  });

  test("uses only the last answered window for recent error rate", () => {
    const report = signals([
      { ok: false, errorClass: "OldFailure" },
      { ok: false, errorClass: "OldFailure" },
      { ok: true },
      { ok: true },
      { ok: false, errorClass: "TestFailure" },
      { ok: true },
      { ok: false, errorClass: "TestFailure" },
      { ok: true },
    ]);

    expect(report.recentErrorRate).toBeCloseTo(2 / RECENT_WINDOW);
  });

  test("excludes unanswered pending steps from signal counts", () => {
    const report = signals([
      { tool: "shell", ok: true },
      { tool: "shell", outputDigest: "", ok: false, errorClass: "TypeError" },
      { tool: "apply_patch", outputDigest: "", ok: true, argsDigest: "pending-write" },
      { tool: "shell", ok: false, errorClass: "TestFailure" },
    ]);

    expect(report.toolCalls).toBe(2);
    expect(report.toolErrors).toBe(1);
    expect(report.recentErrorRate).toBe(0.5);
    expect(report.distinctErrorClasses).toEqual(["TestFailure"]);
    expect(report.distinctFilesTouched).toBe(0);
    expect(report.failedVerifications).toBe(1);
    expect(report.consecutiveFailedVerifications).toBe(1);
    expect(report.recentActions).toHaveLength(2);
    expect(report.loopDetected).toBe(false);
  });

  test("computes budget burn without dividing by zero", () => {
    expect(signals([], { costUsd: 2.5, budgetUsd: 10 }).budgetBurn).toBe(0.25);

    const noBudget = signals([], { costUsd: 2.5, budgetUsd: 0 });
    expect(noBudget.budgetBurn).toBe(0);
    expect(Number.isFinite(noBudget.budgetBurn)).toBe(true);
  });
});

describe("sageroute signal rendering", () => {
  test("headline follows the source branch order", () => {
    expect(headline(emptyReport({
      consecutiveFailedVerifications: 3,
      loopDetected: true,
      loopKind: "ping_pong",
    }))).toBe(
      "The agent has FAILED its own checks 3 times in a row "
        + "and has not solved the task. It keeps rewriting its solution and re-running, without converging.",
    );

    expect(headline(emptyReport({
      consecutiveFailedVerifications: 2,
      loopDetected: true,
      loopKind: "ping_pong",
    }))).toBe(
      "The agent has failed its checks twice in a row; its fixes are not converging on a correct solution.",
    );

    expect(headline(emptyReport({
      loopDetected: true,
      loopKind: "action_observation_repeat",
    }))).toBe("The agent is stuck in a action_observation_repeat loop.");

    expect(headline(emptyReport({ consecutiveFailedVerifications: 1 }))).toBe(
      "The agent failed a check once and is attempting a fix.",
    );

    expect(headline(emptyReport({ lastVerificationPassed: true, toolCalls: 1 }))).toBe(
      "The agent's most recent command ran successfully.",
    );

    expect(headline(emptyReport())).toBe("The agent has not taken any action yet.");
  });

  test("renderEvidence includes the task, status, and key facts", () => {
    const report = signals([
      { tool: "shell", ok: false, errorClass: "TestFailure", outputPreview: "test failed" },
    ], {
      costUsd: 1,
      budgetUsd: 4,
      switchesUsed: 2,
    });

    const rendered = renderEvidence(report, "stabilize the router");
    expect(rendered).toContain("TASK: stabilize the router");
    expect(rendered).toContain("STATUS: The agent failed a check once and is attempting a fix.");
    expect(rendered).toContain("loop_detected=false");
    expect(rendered).toContain("consecutive_failed_verifications=1");
    expect(rendered).toContain("budget_burn=0.25");
    expect(rendered).toContain("model_switches_already_used=2");

    expect(renderEvidence(report, "")).toContain("TASK: (not stated)");
  });
});
