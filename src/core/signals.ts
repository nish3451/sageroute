/**
 * Derived signals over a recovered trajectory.
 *
 * Cheap deterministic detectors run before Sage is ever consulted: loops, error-rate
 * spikes, stalls, thrash cycles, budget burn. Sage then judges the SUMMARY rather than
 * the transcript, which keeps the request small and keeps the router honest about what
 * counts as evidence.
 */

import type { Trajectory, TrajectoryStep } from "./evidence";

/**
 * Repetition thresholds follow common agent-harness practice: an identical action with
 * an identical observation 3+ times means the agent has stopped learning; the same error
 * class 3+ times in a row means it is stuck.
 */
export const REPEAT_ACTION_OBS_THRESHOLD = 3;
export const REPEAT_ERROR_CLASS_THRESHOLD = 3;
export const PING_PONG_THRESHOLD = 4;
export const RECENT_WINDOW = 6;

/** Tools that mutate the workspace, as named by Codex and Claude Code respectively. */
const WRITE_TOOLS = new Set([
  "apply_patch", "write_file", "edit_file", "str_replace_editor", "Edit", "Write", "MultiEdit",
]);
/** Tools that execute something -- the only place a real verification can happen. */
const EXEC_TOOLS = new Set([
  "shell", "exec_command", "run_command", "bash", "Bash", "container.exec",
]);

export interface SignalReport {
  step: number;
  model: string;
  tier: "cheap" | "strong";
  toolCalls: number;
  toolErrors: number;
  recentErrorRate: number;
  distinctErrorClasses: string[];
  repeatedErrorClass: string;
  loopDetected: boolean;
  loopKind: string;
  noToolCallStreak: number;
  distinctFilesTouched: number;
  /** Executions that ran and failed: the closest thing to a failed verification here. */
  failedVerifications: number;
  consecutiveFailedVerifications: number;
  lastVerificationPassed: boolean | null;
  /** write -> failing-exec -> write -> failing-exec cycles. */
  rewriteRetestCycles: number;
  stepsSinceProgress: number;
  costUsd: number;
  budgetUsd: number;
  budgetBurn: number;
  switchesUsed: number;
  recentActions: string[];
  lastErrorPreview: string;
}

export interface SignalInputs {
  model: string;
  tier: "cheap" | "strong";
  costUsd: number;
  budgetUsd: number;
  switchesUsed: number;
}

function trailingStreak<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let streak = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!predicate(items[i]!)) break;
    streak += 1;
  }
  return streak;
}

function isExec(step: TrajectoryStep): boolean {
  return EXEC_TOOLS.has(step.tool);
}

function isWrite(step: TrajectoryStep): boolean {
  return WRITE_TOOLS.has(step.tool);
}

/** Only answered steps are evidence: a pending call has not told us anything yet. */
function answered(steps: readonly TrajectoryStep[]): TrajectoryStep[] {
  return steps.filter(step => step.outputDigest !== "");
}

function detectLoops(report: SignalReport, steps: readonly TrajectoryStep[]): void {
  if (steps.length < 2) return;

  // 1. Identical action producing an identical observation.
  let bestRun = 1;
  let run = 1;
  let prevKey: string | null = null;
  for (const step of steps) {
    const key = `${step.tool}|${step.argsDigest}|${step.outputDigest}`;
    run = key === prevKey ? run + 1 : 1;
    prevKey = key;
    if (run > bestRun) bestRun = run;
  }
  if (bestRun >= REPEAT_ACTION_OBS_THRESHOLD) {
    report.loopDetected = true;
    report.loopKind = "action_observation_repeat";
    return;
  }

  // 2. The same error class recurring back to back.
  let errRun = 0;
  let prevClass: string | null = null;
  for (const step of steps) {
    if (step.ok) {
      errRun = 0;
      prevClass = null;
      continue;
    }
    const cls = step.errorClass || "Unknown";
    errRun = cls === prevClass ? errRun + 1 : 1;
    prevClass = cls;
    if (errRun >= REPEAT_ERROR_CLASS_THRESHOLD) {
      report.loopDetected = true;
      report.loopKind = "repeated_error_class";
      report.repeatedErrorClass = cls;
      return;
    }
  }

  // 3. Ping-pong between two alternating actions.
  const keys = steps.slice(-PING_PONG_THRESHOLD * 2).map(step => `${step.tool}|${step.argsDigest}`);
  if (keys.length >= PING_PONG_THRESHOLD && new Set(keys).size === 2) {
    let alternating = true;
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i] === keys[i + 1]) {
        alternating = false;
        break;
      }
    }
    if (alternating) {
      report.loopDetected = true;
      report.loopKind = "ping_pong";
    }
  }
}

/**
 * Steps since anything genuinely moved the task forward.
 *
 * Progress means a successful execution, not a file rewrite. Counting a rewrite as
 * progress is exactly what lets a thrashing agent look healthy: it rewrites, the test
 * fails, it rewrites again, and a naive counter resets every single time.
 */
function stepsSinceProgress(steps: readonly TrajectoryStep[]): number {
  let lastProgress = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.ok && isExec(step)) lastProgress = i + 1;
  }
  return Math.max(0, steps.length - lastProgress);
}

/**
 * Count write -> failing-exec cycles. This is the signature of a model that understands
 * the shape of the problem but cannot solve it: it never repeats an identical action, so
 * naive loop detection stays silent while it burns the whole budget.
 */
