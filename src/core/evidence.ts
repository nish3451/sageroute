/**
 * Turn a `/v1/responses` request into typed trajectory evidence.
 *
 * Every Codex turn resends the whole conversation, so the inbound `input` array IS the
 * agent's execution history: function calls it made, the outputs it got back, and the
 * assistant text between them. That is the raw material for a trajectory-aware verdict,
 * and it arrives for free on a request the proxy is already handling.
 *
 * Raw model reasoning never becomes evidence on its own. It is reduced to counts,
 * classes, and digests so decisions rest on what the agent DID, not on what it said
 * about itself.
 */

import { createHash } from "node:crypto";

export interface TrajectoryStep {
  /** 1-based position in the recovered action sequence. */
  index: number;
  tool: string;
  argsDigest: string;
  argsPreview: string;
  outputDigest: string;
  outputPreview: string;
  ok: boolean;
  errorClass: string;
}

export interface Trajectory {
  steps: TrajectoryStep[];
  /** Assistant turns with no tool call: the agent talked instead of acting. */
  noToolTurns: number;
  /** Total assistant message items seen. */
  assistantTurns: number;
  /** First user message, trimmed -- the task statement handed to Sage. */
  goal: string;
  /** Tool calls still awaiting an output item (the call being answered right now). */
  pendingCalls: number;
}

const PREVIEW_MAX = 220;
const GOAL_MAX = 600;

export function digest(text: string, length = 12): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/**
 * Bucket an observation into a coarse, comparable error class. Comparability is the
 * whole point: "the same error class three times in a row" is the signal, and that
 * requires collapsing line numbers and paths out of the message.
 */
export function classifyError(text: string): string {
  const lowered = text.toLowerCase();
  const table: Array<[string, string]> = [
    ["modulenotfounderror", "ModuleNotFoundError"],
    ["importerror", "ImportError"],
    ["syntaxerror", "SyntaxError"],
    ["indentationerror", "IndentationError"],
    ["nameerror", "NameError"],
    ["typeerror", "TypeError"],
    ["valueerror", "ValueError"],
    ["attributeerror", "AttributeError"],
    ["keyerror", "KeyError"],
    ["indexerror", "IndexError"],
    ["zerodivisionerror", "ZeroDivisionError"],
    ["assertionerror", "AssertionError"],
    ["segmentation fault", "SegFault"],
    ["no such file", "FileNotFound"],
    ["cannot find module", "ModuleNotFoundError"],
    ["command not found", "CommandNotFound"],
    ["permission denied", "PermissionDenied"],
    ["timed out", "Timeout"],
    ["traceback (most recent call last)", "PythonTraceback"],
    ["exit code 1", "NonZeroExit"],
    ["test failed", "TestFailure"],
    ["tests failed", "TestFailure"],
    ["failing", "TestFailure"],
    ["failed", "GenericFailure"],
    ["error", "GenericError"],
  ];
  for (const [needle, label] of table) {
    if (lowered.includes(needle)) return label;
  }
  return "Unknown";
}

/**
 * Decide whether a tool result represents a failure. Tool transports rarely set a
 * structured error flag on this wire, so the observation text is the only honest source.
 * Anchored on failure vocabulary that survives across shells, test runners, and linters.
 */
export function looksLikeFailure(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) return false;
  const negative = [
    "traceback (most recent call last)",
    "error:",
    "error ",
    "exception",
    "failed",
    "failing",
    "no such file",
    "command not found",
    "permission denied",
    "timed out",
    "exit code 1",
    "exit code 2",
    "assertionerror",
    "syntaxerror",
    "cannot find module",
  ];
  return negative.some(needle => lowered.includes(needle));
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten the several shapes a tool output can take on this wire into plain text. */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const raw of output) {
      if (typeof raw === "string") {
        parts.push(raw);
      } else if (isObj(raw)) {
        const text = raw.text ?? raw.output ?? raw.refusal;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  if (isObj(output)) {
    // codex-rs FunctionCallOutputPayload sometimes arrives as {content,success}.
    const content = output.content ?? output.output ?? output.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return outputText(content);
  }
  return "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (isObj(raw) && typeof raw.text === "string") parts.push(raw.text);
  }
  return parts.join("\n");
}

/** Explicit success/failure flag when the client bothered to send one. */
function declaredSuccess(output: unknown): boolean | undefined {
  if (isObj(output) && typeof output.success === "boolean") return output.success;
  return undefined;
}

/**
 * Recover the action sequence from a Responses `input` array by pairing each
 * `function_call` with the `function_call_output` that answers it.
 */
export function extractTrajectory(input: unknown): Trajectory {
  const trajectory: Trajectory = {
    steps: [],
    noToolTurns: 0,
    assistantTurns: 0,
    goal: "",
    pendingCalls: 0,
  };
  if (typeof input === "string") {
    trajectory.goal = input.slice(0, GOAL_MAX);
    return trajectory;
  }
  if (!Array.isArray(input)) return trajectory;

  interface PendingCall {
    tool: string;
    args: string;
  }
  const pending = new Map<string, PendingCall>();
  // Preserve call order: outputs can arrive out of order, but the ladder reasons about
  // the sequence the agent actually executed.
  const ordered: Array<{ callId: string; step: TrajectoryStep }> = [];

  for (const raw of input) {
    if (!isObj(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : undefined;
    const role = typeof raw.role === "string" ? raw.role : undefined;

    if (!trajectory.goal && (role === "user" || (type === "message" && role === "user"))) {
      const text = messageText(raw.content).trim();
      if (text) trajectory.goal = text.slice(0, GOAL_MAX);
      continue;
    }

    if (role === "assistant") {
      trajectory.assistantTurns += 1;
      continue;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const callId = typeof raw.call_id === "string" ? raw.call_id : "";
      const tool = typeof raw.name === "string" ? raw.name : "unknown";
      const args = typeof raw.arguments === "string"
        ? raw.arguments
        : typeof raw.input === "string" ? raw.input : "";
      const step: TrajectoryStep = {
        index: ordered.length + 1,
        tool,
        argsDigest: digest(`${tool}|${args}`),
        argsPreview: args.replace(/\s+/g, " ").slice(0, PREVIEW_MAX),
        outputDigest: "",
        outputPreview: "",
        ok: true,
        errorClass: "",
      };
      ordered.push({ callId, step });
      if (callId) pending.set(callId, { tool, args });
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = typeof raw.call_id === "string" ? raw.call_id : "";
      const text = outputText(raw.output);
      const declared = declaredSuccess(raw.output);
      const ok = declared ?? !looksLikeFailure(text);
      const match = ordered.find(entry => entry.callId === callId && !entry.step.outputDigest);
      const target = match?.step;
      if (target) {
        target.outputDigest = digest(text) || digest("");
        target.outputPreview = text.replace(/\s+/g, " ").slice(0, PREVIEW_MAX);
        target.ok = ok;
        target.errorClass = ok ? "" : classifyError(text);
        pending.delete(callId);
      }
      continue;
    }
  }

  trajectory.steps = ordered.map(entry => entry.step);
  trajectory.pendingCalls = trajectory.steps.filter(step => !step.outputDigest).length;
  // An assistant turn that produced no tool call is the agent narrating instead of
  // acting. Counting it needs the call sequence, so it is derived rather than tallied
  // inline: total assistant messages minus the ones that carried at least one call.
  trajectory.noToolTurns = Math.max(0, trajectory.assistantTurns - trajectory.steps.length);
  return trajectory;
}
