import type {
	AxiomAbstraction,
	AxiomASCoTPlan,
	AxiomReflectionRecallHit,
	AxiomTaskClassification,
} from "./RuntimeTypes.ts";

/**
 * ASCoT depth modulation. Pure function: maps (classification, abstraction,
 * recalled reflections) to a thinking level and a set of strategy hints that
 * get appended to the system prompt for the upcoming turn.
 *
 * Cheap and deterministic — no LLM calls, no I/O. Safe to call on every task.
 */
export class ASCoTPlanner {
	plan(options: {
		classification: AxiomTaskClassification;
		abstraction: AxiomAbstraction;
		recalls: AxiomReflectionRecallHit[];
		enabled: boolean;
	}): AxiomASCoTPlan {
		const { classification, recalls, enabled } = options;
		if (!enabled) {
			return { thinkingLevel: "off", strategyHints: [] };
		}

		const thinkingLevel = pickThinkingLevel(classification);
		const strategyHints = pickStrategyHints(classification, recalls.length);
		return { thinkingLevel, strategyHints };
	}
}

function pickThinkingLevel(classification: AxiomTaskClassification): AxiomASCoTPlan["thinkingLevel"] {
	// Cheap, fully direct kinds get no thinking budget — keeps small-talk fast.
	switch (classification.kind) {
		case "greeting":
		case "gratitude":
		case "identity":
		case "status":
			return "off";
		default:
			break;
	}

	const c = classification.complexity;
	if (c >= 81) return "high";
	if (c >= 51) return "medium";
	if (c >= 21) return "low";
	return "minimal";
}

function pickStrategyHints(classification: AxiomTaskClassification, recallCount: number): string[] {
	const hints: string[] = [];
	const c = classification.complexity;
	const kind = classification.kind;

	// Top-level reasoning strategy keyed on complexity. Phrased as imperatives the
	// model can act on directly. Kept short — these become part of the system prompt
	// every turn, so brevity matters.
	if (c >= 81) {
		hints.push(
			"This task is high-complexity. Decompose it into a small graph of subgoals before answering. Identify dependencies between subgoals, solve the prerequisite ones first, and only then compose the final answer. Verify each step against the task's success criteria before moving on.",
		);
	} else if (c >= 51) {
		hints.push(
			"This task is non-trivial. Plan briefly before answering: list the 2-4 sub-steps needed, then execute them in order. Check the result of each step before continuing to the next.",
		);
	} else if (c >= 21) {
		hints.push(
			"Think one step before answering. Identify what the user is actually asking for, then respond concisely with that.",
		);
	}

	if (kind === "coding") {
		hints.push(
			"For code changes, prefer minimal, surgical edits. Do not refactor untouched code. Run tools (read, grep, edit) when you need to verify state — do not guess at file contents.",
		);
	}

	if (recallCount > 0) {
		hints.push(
			`AXIOM recalled ${recallCount} past lesson(s) from similar tasks (see the "Past lessons" section below). Apply them — do not repeat those failure modes.`,
		);
	}

	return hints;
}
