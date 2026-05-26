import { completeSimple, type Model } from "@axiom/ai";
import type { AxiomReasoningCandidate } from "./RuntimeTypes.ts";

/**
 * Independent second-pass critic over ToT candidates.
 *
 * The first planner LLM call generates candidates AND self-scores them
 * (feasibility/completeness/risk). That self-scoring is good, but it has an
 * obvious failure mode: the same model that proposed the candidates also
 * judges them, so it can hand-wave high scores onto its favorite branch.
 *
 * This critic does a separate pass with a different framing:
 *   - "You did not propose these. Evaluate them adversarially."
 *   - Score on *different* axes (cost, edge-case coverage, undo-ability).
 *
 * The result is folded back into the graph: each candidate gets a
 * `criticScore` and the winner is the argmax of (selfScore + criticScore).
 * If the critic strongly disagrees with the self-scored winner, the graph's
 * chosenId is overridden again. All best-effort — on any failure the planner
 * output is left untouched.
 */
export interface CriticOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs: number;
}

export interface CriticScore {
	id: string;
	cost?: number;
	coverage?: number;
	undoability?: number;
	score?: number;
	rationale?: string;
}

const SYSTEM_PROMPT = `You are AXIOM's independent reasoning critic.

You will be given a user task and a small set of candidate approaches that a different model proposed. You did NOT propose these. Evaluate them adversarially on three NEW axes (1-10 integer scale each):

- "cost": how expensive is this approach in tokens/time/tool calls? LOWER IS BETTER.
- "coverage": how well does it handle edge cases, errors, and ambiguous inputs? HIGHER IS BETTER.
- "undoability": if it goes wrong mid-execution, how recoverable is it? HIGHER IS BETTER.

Be honest. Do not score every candidate 5/5/5 — differentiate. Add a one-sentence rationale per candidate.

Reply with ONLY this JSON shape, no commentary, no code fences:
{
  "scores": [
    { "id": "c1", "cost": 4, "coverage": 7, "undoability": 8, "rationale": "..." }
  ]
}

Rules:
- Output a single valid JSON object.
- All three score fields are required integers in [1, 10].
- "id" must match one of the candidate ids you were given.`;

function extractJson(text: string): string | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) return fenced[1].trim();
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function clampScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(10, Math.max(1, Math.round(value)));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	if (ms <= 0) return promise;
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(null);
			});
	});
}

export class ReasoningCritic {
	/**
	 * Score a batch of candidates. Returns a map keyed by candidate id. Empty map
	 * on any failure (timeout, parse error, missing fields).
	 */
	async score(options: {
		task: string;
		candidates: AxiomReasoningCandidate[];
		llm: CriticOptions;
	}): Promise<Map<string, CriticScore>> {
		const empty = new Map<string, CriticScore>();
		if (options.candidates.length === 0) return empty;
		try {
			const userPayload = JSON.stringify({
				task: options.task,
				candidates: options.candidates.map((c) => ({
					id: c.id,
					summary: c.summary,
					pros: c.pros,
					cons: c.cons,
				})),
			});
			const result = await withTimeout(
				completeSimple(
					options.llm.model,
					{
						systemPrompt: SYSTEM_PROMPT,
						messages: [{ role: "user", content: userPayload, timestamp: Date.now() }],
					},
					{ reasoning: "minimal", apiKey: options.llm.apiKey, headers: options.llm.headers },
				),
				options.llm.timeoutMs,
			);
			if (!result) return empty;
			const text = result.content
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("")
				.trim();
			return this.parse(text);
		} catch {
			return empty;
		}
	}

	private parse(raw: string): Map<string, CriticScore> {
		const out = new Map<string, CriticScore>();
		const json = extractJson(raw);
		if (!json) return out;
		let parsed: { scores?: unknown };
		try {
			parsed = JSON.parse(json);
		} catch {
			return out;
		}
		const arr = Array.isArray(parsed.scores) ? parsed.scores : [];
		for (const s of arr) {
			const entry = s as {
				id?: unknown;
				cost?: unknown;
				coverage?: unknown;
				undoability?: unknown;
				rationale?: unknown;
			};
			if (typeof entry.id !== "string") continue;
			const id = entry.id.trim();
			if (!id) continue;
			const cost = clampScore(entry.cost);
			const coverage = clampScore(entry.coverage);
			const undoability = clampScore(entry.undoability);
			// Score: high coverage + high undoability, low cost. Same direction as the
			// self-score, so the two can be added without sign-flipping.
			const score =
				cost !== undefined && coverage !== undefined && undoability !== undefined
					? coverage + undoability - cost
					: undefined;
			out.set(id, {
				id,
				cost,
				coverage,
				undoability,
				score,
				rationale: typeof entry.rationale === "string" ? entry.rationale.trim() : undefined,
			});
		}
		return out;
	}
}
