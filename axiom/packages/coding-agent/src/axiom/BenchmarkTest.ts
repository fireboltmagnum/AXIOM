import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Usage } from "@axiom/ai";
import { analyzeFile } from "./CodeAnalyzer.ts";
import { CodeGraphStore } from "./CodeGraphStore.ts";
import { ContextLedgerStore } from "./ContextLedgerStore.ts";
import { FlowGraphStore } from "./FlowGraphStore.ts";
import { KnowledgeGraphStore } from "./KnowledgeGraphStore.ts";
import { assessPatchRisk } from "./PatchRiskGate.ts";
import { RepairLoop } from "./RepairLoop.ts";
import { SparseTreeGrepStore } from "./SparseTreeGrepStore.ts";
import { StreamingIPOutputGate } from "./StreamingIPValidator.ts";
import { TodoListStore } from "./TodoListStore.ts";

export type AxiomBenchmarkCategory =
	| "software-engineering"
	| "terminal-agent"
	| "browser-agent"
	| "computer-use"
	| "tool-use"
	| "knowledge-work"
	| "reasoning"
	| "code-generation"
	| "multimodal"
	| "axiom-stress";

export interface AxiomBenchmarkDefinition {
	id: string;
	name: string;
	category: AxiomBenchmarkCategory;
	sourceUrl: string;
	adapter: "external" | "local-stress";
	defaultCommand?: string;
	metrics: string[];
	tags: string[];
	notes: string;
}

export interface AxiomBenchmarkStressResult {
	id: string;
	name: string;
	passed: boolean;
	durationMs: number;
	details: string;
}

