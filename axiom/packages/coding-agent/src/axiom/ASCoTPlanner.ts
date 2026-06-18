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
		availableTools?: string[];
	}): AxiomASCoTPlan {
		const { classification, recalls, enabled } = options;
		if (!enabled) {
			return { thinkingLevel: "off", strategyHints: [] };
		}

		const thinkingLevel = pickThinkingLevel(classification);
		const strategyHints = pickStrategyHints(classification, recalls.length, options.availableTools ?? []);
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

function pickStrategyHints(
	classification: AxiomTaskClassification,
	recallCount: number,
	availableTools: string[],
): string[] {
	const hints: string[] = [];
	const c = classification.complexity;
	const kind = classification.kind;
	const tools = new Set(availableTools);

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
			"For code changes, prefer minimal, surgical edits. Do not refactor untouched code. Run tools (read, rg, edit) when you need to verify state — do not guess at file contents.",
		);
		if (tools.has("todo_list") && c >= 51) {
			hints.push(
				"For broad coding tasks, create or update a todo_list first, keep each todo atomic, and mark items complete as evidence is collected.",
			);
		}
		if (tools.has("understand_code")) {
			hints.push(
				"Use understand_code when you need a fast structural map of unfamiliar files or folders before editing.",
			);
		}
		if (tools.has("code_graph")) {
			hints.push(
				"Use code_graph for cross-file dependency questions, symbol relationships, or deciding which files an edit can affect.",
			);
		}
		if (tools.has("flow_graph")) {
			hints.push(
				"Use flow_graph for behavior questions: execution paths, data flow, effects, events, errors, failed tests, or command traces.",
			);
		}
		if (tools.has("benchmark_test")) {
			hints.push(
				"Use benchmark_test when the task asks about AXIOM benchmarks, benchmark adapters, or health checks for AXIOM-native tools; never claim an external benchmark score unless its harness actually ran.",
			);
		}
	}

	if (recallCount > 0) {
		hints.push(
			`AXIOM recalled ${recallCount} past lesson(s) from similar tasks (see the "Past lessons" section below). Apply them — do not repeat those failure modes.`,
		);
	}

	return hints;
}
