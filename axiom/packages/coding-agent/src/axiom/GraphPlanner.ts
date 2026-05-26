import { randomUUID } from "node:crypto";
import { completeSimple, type Model } from "@axiom/ai";
import type {
	AxiomAbstraction,
	AxiomGraphNode,
	AxiomReasoningCandidate,
	AxiomReasoningGraph,
	AxiomTaskClassification,
} from "./RuntimeTypes.ts";

/**
 * Combined ToT + AGoT planner.
 *
 * One LLM call asks the model to:
 *   1. Sketch a small set of candidate approaches to the task (ToT exploration).
 *   2. Pick the best one with a short reason (Look-Ahead selection / LATS-lite).
 *   3. Decompose the chosen approach into a directed graph of subgoals (AGoT).
 *
 * The combined call avoids the latency of two separate round-trips while still
 * preserving the paper's structure: candidate diversity → scored selection →
 * structured execution plan. The graph is then rendered into the system prompt
 * for the upcoming turn; Pi's existing agent loop carries out the work.
 *
 * On any failure (timeout, parse error, no model, missing auth), this returns
 * `null` and the runtime falls back to executing without a graph.
 */

interface LLMOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs: number;
	candidateCount: number;
}

const buildSystemPrompt = (candidateCount: number, availableTools: string[]): string => {
	const tools = availableTools.length > 0 ? availableTools.join(", ") : "(no tools)";
	return `You are AXIOM's task planner. You DO NOT answer the user task. You produce a structured plan.

Given a user task, do all three steps and return ONE JSON object:

1. Sketch ${candidateCount} candidate approaches. For each: one short summary, brief pros/cons, and three integer self-scores on a 1-10 scale:
   - "feasibility": can this actually be executed with the tools and information available? (higher is better)
   - "completeness": does this solve the full task, not just part? (higher is better)
   - "risk": likelihood this derails (loops, gets stuck, produces wrong output). LOWER IS BETTER.
   Be honest. Do not score every candidate 9/9/2 — differentiate them.
2. Pick the candidate with the highest (feasibility + completeness - risk). State the chosen candidate id and a one-sentence reason.
3. Decompose the chosen approach into 3-8 directed subgoal nodes. Each node has an id ("n1", "n2", ...), a short description, and a list of node ids it depends on. Node n1 has no dependencies. Each node may name a preferred tool from this list: ${tools}.

Reply with this exact JSON shape and nothing else:
{
  "candidates": [
    { "id": "c1", "summary": "...", "pros": "...", "cons": "...", "feasibility": 8, "completeness": 7, "risk": 3 }
  ],
  "chosenId": "c1",
  "chosenReason": "...",
  "nodes": [
    { "id": "n1", "description": "...", "dependencies": [], "expectedTool": "grep" }
  ]
}

Rules:
- Output a single valid JSON object. No commentary. No code fences. No explanation.
- Keep descriptions short (one sentence each).
- All three scores are required integers in [1, 10].
- dependencies must reference earlier node ids only (no cycles).
- "expectedTool" is optional; omit it if unsure.`;
};

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

interface RawCandidate {
	id?: unknown;
	summary?: unknown;
	pros?: unknown;
	cons?: unknown;
	feasibility?: unknown;
	completeness?: unknown;
	risk?: unknown;
}

/** Clamp to [1, 10] and round to nearest int. Returns undefined if not a finite number. */
function clampScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(10, Math.max(1, Math.round(value)));
}

interface RawNode {
	id?: unknown;
	description?: unknown;
	dependencies?: unknown;
	expectedTool?: unknown;
}