export interface AxiomBenchmarkStressSummary {
	passed: boolean;
	total: number;
	passedCount: number;
	failedCount: number;
	durationMs: number;
	results: AxiomBenchmarkStressResult[];
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function external(
	id: string,
	name: string,
	category: AxiomBenchmarkCategory,
	sourceUrl: string,
	tags: string[],
	notes: string,
	defaultCommand?: string,
): AxiomBenchmarkDefinition {
	return {
		id,
		name,
		category,
		sourceUrl,
		adapter: "external",
		defaultCommand,
		metrics: ["pass_rate", "cost", "latency", "tool_calls", "regression_rate"],
		tags,
		notes,
	};
}

export const AXIOM_EXTERNAL_BENCHMARKS: AxiomBenchmarkDefinition[] = [
	external(
		"swe-bench",
		"SWE-bench",
		"software-engineering",
		"https://github.com/swe-bench/SWE-bench",
		["github-issues", "python", "patch"],
		"Real GitHub issue resolution benchmark.",
	),
	external(
		"swe-bench-lite",
		"SWE-bench Lite",
		"software-engineering",
		"https://github.com/swe-bench/SWE-bench",
		["github-issues", "lite", "patch"],
		"Smaller SWE-bench split for faster agent iteration.",
	),
	external(
		"swe-bench-verified",
		"SWE-bench Verified",
		"software-engineering",
		"https://www.swebench.com/",
		["github-issues", "verified", "patch"],
		"Human-filtered SWE-bench subset commonly used for agent score tracking.",
	),
	external(
		"swe-bench-multimodal",
		"SWE-bench Multimodal",
		"software-engineering",
		"https://arxiv.org/abs/2410.03859",
		["vision", "frontend", "patch"],
		"Visual software engineering tasks.",
	),
	external(
		"swe-bench-pro",
		"SWE-bench Pro",
		"software-engineering",
		"https://openreview.net/forum?id=9R2iUHhVfr",
		["long-horizon", "enterprise", "patch"],
		"Harder long-horizon software engineering benchmark.",
	),
	external(
		"swe-skills-bench",
		"SWE-Skills-Bench",
		"software-engineering",
		"https://arxiv.org/abs/2603.15401",
		["skills", "software-engineering"],
		"Tests whether agent skills help real SWE tasks.",
	),
	external(
		"swe-mera",
		"SWE-MERA",
		"software-engineering",
		"https://aclanthology.org/2025.emnlp-demos.30/",
		["dynamic", "software-engineering"],
		"Dynamic agentic software engineering evaluation.",
	),
	external(
		"swe-sharp-bench",
		"SWE-Sharp-Bench",
		"software-engineering",
		"https://huggingface.co/datasets/microsoft/SWE-Sharp-Bench",
		["csharp", "software-engineering"],
		"C# software engineering repair benchmark.",
	),
	external(
		"swe-ci",
		"SWE-CI",
		"software-engineering",
		"https://arxiv.org/search/?query=SWE-CI&searchtype=all",
		["ci", "regression", "maintainability"],
		"Repository-level CI-loop evaluation.",
	),
	external(
		"terminal-bench",
		"Terminal-Bench",
		"terminal-agent",
		"https://www.tbench.ai/",
		["terminal", "sandbox", "verification"],
		"Real terminal tasks with task verifiers.",
		"tb run --agent axiom --dataset terminal-bench-core",
	),
	external(
		"terminal-bench-2",
		"Terminal-Bench 2.0",
		"terminal-agent",
		"https://terminalbench.lol/",
		["terminal", "sandbox", "verification"],
		"Newer Terminal-Bench suite for real terminal agent work.",
	),
	external(
		"osworld",
		"OSWorld",
		"computer-use",
		"https://os-world.github.io/",
		["desktop", "computer-use"],
		"Desktop OS control benchmark.",
	),
	external(
		"windows-agent-arena",
		"WindowsAgentArena",
		"computer-use",
		"https://microsoft.github.io/WindowsAgentArena/",
		["windows", "desktop"],
		"Windows desktop agent benchmark.",
	),
	external(
		"android-world",
		"AndroidWorld",
		"computer-use",
		"https://github.com/google-research/android_world",
		["android", "mobile"],
		"Android environment benchmark for agents.",
	),
	external(
		"webarena",
		"WebArena",
		"browser-agent",
		"https://webarena.dev/",
		["browser", "web"],
		"Self-hosted web task benchmark.",
	),
	external(
		"visualwebarena",
		"VisualWebArena",
		"browser-agent",
		"https://github.com/web-arena-x/visualwebarena",
		["browser", "vision"],
		"Visual web-navigation agent benchmark.",
	),
	external(
		"webvoyager",
		"WebVoyager",
		"browser-agent",
		"https://github.com/MinorJerry/WebVoyager",
		["browser", "web"],
		"Web browsing task benchmark.",
	),
	external(
		"browsergym",
		"BrowserGym",
		"browser-agent",
		"https://github.com/ServiceNow/BrowserGym",
		["browser", "gym"],
		"Browser agent evaluation environment.",
	),
	external(
		"workarena",
		"WorkArena",
		"browser-agent",
		"https://github.com/ServiceNow/WorkArena",
		["browser", "enterprise"],
		"Enterprise-style browser task benchmark.",
	),
	external(
		"mind2web",
		"Mind2Web",
		"browser-agent",
		"https://github.com/OSU-NLP-Group/Mind2Web",
		["browser", "web"],
		"Generalist web task benchmark.",
	),
	external(
		"miniwob",
		"MiniWoB++",
		"browser-agent",
		"https://github.com/Farama-Foundation/miniwob-plusplus",
		["browser", "mini-tasks"],
		"Small browser-control tasks.",
	),
	external(
		"webshop",
		"WebShop",
		"browser-agent",
		"https://github.com/princeton-nlp/WebShop",
		["browser", "shopping"],
		"Online shopping task benchmark.",
	),
	external(
		"weblinx",
		"WebLINX",
		"browser-agent",
		"https://mcgill-nlp.github.io/weblinx/",
		["browser", "demonstrations"],
		"Web task benchmark from interaction traces.",
	),
	external(
		"tau-bench-retail",
		"tau-bench Retail",
		"tool-use",
		"https://github.com/sierra-research/tau-bench",
		["tool-use", "multi-turn", "retail"],
		"Tool-agent-user benchmark retail environment.",
	),
	external(
		"tau-bench-airline",
		"tau-bench Airline",
		"tool-use",
		"https://github.com/sierra-research/tau-bench",
		["tool-use", "multi-turn", "airline"],
		"Tool-agent-user benchmark airline environment.",
	),
	external(
		"toolbench",
		"ToolBench",
		"tool-use",
		"https://github.com/OpenBMB/ToolBench",
		["tool-use", "apis"],
		"Tool-use benchmark with API calls.",
	),
	external(
		"api-bank",
		"API-Bank",
		"tool-use",
		"https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/api-bank",
		["tool-use", "apis"],
		"API tool-use benchmark.",
	),
	external(
		"bfcl",
		"Berkeley Function Calling Leaderboard",
		"tool-use",
		"https://gorilla.cs.berkeley.edu/leaderboard.html",
		["function-calling"],
		"Function calling evaluation.",
	),
	external(
		"toolqa",
		"ToolQA",
		"tool-use",
		"https://github.com/night-chen/ToolQA",
		["tool-use", "question-answering"],
		"QA requiring external tools.",
	),
	external(
		"restbench",
		"RestBench",
		"tool-use",
		"https://github.com/Yifan-Song793/RestGPT",
		["rest", "apis"],
		"REST API planning and use benchmark.",
	),
	external(
		"agentbench",
		"AgentBench",
		"tool-use",
		"https://github.com/THUDM/AgentBench",
		["agent", "multi-domain"],
		"Multi-domain agent benchmark.",
	),
	external(
		"agentboard",
		"AgentBoard",
		"tool-use",
		"https://github.com/hkust-nlp/AgentBoard",
		["agent", "evaluation"],
		"Agent benchmark and evaluation board.",
	),
	external(
		"gaia",
		"GAIA",
		"knowledge-work",
		"https://huggingface.co/gaia-benchmark",
		["knowledge-work", "tools"],
		"General AI assistant benchmark with tool use.",
	),
	external(
		"gaia2",
		"GAIA 2",
		"knowledge-work",
		"https://huggingface.co/gaia-benchmark",
		["knowledge-work", "tools"],
		"Updated GAIA-style knowledge work suite.",
	),
	external(
		"browsecomp",
		"BrowseComp",
		"knowledge-work",
		"https://openai.com/index/browsecomp/",
		["browsing", "knowledge-work"],
		"Browsing-heavy factual task benchmark.",
	),
	external(
		"simpleqa",
		"SimpleQA",
		"knowledge-work",
		"https://openai.com/index/introducing-simpleqa/",
		["factuality", "qa"],
		"Short factual question benchmark.",
	),
	external(
		"gpqa",
		"GPQA Diamond",
		"reasoning",
		"https://github.com/idavidrein/gpqa",
		["reasoning", "science"],
		"Graduate-level science reasoning.",
	),
	external(
		"hle",
		"Humanity's Last Exam",
		"reasoning",
		"https://lastexam.ai/",
		["reasoning", "multidisciplinary"],
		"Hard multidisciplinary reasoning benchmark.",
	),
	external(
		"arc-agi-1",
		"ARC-AGI-1",
		"reasoning",
		"https://github.com/fchollet/ARC-AGI",
		["reasoning", "abstraction"],
		"Abstract reasoning benchmark.",
	),
	external(
		"arc-agi-2",
		"ARC-AGI-2",
		"reasoning",
		"https://arcprize.org/",
		["reasoning", "abstraction"],
		"Newer ARC-style abstraction benchmark.",
	),
	external(
		"mmlu",
		"MMLU",
		"reasoning",
		"https://github.com/hendrycks/test",
		["knowledge", "reasoning"],
		"Multi-task language understanding benchmark.",
	),
	external(
		"mmlu-pro",
		"MMLU-Pro",
		"reasoning",
		"https://github.com/TIGER-AI-Lab/MMLU-Pro",
		["knowledge", "reasoning"],
		"Harder MMLU-style benchmark.",
	),
	external(
		"drop",
		"DROP",
		"reasoning",
		"https://allenai.org/data/drop",
		["reading", "reasoning"],
		"Discrete reasoning over paragraphs.",
	),
	external(
		"gsm8k",
		"GSM8K",
		"reasoning",
		"https://github.com/openai/grade-school-math",
		["math", "reasoning"],
		"Grade-school math word problems.",
	),
	external(
		"math",
		"MATH",
		"reasoning",
		"https://github.com/hendrycks/math",
		["math", "reasoning"],
		"Competition math benchmark.",
	),
	external(
		"aime",
		"AIME",
		"reasoning",
		"https://artofproblemsolving.com/wiki/index.php/AIME_Problems_and_Solutions",
		["math", "reasoning"],
		"AIME math problems.",
	),
	external(
		"humaneval",
		"HumanEval",
		"code-generation",
		"https://github.com/openai/human-eval",
		["code", "python"],
		"Function-level Python coding benchmark.",
	),
	external(
		"mbpp",
		"MBPP",
		"code-generation",
		"https://github.com/google-research/google-research/tree/master/mbpp",
		["code", "python"],
		"Mostly Basic Python Problems.",
	),
	external(
		"livecodebench",
		"LiveCodeBench",
		"code-generation",
		"https://livecodebench.github.io/",
		["code", "dynamic"],
		"Contamination-resistant coding benchmark.",
	),
	external(
		"bigcodebench",
		"BigCodeBench",
		"code-generation",
		"https://bigcode-bench.github.io/",
		["code", "execution"],
		"Practical code generation benchmark.",
	),
	external(
		"bigcodebench-hard",
		"BigCodeBench-Hard",
		"code-generation",
		"https://bigcode-bench.github.io/",
		["code", "execution", "hard"],
		"Hard subset of BigCodeBench.",
	),
	external(
		"apps",
		"APPS",
		"code-generation",
		"https://github.com/hendrycks/apps",
		["code", "competitive"],
		"Programming problem benchmark.",
	),
	external(
		"codecontests",
		"CodeContests",
		"code-generation",
		"https://github.com/deepmind/code_contests",
		["code", "competitive"],
		"Competitive programming benchmark.",
	),
	external(
		"ds1000",
		"DS-1000",
		"code-generation",
		"https://ds1000-code-gen.github.io/",
		["code", "data-science"],
		"Data science code generation benchmark.",
	),
	external(
		"cruxeval",
		"CRUXEval",
		"code-generation",
		"https://github.com/facebookresearch/cruxeval",
		["code", "execution-reasoning"],
		"Code execution/input-output reasoning.",
	),
	external(
		"repobench",
		"RepoBench",
		"code-generation",
		"https://github.com/Leolty/repobench",
		["code", "repository"],
		"Repository-level code completion.",
	),
	external(
		"crosscodeeval",
		"CrossCodeEval",
		"code-generation",
		"https://github.com/amazon-science/cceval",
		["code", "cross-file"],
		"Cross-file code evaluation.",
	),
	external(
		"aider-polyglot",
		"Aider Polyglot",
		"software-engineering",
		"https://aider.chat/docs/leaderboards/",
		["code", "multi-language"],
		"Multi-language coding exercises used by Aider.",
	),
	external(
		"mmmu",
		"MMMU",
		"multimodal",
		"https://mmmu-benchmark.github.io/",
		["vision", "reasoning"],
		"Multimodal university-level reasoning.",
	),
	external(
		"mathvista",
		"MathVista",
		"multimodal",
		"https://mathvista.github.io/",
		["vision", "math"],
		"Visual math reasoning.",
	),
	external(
		"chartqa",
		"ChartQA",
		"multimodal",
		"https://github.com/vis-nlp/ChartQA",
		["vision", "charts"],
		"Chart question answering.",
	),
	external(
		"docvqa",
		"DocVQA",
		"multimodal",
		"https://www.docvqa.org/",
		["vision", "documents"],
		"Document visual question answering.",
	),
	external(
		"ocrbench",
		"OCRBench",
		"multimodal",
		"https://github.com/Yuliang-Liu/MultimodalOCR",
		["vision", "ocr"],
		"OCR-centric multimodal benchmark.",
	),
];

export function getAxiomBenchmarkRegistry(): AxiomBenchmarkDefinition[] {
	return [...AXIOM_EXTERNAL_BENCHMARKS, ...AXIOM_STRESS_BENCHMARKS];
}

export function summarizeBenchmarkRegistry(): string {
	const registry = getAxiomBenchmarkRegistry();
	const counts = new Map<AxiomBenchmarkCategory, number>();
	for (const item of registry) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
	const lines = [`AXIOM Benchmark Test Registry: ${registry.length} benchmarks`];
	for (const [category, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`- ${category}: ${count}`);
	}
	return lines.join("\n");
}

export const AXIOM_STRESS_BENCHMARKS: AxiomBenchmarkDefinition[] = [
	"code_analyzer_symbols",
	"sparse_tree_grep_scene",
	"code_graph_neighbors",
	"flow_graph_effects",
	"knowledge_graph_fact",
	"todo_list_persistence",
	"streaming_ip_gate",
	"patch_risk_gate",
	"repair_loop_no_verifier",
	"context_ledger_budget",
].map((id) => ({
	id,
	name: id
		.split("_")
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" "),
	category: "axiom-stress" as const,
	sourceUrl: "local://axiom-stress",
	adapter: "local-stress" as const,
	metrics: ["pass", "latency_ms"],
	tags: ["axiom", "stress"],
	notes: "Fast local stress test for an AXIOM-native tool or safety gate.",
}));

