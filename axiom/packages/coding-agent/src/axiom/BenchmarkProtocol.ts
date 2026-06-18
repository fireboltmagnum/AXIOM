import type { AxiomBenchmarkProtocol, AxiomTaskClassification } from "./RuntimeTypes.ts";

/**
 * BenchmarkMode is a deterministic execution discipline for smaller models.
 *
 * Strong models win agentic coding benchmarks by being boring: localize first,
 * patch narrowly, run the cheapest verifier, and use failure output as the next
 * localization signal. This protocol gives Gemma-class models that discipline
 * explicitly without adding another LLM call.
 */
export class BenchmarkProtocol {
	plan(options: {
		classification: AxiomTaskClassification;
		availableTools: readonly string[];
	}): AxiomBenchmarkProtocol | undefined {
		if (options.classification.kind !== "coding" && options.classification.kind !== "command") return undefined;
		const tools = new Set(options.availableTools);
		const toolSequence = ["rg/read exact source before edits"];
		if (tools.has("todo_list")) toolSequence.push("todo_list for 3+ steps with atomic items");
		if (tools.has("understand_code")) toolSequence.push("understand_code for unfamiliar files/folders");
		if (tools.has("code_graph")) toolSequence.push("code_graph for ownership/dependency localization");
		if (tools.has("flow_graph")) toolSequence.push("flow_graph for execution/data/error/effect paths");
		if (tools.has("playwright_cli")) toolSequence.push("playwright_cli for UI/browser regressions");
		if (tools.has("benchmark_test"))
			toolSequence.push("benchmark_test for AXIOM stress tests and benchmark adapter planning");
		if (tools.has("gather_context"))
			toolSequence.push(
				"gather_context to load the FULL content of every answer-relevant file right before writing the final answer",
			);

		return {
			name: "benchmark-mode",
			directives: [
				"Localize before editing: identify the smallest owning file/function/class and cite exact evidence from source or verifier output.",
				"Patch narrowly: change the fewest lines needed for the current failure or requested behavior; never rewrite unrelated code for style.",
				"Preserve public behavior outside the localized path unless the user explicitly asks for a broader change.",
				"If the task is ambiguous, turn ambiguity into executable checks or inspectable source evidence instead of guessing.",
				tools.has("gather_context")
					? "Before writing the final answer/artifact, call gather_context with every file it depends on and synthesize ONLY from that full content — never from summaries, snippets, or memory."
					: "Before writing the final answer/artifact, re-read the full content of every file it depends on and synthesize from that complete material — never from summaries, snippets, or memory.",
			],
			toolSequence,
			verifierPolicy: [
				"After edits, let RepairLoop run the verifier ladder: targeted check first, then broader cheap checks when the targeted check passes.",
				"Treat parsed verifier file/line/owner as the next search target; do not make a second patch from memory alone.",
				"When a targeted verifier passes but a broader verifier fails, keep the passing localized fix and repair only the new broader failure.",
				"For AXIOM-native tool changes, run benchmark_test action=stress before claiming the tool is healthy.",
			],
			stopRules: [
				"If the same failure repeats twice, stop changing code and re-localize with read/rg/flow_graph.",
				"If failure count grows sharply, revert broad changes mentally and search for the first introduced break.",
				"Prefer one verified small fix over a plausible large refactor.",
			],
		};
	}
}