function parseGraphJson(raw: string, startedAt: number, allowedTools: Set<string>): AxiomReasoningGraph | null {
	const json = extractJson(raw);
	if (!json) return null;
	let parsed: { candidates?: unknown; chosenId?: unknown; chosenReason?: unknown; nodes?: unknown };
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}

	const candidates: AxiomReasoningCandidate[] = Array.isArray(parsed.candidates)
		? parsed.candidates
				.map((c): AxiomReasoningCandidate | null => {
					const cand = c as RawCandidate;
					if (typeof cand?.id !== "string" || typeof cand?.summary !== "string") return null;
					const feasibility = clampScore(cand.feasibility);
					const completeness = clampScore(cand.completeness);
					const risk = clampScore(cand.risk);
					const score =
						feasibility !== undefined && completeness !== undefined && risk !== undefined
							? feasibility + completeness - risk
							: undefined;
					return {
						id: cand.id.trim(),
						summary: cand.summary.trim(),
						pros: typeof cand.pros === "string" ? cand.pros.trim() : undefined,
						cons: typeof cand.cons === "string" ? cand.cons.trim() : undefined,
						feasibility,
						completeness,
						risk,
						score,
					};
				})
				.filter((c): c is AxiomReasoningCandidate => c !== null)
		: [];

	const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
	const nodes: AxiomGraphNode[] = [];
	const seenIds = new Set<string>();
	for (const n of rawNodes) {
		const node = n as RawNode;
		if (typeof node?.id !== "string" || typeof node?.description !== "string") continue;
		const id = node.id.trim();
		if (!id || seenIds.has(id)) continue;
		const deps = Array.isArray(node.dependencies)
			? node.dependencies
					.filter((d): d is string => typeof d === "string")
					.map((d) => d.trim())
					.filter(Boolean)
			: [];
		const expectedTool =
			typeof node.expectedTool === "string" && node.expectedTool.trim().length > 0
				? node.expectedTool.trim()
				: undefined;
		seenIds.add(id);
		nodes.push({
			id,
			description: node.description.trim(),
			dependencies: deps,
			expectedTool:
				expectedTool && allowedTools.size > 0 && !allowedTools.has(expectedTool) ? undefined : expectedTool,
			status: "pending",
		});
	}

	// Drop any dependency references to ids the model invented but didn't declare.
	for (const node of nodes) {
		node.dependencies = node.dependencies.filter((d) => seenIds.has(d) && d !== node.id);
	}

	if (nodes.length === 0) return null;

	const modelChosenId = typeof parsed.chosenId === "string" ? parsed.chosenId.trim() : (candidates[0]?.id ?? "c1");
	const modelChosenReason = typeof parsed.chosenReason === "string" ? parsed.chosenReason.trim() : "(no reason given)";

	// Score-consistency check: if every candidate produced valid scores, the
	// chosenId must equal the argmax of score. Otherwise the model is hand-waving
	// (e.g. "pick c1 because vibes" while c2 scored higher). Override silently —
	// the agent doesn't need to know about the inconsistency, but the trace does.
	const scored = candidates.filter((c) => typeof c.score === "number");
	let chosenId = modelChosenId;
	let chosenReason = modelChosenReason;
	let chosenOverridden = false;
	if (scored.length === candidates.length && scored.length > 1) {
		const winner = scored.reduce((best, current) =>
			(current.score ?? -Infinity) > (best.score ?? -Infinity) ? current : best,
		);
		if (winner.id !== modelChosenId) {
			chosenId = winner.id;
			chosenReason = `Highest self-score (${winner.score}) — overriding the model's pick "${modelChosenId}" for score consistency.`;
			chosenOverridden = true;
		}
	}

	return {
		source: "llm",
		candidates,
		chosenId,
		chosenReason,
		chosenOverridden,
		nodes,
		latencyMs: Date.now() - startedAt,
	};
}

/**
 * Deterministic fallback: a single-node graph representing "just do the task".
 * Used when the LLM call is unavailable or fails to produce a valid graph.
 */
function fallbackGraph(text: string, startedAt: number): AxiomReasoningGraph {
	return {
		source: "fallback",
		candidates: [{ id: "c1", summary: "Single-pass execution (no decomposition available)" }],
		chosenId: "c1",
		chosenReason: "Planner unavailable; running task as a single step.",
		chosenOverridden: false,
		nodes: [
			{
				id: "n1",
				description: text.length > 200 ? `${text.slice(0, 197)}…` : text,
				dependencies: [],
				status: "pending",
			},
		],
		latencyMs: Date.now() - startedAt,
	};
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

export class GraphPlanner {
	/**
	 * Build a reasoning graph via one LLM call. Returns a fallback graph on any
	 * failure path — callers can always rely on a non-null return.
	 */
	async plan(options: {
		text: string;
		classification: AxiomTaskClassification;
		abstraction: AxiomAbstraction;
		availableTools: string[];
		llm?: LLMOptions;
	}): Promise<AxiomReasoningGraph> {
		const startedAt = Date.now();
		if (!options.llm) {
			return fallbackGraph(options.text, startedAt);
		}
		const { model, apiKey, headers, timeoutMs, candidateCount } = options.llm;
		try {
			const userPayload = JSON.stringify({
				task: options.text,
				domain: options.abstraction.domain,
				problemClass: options.abstraction.problemClass,
				keywords: options.abstraction.keywords,
				taskKind: options.classification.kind,
				complexity: options.classification.complexity,
			});
			const result = await withTimeout(
				completeSimple(
					model,
					{
						systemPrompt: buildSystemPrompt(candidateCount, options.availableTools),
						messages: [{ role: "user", content: userPayload, timestamp: Date.now() }],
					},
					{ reasoning: "minimal", apiKey, headers },
				),
				timeoutMs,
			);
			if (!result) return fallbackGraph(options.text, startedAt);
			const textParts = result.content
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("")
				.trim();
			if (!textParts) return fallbackGraph(options.text, startedAt);
			const allowed = new Set(options.availableTools);
			const parsed = parseGraphJson(textParts, startedAt, allowed);
			return parsed ?? fallbackGraph(options.text, startedAt);
		} catch {
			return fallbackGraph(options.text, startedAt);
		}
	}

	/** Internal id helper, kept here so tests can stub it if needed. */
	newNodeId(): string {
		return randomUUID();
	}
}