export async function runAxiomStressBenchmarks(options?: { filter?: string }): Promise<AxiomBenchmarkStressSummary> {
	const startedAt = Date.now();
	const tempRoot = mkdtempSync(path.join(tmpdir(), "axiom-benchmark-test-"));
	const cases = stressCases(tempRoot).filter((testCase) => !options?.filter || testCase.id.includes(options.filter));
	const results: AxiomBenchmarkStressResult[] = [];
	try {
		for (const testCase of cases) {
			const caseStarted = Date.now();
			try {
				const details = await testCase.run();
				results.push({
					id: testCase.id,
					name: testCase.name,
					passed: true,
					durationMs: Date.now() - caseStarted,
					details,
				});
			} catch (error) {
				results.push({
					id: testCase.id,
					name: testCase.name,
					passed: false,
					durationMs: Date.now() - caseStarted,
					details: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	const passedCount = results.filter((result) => result.passed).length;
	return {
		passed: passedCount === results.length,
		total: results.length,
		passedCount,
		failedCount: results.length - passedCount,
		durationMs: Date.now() - startedAt,
		results,
	};
}

interface StressCase {
	id: string;
	name: string;
	run: () => Promise<string> | string;
}

function stressCases(root: string): StressCase[] {
	const projectDir = path.join(root, "project");
	mkdirSync(path.join(projectDir, "src"), { recursive: true });
	return [
		{
			id: "code_analyzer_symbols",
			name: "CodeAnalyzer symbol extraction",
			run: () => {
				const understanding = analyzeFile(
					"src/app.ts",
					"export class App { run() { return helper(); } }\nexport const helper = () => 1;\n",
				);
				assert(
					understanding.symbols.some((symbol) => symbol.name === "App"),
					"class App missing",
				);
				assert(
					understanding.symbols.some((symbol) => symbol.name === "helper"),
					"helper missing",
				);
				return `${understanding.symbols.length} symbols`;
			},
		},
		{
			id: "sparse_tree_grep_scene",
			name: "SparseTreeGrep scene retrieval",
			run: async () => {
				const docPath = path.join(root, "book.txt");
				writeFileSync(
					docPath,
					"Anna met Gosh in town.\n\nAnna shoved Gosh behind a table as the gunfight started.\n",
				);
				const store = new SparseTreeGrepStore(path.join(root, ".sparse"));
				const index = await store.indexDocument({ path: docPath });
				const hits = await store.searchReranked("fight between Anna and Gosh", {
					documentId: index.documentId,
					limit: 1,
				});
				assert(hits[0]?.chunkSummary.toLowerCase().includes("gunfight"), "gunfight scene not top hit");
				return `${index.chunkCount} chunks`;
			},
		},
		{
			id: "code_graph_neighbors",
			name: "CodeGraph import neighbor lookup",
			run: () => {
				writeFileSync(
					path.join(projectDir, "src", "a.ts"),
					"import { helper } from './helper';\nexport const run = () => helper();\n",
				);
				writeFileSync(path.join(projectDir, "src", "helper.ts"), "export const helper = () => 1;\n");
				const store = new CodeGraphStore(path.join(root, ".codegraph"));
				const graph = store.index({ path: path.join(projectDir, "src"), maxFiles: 4 });
				const hits = store.search("helper", { graphId: graph.id, limit: 3 });
				assert(hits.length > 0, "no graph hit for helper");
				return `${graph.nodeCount} nodes/${graph.edgeCount} edges`;
			},
		},
		{
			id: "flow_graph_effects",
			name: "FlowGraph effect extraction",
			run: () => {
				writeFileSync(
					path.join(projectDir, "src", "effect.ts"),
					"import fs from 'node:fs';\nexport function save(){ fs.writeFileSync('x','y'); }\n",
				);
				const store = new FlowGraphStore(path.join(root, ".flow"));
				const graph = store.analyze({ path: path.join(projectDir, "src"), maxFiles: 6 });
				const effects = store.effects(graph.id, "write", 5);
				assert(
					effects.nodes.some((node) => node.kind === "effect"),
					"write effect missing",
				);
				return `${effects.nodes.length} effect nodes`;
			},
		},
		{
			id: "knowledge_graph_fact",
			name: "KnowledgeGraph fact search",
			run: () => {
				const store = new KnowledgeGraphStore(path.join(root, ".knowledge"));
				store.addFact({ subject: "AXIOM", relation: "uses", object: "SparseTreeGrep" });
				const hits = store.search("AXIOM SparseTreeGrep", 3);
				assert(hits.length > 0, "knowledge graph hit missing");
				return `${hits.length} hits`;
			},
		},
		{
			id: "todo_list_persistence",
			name: "TodoList persistence",
			run: () => {
				const store = new TodoListStore(path.join(root, ".todos"));
				store.create({ sessionId: "bench", title: "Bench", items: ["one", "two"] });
				const loaded = store.load("bench");
				assert(loaded?.items.length === 2, "todo list did not persist");
				return "2 todos persisted";
			},
		},
		{
			id: "streaming_ip_gate",
			name: "Streaming IP output gate",
			run: async () => {
				const gate = new StreamingIPOutputGate({ timeoutMs: 500, checkEveryChunks: 1 });
				const ok = await gate.filter(assistantText("Intro\n```js\nconst x = 1;\n```\nDone"));
				assert(ok.failed === undefined, "valid JS failed");
				assert(textOf(ok.message).includes("const x = 1"), "valid code was not released");
				const bad = await new StreamingIPOutputGate({ timeoutMs: 500, checkEveryChunks: 1 }).filter(
					assistantText("Intro\n```js\nconst = ;\n```\nDone"),
				);
				assert(bad.failed?.ok === false, "invalid JS was not caught");
				assert(!textOf(bad.message).includes("const = ;"), "invalid code leaked");
				return "valid released, invalid held";
			},
		},
		{
			id: "patch_risk_gate",
			name: "PatchRiskGate test weakening detection",
			run: () => {
				const file = path.join(projectDir, "src", "x.test.ts");
				writeFileSync(file, "it.skip('works', () => { expect(1).toBe(1); });\n");
				const risk = assessPatchRisk({
					cwd: projectDir,
					changedFiles: [file],
					verifierPassed: true,
					preEditSnapshots: new Map([
						[file, { existed: true, content: "it('works', () => { expect(1).toBe(1); });\n" }],
					]),
				});
				assert(risk.shouldBlock, "test weakening was not blocked");
				return risk.summary;
			},
		},
		{
			id: "repair_loop_no_verifier",
			name: "RepairLoop no-verifier evidence gate",
			run: async () => {
				const file = path.join(projectDir, "src", "lonely.ts");
				writeFileSync(file, "export const value = 1;\n");
				const loop = new RepairLoop({ cwd: projectDir });
				const result = await loop.run({ changedFiles: [file], timeoutMs: 1000, attempt: 1, maxAttempts: 2 });
				const packet = loop.buildNoVerifierPacket({ changedFiles: [file], attempt: 1, maxAttempts: 2 });
				assert(result === undefined, "unexpected verifier detected");
				assert(packet?.packet.includes("Verification Evidence Gate"), "no-verifier packet missing");
				return "no-verifier packet built";
			},
		},
		{
			id: "context_ledger_budget",
			name: "ContextLedger budget trim",
			run: () => {
				const store = new ContextLedgerStore(path.join(root, ".ledger"));
				const plan = store.evaluateAndRecord({
					traceId: "bench",
					taskSignature: "bench-task",
					taskKind: "coding",
					keywords: ["alpha"],
					maxEstimatedTokens: 60,
					candidates: [
						{
							key: "a",
							kind: "reflection",
							label: "alpha",
							summary: "alpha ".repeat(20),
							sourceIds: ["a"],
							matchedKeywords: ["alpha"],
							relevanceScore: 4,
							estimatedTokens: 50,
						},
						{
							key: "b",
							kind: "skill",
							label: "beta",
							summary: "beta ".repeat(80),
							sourceIds: ["b"],
							matchedKeywords: ["beta"],
							relevanceScore: 1,
							estimatedTokens: 120,
						},
					],
				});
				assert(plan.injected.length === 1, "ledger did not keep exactly one item");
				assert(plan.dropped.length === 1, "ledger did not drop budget overflow");
				return `${plan.estimatedTokensSaved} tokens saved`;
			},
		},
	];
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
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
