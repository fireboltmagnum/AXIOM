import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import {
	type AxiomBenchmarkCategory,
	type AxiomBenchmarkDefinition,
	type AxiomBenchmarkStressResult,
	getAxiomBenchmarkRegistry,
	runAxiomStressBenchmarks,
	summarizeBenchmarkRegistry,
} from "../../axiom/BenchmarkTest.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const benchmarkCategorySchema = Type.Union([
	Type.Literal("software-engineering"),
	Type.Literal("terminal-agent"),
	Type.Literal("browser-agent"),
	Type.Literal("computer-use"),
	Type.Literal("tool-use"),
	Type.Literal("knowledge-work"),
	Type.Literal("reasoning"),
	Type.Literal("code-generation"),
	Type.Literal("multimodal"),
	Type.Literal("axiom-stress"),
]);

const benchmarkTestSchema = Type.Object({
	action: Type.Union([Type.Literal("registry"), Type.Literal("list"), Type.Literal("stress"), Type.Literal("plan")]),
	category: Type.Optional(benchmarkCategorySchema),
	adapter: Type.Optional(
		Type.Union([Type.Literal("external"), Type.Literal("local-stress")], {
			description: "Filter by adapter type.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Search benchmark id/name/tags/notes, or describe the target benchmark for action=plan.",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description: "For action=stress, run only local stress test ids containing this substring.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum registry rows to return (default 20, max 100)." })),
});

export type BenchmarkTestToolInput = Static<typeof benchmarkTestSchema>;

export interface BenchmarkTestToolDetails {
	action: BenchmarkTestToolInput["action"];
	total?: number;
	passed?: boolean;
	passedCount?: number;
	failedCount?: number;
	durationMs?: number;
	benchmarkIds?: string[];
}

