import { describe, expect, test } from "bun:test";
import {
  classifyError,
  digest,
  extractTrajectory,
  looksLikeFailure,
  outputText,
} from "../src/core/evidence";

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistantMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function call(call_id: string | undefined, name: string, args: string): Record<string, unknown> {
  return { type: "function_call", call_id, name, arguments: args };
}

function output(call_id: string | undefined, output: unknown): Record<string, unknown> {
  return { type: "function_call_output", call_id, output };
}

describe("Sage route evidence", () => {
  test("pairs calls to outputs by call_id while preserving issued call order", () => {
    const trajectory = extractTrajectory([
      userMessage("run the checks"),
      call("call-a", "shell", "{\"cmd\":\"bun test\"}"),
      call("call-b", "read_file", "{\"path\":\"src/index.ts\"}"),
      output("call-b", "file contents"),
      output("call-a", "tests passed"),
    ]);

    expect(trajectory.steps.map(step => step.tool)).toEqual(["shell", "read_file"]);
    expect(trajectory.steps.map(step => step.outputPreview)).toEqual(["tests passed", "file contents"]);
    expect(trajectory.steps.map(step => step.index)).toEqual([1, 2]);
    expect(trajectory.pendingCalls).toBe(0);
  });

  test("marks heuristic failures with error classes and leaves clean outputs ok", () => {
    const trajectory = extractTrajectory([
      call("trace", "python", "{}"),
      call("missing-command", "shell", "{}"),
      call("failed", "runner", "{}"),
      call("clean", "shell", "{}"),
      output("trace", "Traceback (most recent call last):\n  boom"),
      output("missing-command", "zsh: bunx: command not found"),
      output("failed", "FAILED tests/example.test.ts"),
      output("clean", "3 tests passed"),
    ]);

    expect(trajectory.steps.map(step => step.ok)).toEqual([false, false, false, true]);
    expect(trajectory.steps.map(step => step.errorClass)).toEqual([
      "PythonTraceback",
      "CommandNotFound",
      "GenericFailure",
      "",
    ]);
    expect(looksLikeFailure("command not found")).toBe(true);
    expect(looksLikeFailure("all good")).toBe(false);
  });

  test("honors explicit structured success flags over text heuristics", () => {
    const trajectory = extractTrajectory([
      call("declared-false", "shell", "{}"),
      call("declared-true", "shell", "{}"),
      output("declared-false", { success: false, content: "completed normally" }),
      output("declared-true", { success: true, content: "FAILED with scary looking text" }),
    ]);

    expect(trajectory.steps[0]).toMatchObject({
      ok: false,
      errorClass: "Unknown",
      outputPreview: "completed normally",
    });
    expect(trajectory.steps[1]).toMatchObject({
      ok: true,
      errorClass: "",
      outputPreview: "FAILED with scary looking text",
    });
  });

  test("flattens supported output shapes into text", () => {
    expect(outputText("plain")).toBe("plain");
    expect(outputText([{ type: "output_text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
    expect(outputText({ content: "wrapped" })).toBe("wrapped");
    expect(outputText({ content: [{ type: "output_text", text: "nested" }, { type: "text", text: "blocks" }] }))
      .toBe("nested\nblocks");
    expect(outputText({ no: "text here" })).toBe("");
    expect(outputText(7)).toBe("");
  });

  test("classifies representative error strings", () => {
    expect(classifyError("ModuleNotFoundError: no module named requests")).toBe("ModuleNotFoundError");
    expect(classifyError("SyntaxError: unexpected token")).toBe("SyntaxError");
    expect(classifyError("Traceback (most recent call last):")).toBe("PythonTraceback");
    expect(classifyError("zsh: npm: command not found")).toBe("CommandNotFound");
    expect(classifyError("Permission denied")).toBe("PermissionDenied");
    expect(classifyError("Tests failed in suite")).toBe("TestFailure");
    expect(classifyError("nothing recognizable")).toBe("Unknown");
  });

  test("extracts and truncates the goal from the first user message or string input", () => {
    const longGoal = `${"x".repeat(620)} trailing`;
    const trajectory = extractTrajectory([
      assistantMessage("I can help."),
      userMessage(longGoal),
      userMessage("second user message"),
    ]);

    expect(trajectory.goal).toBe("x".repeat(600));
    expect(extractTrajectory("plain task").goal).toBe("plain task");
  });

  test("counts pending calls and assistant turns with no tool action", () => {
    const trajectory = extractTrajectory([
      userMessage("do the thing"),
      assistantMessage("I will inspect first."),
      assistantMessage("I found context."),
      call("done", "read_file", "{\"path\":\"README.md\"}"),
      output("done", "README contents"),
      call("pending", "shell", "{\"cmd\":\"bun test\"}"),
    ]);

    expect(trajectory.assistantTurns).toBe(2);
    expect(trajectory.noToolTurns).toBe(0);
    expect(trajectory.pendingCalls).toBe(1);
    expect(trajectory.steps.at(-1)).toMatchObject({
      tool: "shell",
      outputDigest: "",
      outputPreview: "",
      ok: true,
      errorClass: "",
    });
  });

  test("bounds previews and digests deterministically", () => {
    const text = "same input";
    expect(digest(text)).toBe(digest(text));
    expect(digest(text)).toHaveLength(12);
    expect(digest(text, 8)).toHaveLength(8);

    const trajectory = extractTrajectory([
      call("long", "shell", "x".repeat(260)),
      output("long", "y".repeat(260)),
    ]);

    expect(trajectory.steps[0]!.argsPreview).toHaveLength(220);
    expect(trajectory.steps[0]!.outputPreview).toHaveLength(220);
    expect(trajectory.steps[0]!.argsDigest).toHaveLength(12);
    expect(trajectory.steps[0]!.outputDigest).toHaveLength(12);
  });

  test("handles degenerate inputs and items missing call_id", () => {
    expect(extractTrajectory(undefined)).toEqual({
      steps: [],
      noToolTurns: 0,
      assistantTurns: 0,
      goal: "",
      pendingCalls: 0,
    });
    expect(extractTrajectory([]).steps).toEqual([]);
    expect(extractTrajectory({ input: [] }).steps).toEqual([]);

    const trajectory = extractTrajectory([
      call(undefined, "unknown-id-tool", "{\"ok\":true}"),
      output(undefined, "output still pairs with the missing id entry"),
      { type: "function_call_output", output: "orphan output" },
    ]);

    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]).toMatchObject({
      tool: "unknown-id-tool",
      outputPreview: "output still pairs with the missing id entry",
      ok: true,
    });
    expect(trajectory.pendingCalls).toBe(0);
  });
});
