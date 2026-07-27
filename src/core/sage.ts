/**
 * Client for the Levanto Sage decision API (https://docs.levanto.ai/).
 *
 * Sage returns machine-actionable decisions rather than prose, which is exactly what a
 * router needs: a calibrated probability instead of a paragraph to parse. This speaks
 * the documented POST /decide contract for the `yesno` and `choice` kinds.
 *
 * Two properties matter for a proxy hot path. It must never stall a turn, so every call
 * is deadline-bounded and single-shot. And it must fail open: if Sage is unreachable the
 * agent keeps working on its current model, because a router outage must not take the
 * agent down with it.
 */

export interface SageDecision {
  kind: "yesno" | "choice";
  answer: string;
  confidence: number;
  probabilities: Record<string, number>;
  latencyMs: number;
  model: string;
  source: "sage" | "offline";
}

export class SageError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
    this.name = "SageError";
  }
}

export interface SageChoiceOption {
  option: string;
  description: string;
}

export interface SageClient {
  yesno(content: string, questionId: string, instructions: string): Promise<SageDecision>;
  choice(
    content: string,
    questionId: string,
    instructions: string,
    options: SageChoiceOption[],
  ): Promise<SageDecision>;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HttpSageClient implements SageClient {
  calls = 0;
  totalLatencyMs = 0;

  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async yesno(content: string, questionId: string, instructions: string): Promise<SageDecision> {
    const raw = await this.post({
      content,
      question: { id: questionId, kind: "yesno", instructions },
    });
    const result = isObj(raw.result) ? raw.result : {};
    const meta = isObj(raw.meta) ? raw.meta : {};
    const probability = num(result.probability);
    return {
      kind: "yesno",
      answer: typeof result.answer === "string" ? result.answer : "",
      confidence: num(result.confidence),
      probabilities: { yes: probability, no: 1 - probability },
      latencyMs: num(meta.latency_ms),
      model: typeof meta.model === "string" ? meta.model : "",
      source: "sage",
    };
  }

  async choice(
    content: string,
    questionId: string,
    instructions: string,
    options: SageChoiceOption[],
  ): Promise<SageDecision> {
    if (options.length < 2 || options.length > 120) {
      throw new SageError("choice requires between 2 and 120 options", true);
    }
    const raw = await this.post({
      content,
      question: { id: questionId, kind: "choice", instructions, options },
    });
    const result = isObj(raw.result) ? raw.result : {};
    const meta = isObj(raw.meta) ? raw.meta : {};
    const probabilities: Record<string, number> = {};
    if (Array.isArray(result.probabilities)) {
      for (const entry of result.probabilities) {
        if (isObj(entry) && typeof entry.option === "string") {
          probabilities[entry.option] = num(entry.probability);
        }
      }
    }
    return {
      kind: "choice",
      answer: typeof result.chosen === "string" ? result.chosen : "",
      confidence: num(result.confidence),
      probabilities,
      latencyMs: num(meta.latency_ms),
      model: typeof meta.model === "string" ? meta.model : "",
      source: "sage",
    };
  }

  private async post(payload: unknown): Promise<Record<string, unknown>> {
    const started = Date.now();
    // Single-shot with a hard deadline. Retrying inside a proxy turn would trade a
    // routing decision the caller can live without for latency the user cannot.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/decide`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        // 400/401/402 are permanent: bad request, bad key, or no balance. Marking them
        // lets the session stop paying the latency for a call that cannot succeed.
        throw new SageError(
          `Sage ${response.status}: ${detail}`,
          response.status === 400 || response.status === 401 || response.status === 402,
        );
      }
      const decoded = await response.json() as unknown;
      this.calls += 1;
      this.totalLatencyMs += Date.now() - started;
      return isObj(decoded) ? decoded : {};
    } catch (err) {
      if (err instanceof SageError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new SageError(`Sage request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Deterministic local stand-in mirroring Sage's decision semantics.
 *
 * It exists so the router can be exercised end to end without a key, and so tests have a
 * stable oracle. It applies transparent heuristics over the same evidence text. It is a
 * stub, never a claim about how the real model scores a trajectory.
 */
export class OfflineSageClient implements SageClient {
  calls = 0;

  private static facts(content: string): Map<string, number | boolean> {
    const values = new Map<string, number | boolean>();
    for (const token of content.toLowerCase().replace(/\|/g, " ").split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const key = token.slice(0, eq);
      const raw = token.slice(eq + 1);
      if (raw === "true" || raw === "false") {
        values.set(key, raw === "true");
        continue;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) values.set(key, parsed);
    }
    return values;
  }

  private static number(facts: Map<string, number | boolean>, key: string): number {
    const value = facts.get(key);
    return typeof value === "number" ? value : 0;
  }

  private static flag(facts: Map<string, number | boolean>, key: string): boolean {
    return facts.get(key) === true;
  }

  async yesno(content: string, _questionId: string, _instructions: string): Promise<SageDecision> {
    this.calls += 1;
    const facts = OfflineSageClient.facts(content);
    const failed = OfflineSageClient.number(facts, "consecutive_failed_verifications");
    const cycles = OfflineSageClient.number(facts, "rewrite_retest_fail_cycles");
    const errorRate = OfflineSageClient.number(facts, "recent_error_rate");
    const stalled = OfflineSageClient.number(facts, "steps_since_progress");
    const looping = OfflineSageClient.flag(facts, "loop_detected");
    const verified = OfflineSageClient.flag(facts, "last_verification_passed");

    let probability = 0.1;
    if (verified && failed === 0 && !looping) {
      probability = 0.05;
    } else {
      probability += Math.min(failed, 4) * 0.15;
      probability += Math.min(cycles, 4) * 0.08;
      probability += looping ? 0.32 : 0;
      probability += errorRate >= 0.5 ? 0.25 : 0;
      probability += stalled >= 3 ? 0.15 : 0;
    }
    probability = Math.max(0, Math.min(0.99, probability));

    return {
      kind: "yesno",
      answer: probability >= 0.5 ? "yes" : "no",
      confidence: Math.abs(probability - 0.5) * 2,
      probabilities: { yes: probability, no: 1 - probability },
      latencyMs: 0,
      model: "offline-stub",
      source: "offline",
    };
  }

  async choice(
    content: string,
    _questionId: string,
    _instructions: string,
    options: SageChoiceOption[],
  ): Promise<SageDecision> {
    this.calls += 1;
    const facts = OfflineSageClient.facts(content);
    const errorRate = OfflineSageClient.number(facts, "recent_error_rate");
    const stalled = OfflineSageClient.number(facts, "steps_since_progress");
    const burn = OfflineSageClient.number(facts, "budget_burn");
    const looping = OfflineSageClient.flag(facts, "loop_detected");
    const verified = OfflineSageClient.flag(facts, "last_verification_passed");
    const switches = OfflineSageClient.number(facts, "model_switches_already_used");

    const scores: Record<string, number> = {};
    for (const option of options) scores[option.option] = 0.05;
    const set = (name: string, value: number): void => {
      if (name in scores) scores[name] = value;
    };

    if (verified && errorRate < 0.4) set("continue", 0.93);
    else if (looping && switches >= 1) set("restart_clean", 0.78);
    else if (errorRate >= 0.5 || looping || stalled >= 3) set("switch_model", 0.82);
    else set("continue", 0.71);
    if (burn >= 0.85) set("escalate_human", 0.95);

    let chosen = options[0]!.option;
    for (const [name, value] of Object.entries(scores)) {
      if (value > (scores[chosen] ?? 0)) chosen = name;
    }
    return {
      kind: "choice",
      answer: chosen,
      confidence: scores[chosen] ?? 0,
      probabilities: scores,
      latencyMs: 0,
      model: "offline-stub",
      source: "offline",
    };
  }
}
