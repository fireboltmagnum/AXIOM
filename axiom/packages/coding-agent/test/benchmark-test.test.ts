import { describe, expect, it } from "vitest";
import {
	AXIOM_EXTERNAL_BENCHMARKS,
	getAxiomBenchmarkRegistry,
	runAxiomStressBenchmarks,
	summarizeBenchmarkRegistry,
} from "../src/axiom/BenchmarkTest.ts";
import { createBenchmarkTestToolDefinition } from "../src/core/tools/benchmark-test.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("AXIOM Benchmark Test", () => {
	it("tracks 50+ public benchmark targets plus AXIOM-native stress tests", () => {
		const registry = getAxiomBenchmarkRegistry();

		expect(AXIOM_EXTERNAL_BENCHMARKS.length).toBeGreaterThanOrEqual(50);
		expect(registry.map((item) => item.id)).toEqual(
			expect.arrayContaining([
				"swe-bench",
				"swe-bench-verified",
				"terminal-bench",
				"osworld",
				"webarena",
				"gaia",
				"humaneval",
				"livecodebench",
				"code_analyzer_symbols",
				"sparse_tree_grep_scene",
				"flow_graph_effects",
			]),
		);
		expect(summarizeBenchmarkRegistry()).toContain("AXIOM Benchmark Test Registry");
		expect(summarizeBenchmarkRegistry()).toContain("axiom-stress");
	});

	it("runs the full local AXIOM stress suite", async () => {
		const summary = await runAxiomStressBenchmarks();

		expect(summary.total).toBeGreaterThanOrEqual(10);
		expect(summary.failedCount).toBe(0);
		expect(summary.passed).toBe(true);
	});

	it("exposes registry, list, plan, and stress through the tool interface", async () => {
		const tool = createBenchmarkTestToolDefinition();

		const registry = await tool.execute("registry", { action: "registry" }, undefined, undefined, undefined as never);
		expect(registry.content[0]?.type).toBe("text");
		expect(textOf(registry)).toContain("AXIOM Benchmark Test Registry");
		expect(registry.details?.total).toBeGreaterThanOrEqual(60);

		const list = await tool.execute(
			"list",
			{ action: "list", query: "terminal", limit: 5 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(list)).toContain("terminal-bench");

		const plan = await tool.execute(
			"plan",
			{ action: "plan", query: "swe-bench", limit: 3 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(plan)).toContain("Benchmark attachment plan");
		expect(textOf(plan)).toContain("external harness");

		const stress = await tool.execute(
			"stress",
			{ action: "stress", filter: "streaming_ip_gate" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(stress.details?.passed).toBe(true);
		expect(textOf(stress)).toContain("PASS streaming_ip_gate");
	});
});