function rewriteRetestCycles(steps: readonly TrajectoryStep[]): number {
  let cycles = 0;
  let sawWrite = false;
  for (const step of steps) {
    if (isWrite(step) && step.ok) {
      sawWrite = true;
    } else if (isExec(step) && !step.ok && sawWrite) {
      cycles += 1;
      sawWrite = false;
    }
  }
  return cycles;
}

export function computeSignals(trajectory: Trajectory, inputs: SignalInputs): SignalReport {
  const steps = answered(trajectory.steps);
  const report: SignalReport = {
    step: trajectory.steps.length,
    model: inputs.model,
    tier: inputs.tier,
    toolCalls: steps.length,
    toolErrors: 0,
    recentErrorRate: 0,
    distinctErrorClasses: [],
    repeatedErrorClass: "",
    loopDetected: false,
    loopKind: "",
    noToolCallStreak: trajectory.noToolTurns,
    distinctFilesTouched: 0,
    failedVerifications: 0,
    consecutiveFailedVerifications: 0,
    lastVerificationPassed: null,
    rewriteRetestCycles: 0,
    stepsSinceProgress: 0,
    costUsd: inputs.costUsd,
    budgetUsd: inputs.budgetUsd,
    budgetBurn: inputs.budgetUsd > 0 ? inputs.costUsd / inputs.budgetUsd : 0,
    switchesUsed: inputs.switchesUsed,
    recentActions: [],
    lastErrorPreview: "",
  };

  const failures = steps.filter(step => !step.ok);
  report.toolErrors = failures.length;
  report.distinctErrorClasses = [...new Set(failures.map(step => step.errorClass).filter(Boolean))].sort();
  if (failures.length > 0) report.lastErrorPreview = failures[failures.length - 1]!.outputPreview;

  const recent = steps.slice(-RECENT_WINDOW);
  if (recent.length > 0) {
    report.recentErrorRate = recent.filter(step => !step.ok).length / recent.length;
  }

  report.distinctFilesTouched = new Set(
    steps.filter(step => isWrite(step)).map(step => step.argsDigest),
  ).size;

  const execs = steps.filter(isExec);
  report.failedVerifications = execs.filter(step => !step.ok).length;
  report.consecutiveFailedVerifications = trailingStreak(execs, step => !step.ok);
  report.lastVerificationPassed = execs.length > 0 ? execs[execs.length - 1]!.ok : null;
  report.rewriteRetestCycles = rewriteRetestCycles(steps);
  report.stepsSinceProgress = stepsSinceProgress(steps);
  report.recentActions = recent.map(
    step => `${step.tool}(${step.argsPreview.slice(0, 40)})->${step.ok ? "ok" : step.errorClass || "err"}`,
  );

  detectLoops(report, steps);
  return report;
}

/**
 * One plain-language line stating whether the agent is actually winning.
 *
 * Buried evidence gets discounted by the judge, so the summary leads with this rather
 * than making Sage infer the story from a wall of counters.
 */
export function headline(report: SignalReport): string {
  if (report.consecutiveFailedVerifications >= 3) {
    return `The agent has FAILED its own checks ${report.consecutiveFailedVerifications} times in a row `
      + "and has not solved the task. It keeps rewriting its solution and re-running, without converging.";
  }
  if (report.consecutiveFailedVerifications === 2) {
    return "The agent has failed its checks twice in a row; its fixes are not converging on a correct solution.";
  }
  if (report.loopDetected) {
    return `The agent is stuck in a ${report.loopKind} loop.`;
  }
  if (report.consecutiveFailedVerifications === 1) {
    return "The agent failed a check once and is attempting a fix.";
  }
  if (report.lastVerificationPassed === true) {
    return "The agent's most recent command ran successfully.";
  }
  if (report.toolCalls === 0) {
    return "The agent has not taken any action yet.";
  }
  return "The agent is making apparent progress.";
}

/** Serialize for Sage's `content` field: compact, factual, no raw chain of thought. */
export function renderEvidence(report: SignalReport, goal: string): string {
  const lines = [
    `TASK: ${goal || "(not stated)"}`,
    "",
    `STATUS: ${headline(report)}`,
    "",
    `current_model=${report.model} (${report.tier} tier) step=${report.step}`,
    `tool_calls=${report.toolCalls} tool_errors=${report.toolErrors} `
      + `recent_error_rate=${report.recentErrorRate.toFixed(2)}`,
    `error_classes=${report.distinctErrorClasses.join(",") || "none"}`,
    `repeated_error_class=${report.repeatedErrorClass || "none"}`,
    `loop_detected=${report.loopDetected} loop_kind=${report.loopKind || "none"}`,
    `consecutive_failed_verifications=${report.consecutiveFailedVerifications}`,
    `rewrite_retest_fail_cycles=${report.rewriteRetestCycles}`,
    `steps_since_progress=${report.stepsSinceProgress} no_tool_call_streak=${report.noToolCallStreak}`,
    `files_touched=${report.distinctFilesTouched}`,
    `verifications_run=${report.failedVerifications + (report.lastVerificationPassed === true ? 1 : 0)} `
      + `last_verification_passed=${report.lastVerificationPassed === null ? "unknown" : report.lastVerificationPassed}`,
    `cost_usd=${report.costUsd.toFixed(4)} budget_usd=${report.budgetUsd.toFixed(2)} `
      + `budget_burn=${report.budgetBurn.toFixed(2)}`,
    `model_switches_already_used=${report.switchesUsed}`,
  ];
  if (report.recentActions.length > 0) {
    lines.push(`recent_actions: ${report.recentActions.join(" | ")}`);
  }
  if (report.lastErrorPreview) {
    lines.push(`last_error: ${report.lastErrorPreview}`);
  }
  return lines.join("\n");
}