function formatBenchmarkCall(
	args: BenchmarkTestToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("benchmark_test"))} ${
		action === null ? invalidArg : theme.fg("accent", action || "")
	}`;
	if (args?.category) text += theme.fg("toolOutput", ` ${args.category}`);
	if (args?.query) text += theme.fg("toolOutput", ` "${args.query}"`);
	if (args?.filter) text += theme.fg("toolOutput", ` filter=${args.filter}`);
	return text;
}

function formatBenchmarkResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BenchmarkTestToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 30;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createBenchmarkTestToolDefinition(): ToolDefinition<
	typeof benchmarkTestSchema,
	BenchmarkTestToolDetails | undefined
> {
	return {
		name: "benchmark_test",
		label: "benchmark",
		description:
			"Plan and run AXIOM benchmark testing. Lists 50+ public external benchmarks, runs fast local AXIOM stress tests for native tools, and produces adapter plans for attaching external harnesses.",
		promptSnippet: "List benchmark registry and run AXIOM-native stress tests",
		promptGuidelines: [
			"Use benchmark_test registry/list when asked what benchmarks AXIOM can run or target.",
			"Use benchmark_test stress before claiming AXIOM-native tools are healthy; it runs local stress tests for CodeAnalyzer, SparseTreeGrep, code_graph, flow_graph, knowledge_graph, todo_list, StreamingIP, PatchRiskGate, RepairLoop, and ContextLedger.",
			"Use benchmark_test plan before attempting an external benchmark; it tells you whether a local stress test can run now or which external harness/repo must be installed.",
			"Do not claim a score on SWE-bench, Terminal-Bench, OSWorld, or similar external benchmarks unless the external harness actually ran and produced results.",
		],
		parameters: benchmarkTestSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: BenchmarkTestToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const action = params.action;
			if (action === "registry") {
				const registry = getAxiomBenchmarkRegistry();
				const text = `${summarizeBenchmarkRegistry()}\n\n${formatCategorySummary(registry)}`;
				return result(action, text, {
					total: registry.length,
					benchmarkIds: registry.map((item) => item.id),
				});
			}
			if (action === "list") {
				const matches = filterBenchmarks(getAxiomBenchmarkRegistry(), params).slice(
					0,
					normalizeLimit(params.limit),
				);
				return result(action, formatBenchmarkList(matches, params), {
					total: matches.length,
					benchmarkIds: matches.map((item) => item.id),
				});
			}
			if (action === "stress") {
				const summary = await runAxiomStressBenchmarks({ filter: params.filter });
				return result(action, formatStressSummary(summary.results), {
					total: summary.total,
					passed: summary.passed,
					passedCount: summary.passedCount,
					failedCount: summary.failedCount,
					durationMs: summary.durationMs,
					benchmarkIds: summary.results.map((item) => item.id),
				});
			}
			const matches = filterBenchmarks(getAxiomBenchmarkRegistry(), params).slice(
				0,
				normalizeLimit(params.limit ?? 12),
			);
			return result(action, formatPlan(matches, params), {
				total: matches.length,
				benchmarkIds: matches.map((item) => item.id),
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBenchmarkCall(args, theme));
			return text;
		},
		renderResult(toolResult, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBenchmarkResult(toolResult as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createBenchmarkTestTool(): AgentTool<typeof benchmarkTestSchema> {
	return wrapToolDefinition(createBenchmarkTestToolDefinition());
}

function result(
	action: BenchmarkTestToolInput["action"],
	text: string,
	details: Omit<BenchmarkTestToolDetails, "action">,
) {
	return {
		content: [{ type: "text" as const, text }],
		details: { action, ...details },
	};
}

function normalizeLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(100, Math.floor(limit ?? 20)));
}

function filterBenchmarks(
	registry: AxiomBenchmarkDefinition[],
	params: Pick<BenchmarkTestToolInput, "adapter" | "category" | "query">,
): AxiomBenchmarkDefinition[] {
	const query = normalizeQuery(params.query);
	return registry.filter((item) => {
		if (params.category && item.category !== params.category) return false;
		if (params.adapter && item.adapter !== params.adapter) return false;
		if (!query) return true;
		const haystack = normalizeQuery([item.id, item.name, item.category, item.tags.join(" "), item.notes].join(" "));
		return query.split(/\s+/).every((part) => haystack.includes(part));
	});
}

function normalizeQuery(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function formatCategorySummary(registry: AxiomBenchmarkDefinition[]): string {
	const byCategory = new Map<AxiomBenchmarkCategory, AxiomBenchmarkDefinition[]>();
	for (const item of registry) {
		const existing = byCategory.get(item.category) ?? [];
		existing.push(item);
		byCategory.set(item.category, existing);
	}
	const lines = ["# Category map"];
	for (const [category, items] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const examples = items
			.slice(0, 5)
			.map((item) => item.id)
			.join(", ");
		lines.push(`- ${category}: ${items.length} (${examples}${items.length > 5 ? ", ..." : ""})`);
	}
	lines.push("");
	lines.push("Use action=list with category/query for details, or action=stress to run local AXIOM checks.");
	return lines.join("\n");
}

function formatBenchmarkList(matches: AxiomBenchmarkDefinition[], params: BenchmarkTestToolInput): string {
	const filters = [
		params.category ? `category=${params.category}` : undefined,
		params.adapter ? `adapter=${params.adapter}` : undefined,
		params.query ? `query="${params.query}"` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const lines = [`Benchmark list${filters ? ` (${filters})` : ""}: ${matches.length}`];
	if (matches.length === 0) {
		lines.push("No benchmarks matched. Try action=registry to inspect available categories.");
		return lines.join("\n");
	}
	for (const item of matches) {
		lines.push("");
		lines.push(`- ${item.id} — ${item.name}`);
		lines.push(`  category: ${item.category}; adapter: ${item.adapter}; metrics: ${item.metrics.join(", ")}`);
		lines.push(`  tags: ${item.tags.join(", ")}`);
		lines.push(`  source: ${item.sourceUrl}`);
		if (item.defaultCommand) lines.push(`  default command: ${item.defaultCommand}`);
		lines.push(`  ${item.notes}`);
	}
	return lines.join("\n");
}

function formatStressSummary(results: AxiomBenchmarkStressResult[]): string {
	const passedCount = results.filter((item) => item.passed).length;
	const lines = [`AXIOM stress tests: ${passedCount}/${results.length} passed`];
	if (results.length === 0) {
		lines.push("No local stress tests matched the filter.");
		return lines.join("\n");
	}
	for (const item of results) {
		lines.push("");
		lines.push(`${item.passed ? "PASS" : "FAIL"} ${item.id} (${item.durationMs}ms)`);
		lines.push(`  ${item.details}`);
	}
	return lines.join("\n");
}

function formatPlan(matches: AxiomBenchmarkDefinition[], params: BenchmarkTestToolInput): string {
	const lines = [
		"Benchmark attachment plan",
		"",
		"1. Run local AXIOM stress first: benchmark_test action=stress.",
		"2. Pick the smallest matching public benchmark split before a full run.",
		"3. Install or clone the external harness in a sandbox, then bind AXIOM as the agent command.",
		"4. Record score, cost, latency, tool calls, failures, and regression notes.",
		"5. Feed failures back through flow_graph/debug, code_graph, RepairLoop, and SparseTreeGrep when relevant.",
		"",
	];
	if (matches.length === 0) {
		lines.push(
			`No matching registry item${params.query ? ` for "${params.query}"` : ""}. Use action=list or action=registry first.`,
		);
		return lines.join("\n");
	}
	lines.push("Candidate adapters:");
	for (const item of matches) {
		lines.push("");
		lines.push(`- ${item.id} — ${item.name}`);
		if (item.adapter === "local-stress") {
			lines.push(`  runnable now: benchmark_test action=stress filter=${item.id}`);
		} else {
			lines.push(`  external harness: ${item.sourceUrl}`);
			lines.push(`  AXIOM adapter status: planned. Do not report a score until this harness is installed and run.`);
			lines.push(`  default command: ${item.defaultCommand ?? "create an adapter command for this harness"}`);
		}
		lines.push(`  why: ${item.notes}`);
	}
	return lines.join("\n");
}
