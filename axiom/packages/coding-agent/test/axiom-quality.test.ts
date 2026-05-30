import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@axiom/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASCoTPlanner } from "../src/axiom/ASCoTPlanner.ts";
import { BenchmarkProtocol } from "../src/axiom/BenchmarkProtocol.ts";
import { analyzeFile } from "../src/axiom/CodeAnalyzer.ts";
import { CodeGraphStore } from "../src/axiom/CodeGraphStore.ts";
import { FlowGraphStore } from "../src/axiom/FlowGraphStore.ts";
import { ReasoningCritic } from "../src/axiom/ReasoningCritic.ts";
import type { AxiomAbstraction, AxiomTaskClassification } from "../src/axiom/RuntimeTypes.ts";
import { SparseTreeGrepStore } from "../src/axiom/SparseTreeGrepStore.ts";
import { StreamingIPOutputGate } from "../src/axiom/StreamingIPValidator.ts";
import { renderTaskPrimerBrief, TaskPrimer } from "../src/axiom/TaskPrimer.ts";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("AXIOM core quality improvements", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `axiom-quality-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("CodeAnalyzer extracts TS arrow functions and class methods", () => {
		const understanding = analyzeFile(
			"src/example.ts",
			[
				"export class Runner {",
				"  async run(input: string): Promise<string> {",
				"    return helper(input);",
				"  }",
				"}",
				"export const helper = (value: string) => value.trim();",
			].join("\n"),
		);

		expect(understanding.symbols).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "class", name: "Runner" }),
				expect.objectContaining({ kind: "method", name: "Runner.run" }),
				expect.objectContaining({ kind: "function", name: "helper" }),
			]),
		);
		expect(understanding.exports).toContain("helper");
	});

	it("SparseTreeGrep keeps tiny-document trees compact", async () => {
		const docPath = join(testDir, "book.txt");
		writeFileSync(
			docPath,
			"Rayan and Sam met in the archive. The gunfight started after the alarm. Rayan escaped through the west door.",
		);

		const index = await new SparseTreeGrepStore(join(testDir, ".sparse")).indexDocument({ path: docPath });

		expect(index.chunkCount).toBe(1);
		expect(index.nodes.length).toBeLessThanOrEqual(24);
		expect(index.nodes.length).toBeGreaterThan(0);
	});

	it("SparseTreeGrep semantically reranks hits across multiple documents", async () => {
		const storeDir = join(testDir, ".sparse-rerank");
		const store = new SparseTreeGrepStore(storeDir);
		const literalPath = join(testDir, "literal.txt");
		const semanticPath = join(testDir, "semantic.txt");
		writeFileSync(literalPath, "Battle records mention logistics and supply lines.");
		writeFileSync(semanticPath, "Rayan and Sam faced a close-range gunfight in the archive.");

		const literal = await store.indexDocument({ path: literalPath, title: "literal" });
		const semantic = await store.indexDocument({ path: semanticPath, title: "semantic" });
		literal.embeddingDim = 2;
		literal.chunks[0]!.embedding = [1, 0];
		semantic.embeddingDim = 2;
		semantic.chunks[0]!.embedding = [0, 1];
		writeFileSync(join(storeDir, "docs", `${literal.documentId}.json`), `${JSON.stringify(literal, null, 2)}\n`);
		writeFileSync(join(storeDir, "docs", `${semantic.documentId}.json`), `${JSON.stringify(semantic, null, 2)}\n`);

		const hits = new SparseTreeGrepStore(storeDir).search("battle", {
			limit: 2,
			queryEmbedding: new Float32Array([0, 1]),
		});

		expect(hits[0]?.documentName).toBe("semantic");
		expect(hits.map((hit) => hit.documentName)).toContain("literal");
	});

	it("SparseTreeGrep finds action scenes through expanded query terms", async () => {
		const docPath = join(testDir, "book.txt");
		writeFileSync(
			docPath,
			[
				"Anna and Gosh crossed the quiet market at noon. Nothing happened there.",
				"",
				"In the archive, Anna shoved Gosh behind a table as the gunfight erupted. A pistol cracked twice before Gosh pulled Anna toward the stairwell.",
				"",
				"Later, Anna and Gosh shared tea beside the river and discussed the map.",
			].join("\n"),
		);
		const store = new SparseTreeGrepStore(join(testDir, ".sparse-scenes"));
		const index = await store.indexDocument({ path: docPath });

		const hits = store.search("fight scene between Anna and Gosh", { documentId: index.documentId, limit: 3 });

		expect(hits[0]?.chunkSummary).toContain("gunfight");
		expect(hits[0]?.matchedKeywords).toEqual(expect.arrayContaining(["anna", "gosh"]));
	});

	it("SparseTreeGrep lazily stores detailed descriptions for selected hits", async () => {
		const docPath = join(testDir, "book.txt");
		writeFileSync(
			docPath,
			[
				"Anna and Gosh entered the train station.",
				"",
				"Anna tackled Gosh as a brawl spilled across the platform. Gosh dropped the satchel, and Anna kicked it under a bench before the guards arrived.",
			].join("\n"),
		);
		const storeDir = join(testDir, ".sparse-describe");
		const store = new SparseTreeGrepStore(storeDir);
		const index = await store.indexDocument({ path: docPath });

		const described = store.describe({
			documentId: index.documentId,
			query: "fight between Anna and Gosh",
			limit: 1,
		});
		const reloaded = new SparseTreeGrepStore(storeDir).require(index.documentId);

		expect(described.descriptions[0]?.description.entities).toEqual(expect.arrayContaining(["Anna", "Gosh"]));
		expect(described.descriptions[0]?.description.actions).toContain("brawl");
		expect(reloaded.chunks.some((chunk) => !!chunk.description)).toBe(true);
	});

	it("StreamingIPOutputGate holds code until the configured chunk threshold passes", async () => {
		const gate = new StreamingIPOutputGate({ timeoutMs: 500, checkEveryChunks: 2 });
		const oneChunk = await gate.filter(
			assistantText(["Before\n", "```js\nconst a = 1;\n```\n", "Between\n"].join("")),
		);

		expect(oneChunk.checks).toHaveLength(0);
		expect(textOf(oneChunk.message)).toBe("Before\n");

		const twoChunks = await gate.filter(
			assistantText(
				["Before\n", "```js\nconst a = 1;\n```\n", "Between\n", "```js\nconst b = 2;\n```\n", "After"].join(""),
			),
		);

		expect(twoChunks.checks).toHaveLength(2);
		expect(twoChunks.failed).toBeUndefined();
		expect(textOf(twoChunks.message)).toContain("const b = 2;");
	});

	it("StreamingIPOutputGate reports exact failures without revealing failed code", async () => {
		const gate = new StreamingIPOutputGate({ timeoutMs: 500, checkEveryChunks: 1 });
		const result = await gate.filter(assistantText("Intro\n```js\nconst = ;\n```\nTail"));

		expect(result.failed?.ok).toBe(false);
		expect(result.failed?.message).toBeTruthy();
		expect(textOf(result.message)).toBe("Intro\n");
	});

	it("FlowGraph resolves class method calls and concrete env effects", () => {
		const srcDir = join(testDir, "src");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			join(srcDir, "flow.ts"),
			[
				"export class Runner {",
				"  async run(input: string): Promise<string> {",
				"    const out = helper(input);",
				"    process.env.MY_KEY = out;",
				"    return out;",
				"  }",
				"}",
				"export const helper = (value: string) => value.trim();",
			].join("\n"),
		);

		const store = new FlowGraphStore(join(testDir, ".flow"));
		const graph = store.analyze({ path: srcDir });
		const runner = graph.nodes.find((node) => node.label === "Runner.run");
		const helper = graph.nodes.find((node) => node.label === "helper");
		const env = graph.nodes.find((node) => node.label === "env:MY_KEY");

		expect(runner).toBeTruthy();
		expect(helper).toBeTruthy();
		expect(env).toBeTruthy();
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "calls", fromId: runner?.id, toId: helper?.id }),
				expect.objectContaining({ kind: "writes", fromId: runner?.id, toId: env?.id }),
			]),
		);

		const summary = store.slice(graph.id, undefined, { mode: "summary", limit: 4 });
		const expanded = store.slice(graph.id, "Runner.run", { mode: "expanded", maxDepth: 2, limit: 4 });
		expect(summary.expansionHints.map((hint) => hint.node.label)).toContain("Runner.run");
		expect(expanded.focus?.label).toBe("Runner.run");
		expect(expanded.sections.flatMap((section) => section.edges)).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "calls", toId: helper?.id })]),
		);
	});

	it("TaskPrimer builds a compact Evidence Pack across code, flow, and docs", async () => {
		const srcDir = join(testDir, "src");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			join(srcDir, "flow.ts"),
			[
				"export class Runner {",
				"  run(input: string): string {",
				"    process.env.MY_KEY = input;",
				"    return input;",
				"  }",
				"}",
			].join("\n"),
		);
		const flowStore = new FlowGraphStore(join(testDir, ".flow-pack"));
		flowStore.analyze({ path: srcDir });
		const sparseStore = new SparseTreeGrepStore(join(testDir, ".sparse-pack"));
		const notesPath = join(testDir, "notes.txt");
		writeFileSync(notesPath, "MY_KEY is the environment variable changed by Runner.run during startup.");
		await sparseStore.indexDocument({ path: notesPath, title: "notes" });

		const primer = await new TaskPrimer().prime({
			cwd: testDir,
			prompt: "Trace `Runner.run` and MY_KEY",
			keywords: ["Runner", "MY_KEY"],
			codeGraphs: new CodeGraphStore(join(testDir, ".code-pack")),
			flowGraphs: flowStore,
			sparseTreeGrep: sparseStore,
			symbolIndex: {
				query: () => [
					{
						file: "src/flow.ts",
						hitCount: 1,
						score: 10,
						topHit: {
							file: "src/flow.ts",
							line: 2,
							kind: "method",
							name: "Runner.run",
							exported: true,
							tokenMatches: 2,
						},
					},
				],
			} as never,
		});

		expect(primer.fileHits[0]?.file).toBe("src/flow.ts");
		expect(primer.bugLens[0]?.file).toBe("src/flow.ts");
		expect(primer.bugLens[0]?.reasons.join("\n")).toContain("symbol hit");
		expect(primer.fileStructures[0]?.symbols).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "method", name: "Runner.run" })]),
		);
		expect(primer.flowSlices[0]?.focus).toBe("Runner.run");
		expect(primer.documentHits[0]?.documentName).toBe("notes");
		const brief = renderTaskPrimerBrief(primer, 800);
		expect(brief).toContain("Evidence Pack");
		expect(brief).toContain("BugLens ranked suspects");
		expect(brief).toContain("File structure");
		expect(brief).toContain("Flow slices");
		expect(brief).toContain("Document hits");
	});

	it("TaskPrimer BugLens prioritizes stack-trace file mentions", async () => {
		const srcDir = join(testDir, "src");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(
			join(srcDir, "auth.ts"),
			[
				"export function validateSession(token: string): boolean {",
				"  if (!token) throw new Error('missing token');",
				"  return token.length > 4;",
				"}",
			].join("\n"),
		);
		writeFileSync(join(srcDir, "other.ts"), "export const unrelated = true;\n");

		const primer = await new TaskPrimer().prime({
			cwd: testDir,
			prompt: "The login flow crashes at src/auth.ts:2:10 with missing token in validateSession",
			keywords: ["login", "missing", "token", "validateSession"],
			codeGraphs: new CodeGraphStore(join(testDir, ".bug-code")),
			flowGraphs: new FlowGraphStore(join(testDir, ".bug-flow")),
			symbolIndex: undefined,
		});

		expect(primer.bugLens[0]?.file).toBe("src/auth.ts");
		expect(primer.bugLens[0]?.reasons.join("\n")).toContain("stack/error mention");
		const brief = renderTaskPrimerBrief(primer, 500);
		expect(brief).toContain("BugLens ranked suspects");
		expect(brief).toContain("src/auth.ts");
	});

	it("TaskPrimer BugLens surfaces a call-graph neighbour of a file named in the error", async () => {
		const srcDir = join(testDir, "src");
		mkdirSync(srcDir, { recursive: true });
		// api.ts imports helper.ts — the error names api.ts, but the real fix is
		// often in its neighbour helper.ts. Graph proximity should surface it.
		writeFileSync(
			join(srcDir, "api.ts"),
			['import { helper } from "./helper";', "export function run() {", "  return helper();", "}"].join("\n"),
		);
		writeFileSync(join(srcDir, "helper.ts"), ["export function helper(): number {", "  return 42;", "}"].join("\n"));

		// Index the code graph rooted at cwd so node paths match the prompt's paths.
		const codeGraphs = new CodeGraphStore(join(testDir, ".nbr-code"));
		codeGraphs.index({ path: testDir });

		const primer = await new TaskPrimer().prime({
			cwd: testDir,
			prompt: "Runtime crash: Error at src/api.ts:3: helper is not a function",
			keywords: ["helper", "run"],
			codeGraphs,
			flowGraphs: new FlowGraphStore(join(testDir, ".nbr-flow")),
		});

		const neighbour = primer.bugLens.find((candidate) => candidate.file === "src/helper.ts");
		expect(neighbour).toBeDefined();
		expect(neighbour?.reasons.join("\n")).toContain("call-graph neighbour of src/api.ts");
	});

	it("ASCoT emits rigorous tool-use hints when AXIOM tools are active", () => {
		const classification: AxiomTaskClassification = {
			id: "task",
			kind: "coding",
			route: "agent",
			complexity: 75,
			confidence: 0.9,
			reasons: ["test"],
		};
		const abstraction: AxiomAbstraction = {
			source: "fallback",
			domain: "typescript",
			problemClass: ["debugging"],
			keywords: ["flow"],
			latencyMs: 0,
		};

		const plan = new ASCoTPlanner().plan({
			classification,
			abstraction,
			recalls: [],
			enabled: true,
			availableTools: ["todo_list", "understand_code", "code_graph", "flow_graph"],
		});

		expect(plan.thinkingLevel).toBe("medium");
		expect(plan.strategyHints.join("\n")).toContain("understand_code");
		expect(plan.strategyHints.join("\n")).toContain("code_graph");
		expect(plan.strategyHints.join("\n")).toContain("flow_graph");
		expect(plan.strategyHints.join("\n")).toContain("todo_list");
	});

	it("BenchmarkProtocol injects localization and verifier discipline for coding tasks", () => {
		const classification: AxiomTaskClassification = {
			id: "task",
			kind: "coding",
			route: "agent",
			complexity: 80,
			confidence: 0.9,
			reasons: ["test"],
		};

		const protocol = new BenchmarkProtocol().plan({
			classification,
			availableTools: ["todo_list", "understand_code", "code_graph", "flow_graph", "playwright_cli"],
		});

		expect(protocol?.directives.join("\n")).toContain("Localize before editing");
		expect(protocol?.directives.join("\n")).toContain("Patch narrowly");
		expect(protocol?.toolSequence.join("\n")).toContain("flow_graph");
		expect(protocol?.verifierPolicy.join("\n")).toContain("verifier ladder");
		expect(protocol?.stopRules.join("\n")).toContain("same failure repeats twice");
	});

	it("ReasoningCritic falls back to deterministic scoring when the LLM is unavailable", async () => {
		const scores = await new ReasoningCritic().score({
			task: "Fix a failing test",
			candidates: [
				{
					id: "c1",
					depth: 1,
					path: ["c1"],
					summary: "Run the targeted test, inspect the exact failure, and make a small patch.",
					feasibility: 8,
					completeness: 8,
					risk: 2,
					score: 14,
				},
				{
					id: "c2",
					depth: 1,
					path: ["c2"],
					summary: "Improve and optimize everything broadly.",
					feasibility: 5,
					completeness: 4,
					risk: 8,
					score: 1,
				},
			],
			llm: {
				model: {
					id: "missing",
					name: "missing",
					api: "missing-api",
					provider: "missing",
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				} as never,
				apiKey: "test",
				timeoutMs: 1,
			},
		});

		expect(scores.size).toBe(2);
		expect((scores.get("c1")?.score ?? 0) > (scores.get("c2")?.score ?? 0)).toBe(true);
		expect(scores.get("c1")?.rationale).toContain("Heuristic critic fallback");
	});
});
