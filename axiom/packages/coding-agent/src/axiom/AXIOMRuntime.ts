import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent } from "@axiom/agent-core";
import type { AssistantMessage, Model } from "@axiom/ai";
import { ASCoTPlanner } from "./ASCoTPlanner.ts";
import { AXIOMTraceStore } from "./AXIOMTrace.ts";
import { BenchmarkProtocol } from "./BenchmarkProtocol.ts";
import { CodebaseFingerprint } from "./CodebaseFingerprint.ts";
import { CodeSymbolIndex } from "./CodeSymbolIndex.ts";
import { ContextAgent } from "./ContextAgent.ts";
import { ContextLedgerStore } from "./ContextLedgerStore.ts";
import { GraphPlanner } from "./GraphPlanner.ts";
import { AXIOM_IP_RETRY_END_TAG, AXIOM_IP_RETRY_TAG, IPValidator } from "./IPValidator.ts";
import { ReasoningCritic } from "./ReasoningCritic.ts";
import { RStarPlanner } from "./RStarPlanner.ts";
import type {
	AxiomAbstraction,
	AxiomCodeGraphHit,
	AxiomConceptSummary,
	AxiomContextLedgerCandidate,
	AxiomContextLedgerOutcome,
	AxiomFlowGraphHit,
	AxiomGraphExecutionSnapshot,
	AxiomGraphExecutionUpdate,
	AxiomIPIssue,
	AxiomIPValidationResult,
	AxiomKnowledgeGraphHit,
	AxiomReasoningGraph,
	AxiomReflection,
	AxiomReflectionRecallHit,
	AxiomRuntimePromptContext,
	AxiomRuntimeSettings,
	AxiomSkill,
	AxiomSkillOutcome,
	AxiomSkillRecallHit,
	AxiomSparseTreeGrepHit,
	AxiomTaskClassification,
	AxiomTaskKind,
	AxiomTaskPlan,
	AxiomTaskPrimer,
	AxiomTraceMessageSummary,
	AxiomTraceModelSnapshot,
	AxiomUnderstandingRecallHit,
} from "./RuntimeTypes.ts";
import { StepBackAbstractor } from "./StepBackAbstractor.ts";
import type { StreamingChunkCheckResult } from "./StreamingIPValidator.ts";
import { TaskClassifier } from "./TaskClassifier.ts";
import { renderTaskPrimerBrief, TaskPrimer } from "./TaskPrimer.ts";

function textAndThinkingStats(message: AssistantMessage): {
	textChars: number;
	thinkingChars: number;
	toolCallCount: number;
} {
	let textChars = 0;
	let thinkingChars = 0;
	let toolCallCount = 0;
	for (const part of message.content) {
		if (part.type === "text") {
			textChars += part.text.length;
		} else if (part.type === "thinking") {
			thinkingChars += part.thinking.length;
		} else if (part.type === "toolCall") {
			toolCallCount++;
		}
	}
	return { textChars, thinkingChars, toolCallCount };
}

function snippet(text: string, limit = 240): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function buildSkillTitle(options: { taskKind: AxiomTaskKind; abstraction: AxiomAbstraction }): string {
	const head = options.abstraction.problemClass[0] ?? options.abstraction.keywords[0] ?? options.taskKind;
	const domain = options.abstraction.domain !== "general" ? `${options.abstraction.domain}: ` : "";
	return `${domain}${head}`.slice(0, 120);
}

function renderReasoningGraphTree(graph: AxiomReasoningGraph): string[] {
	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, typeof graph.nodes>();
	const roots: typeof graph.nodes = [];

	for (const node of graph.nodes) {
		const parentId = node.parentId && nodesById.has(node.parentId) ? node.parentId : undefined;
		if (!parentId) {
			roots.push(node);
			continue;
		}
		const children = childrenByParent.get(parentId) ?? [];
		children.push(node);
		childrenByParent.set(parentId, children);
	}

	const rendered: string[] = [];
	const visit = (node: (typeof graph.nodes)[number], depth: number) => {
		const indent = "  ".repeat(Math.max(0, depth));
		const deps = node.dependencies.length > 0 ? ` (depends: ${node.dependencies.join(", ")})` : "";
		const tool = node.expectedTool ? ` [${node.expectedTool}]` : "";
		const atomic = node.atomic ? " [atomic]" : "";
		rendered.push(`${indent}- **${node.id}**${tool}${atomic} ${node.description}${deps}`);
		if (node.atomic) {
			if (node.successCriteria) rendered.push(`${indent}  Success: ${node.successCriteria}`);
			if (node.output) rendered.push(`${indent}  Output: ${node.output}`);
		}
		for (const child of childrenByParent.get(node.id) ?? []) {
			visit(child, depth + 1);
		}
	};

	for (const root of roots.length > 0 ? roots : graph.nodes.filter((node) => !node.parentId)) {
		visit(root, 0);
	}
	return rendered;
}

interface RecallBundle {
	recalls: AxiomReflectionRecallHit[];
	skillRecalls: AxiomSkillRecallHit[];
	understandingRecalls: AxiomUnderstandingRecallHit[];
	codeGraphRecalls: AxiomCodeGraphHit[];
	flowGraphRecalls: AxiomFlowGraphHit[];
	knowledgeGraphRecalls: AxiomKnowledgeGraphHit[];
	sparseTreeGrepRecalls: AxiomSparseTreeGrepHit[];
	conceptRecalls: AxiomConceptSummary[];
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
}

function taskSignatureFor(options: {
	text: string;
	classification: AxiomTaskClassification;
	keywords: readonly string[];
}): string {
	return createHash("sha256")
		.update(
			[
				options.classification.kind,
				options.classification.route,
				...options.keywords.slice(0, 24).map((keyword) => keyword.toLowerCase()),
				snippet(options.text, 500).toLowerCase(),
			].join("\n"),
		)
		.digest("hex")
		.slice(0, 20);
}

function buildContextLedgerCandidates(bundle: RecallBundle): AxiomContextLedgerCandidate[] {
	const candidates: AxiomContextLedgerCandidate[] = [];

	for (const hit of bundle.recalls) {
		const r = hit.reflection;
		const summary = `${r.failureType}: ${r.cause} Correction: ${r.correction}`;
		candidates.push({
			key: `reflection:${r.id}`,
			kind: "reflection",
			label: `${r.failureType}:${r.id}`,
			summary: snippet(summary, 260),
			sourceIds: [r.id],
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.skillRecalls) {
		const s = hit.skill;
		const summary = `${s.title}. Tools: ${s.toolsUsed.join(", ") || "none"}. ${s.taskSnippet}`;
		candidates.push({
			key: `skill:${s.id}`,
			kind: "skill",
			label: s.title,
			summary: snippet(summary, 260),
			sourceIds: [s.id],
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.understandingRecalls) {
		const u = hit.understanding;
		const files = u.files
			.slice(0, 4)
			.map((file) => `${file.path}:${file.symbols.map((symbol) => symbol.name).join(",")}`)
			.join(" ");
		const summary = `${u.rootPath} ${u.fileCount} files ${files}`;
		candidates.push({
			key: `understanding:${u.id}`,
			kind: "understanding",
			label: u.rootPath,
			summary: snippet(summary, 260),
			sourceIds: [u.id],
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.codeGraphRecalls) {
		const primary = hit.nodes[0];
		const edgeSummary = hit.edges
			.slice(0, 4)
			.map((edge) => `${edge.fromId}-${edge.kind}-${edge.toId}`)
			.join(" ");
		const summary = `${hit.graph.rootPath} ${primary?.label ?? "graph"} ${edgeSummary}`;
		candidates.push({
			key: `code_graph:${hit.graph.id}:${primary?.id ?? hit.matchedKeywords.join(",")}`,
			kind: "code_graph",
			label: `${hit.graph.rootPath}:${primary?.label ?? "graph"}`,
			summary: snippet(summary, 260),
			sourceIds: [hit.graph.id, primary?.id].filter((value): value is string => !!value),
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.flowGraphRecalls) {
		const primary = hit.nodes[0];
		const edgeSummary = hit.edges
			.slice(0, 5)
			.map((edge) => `${edge.fromId}-${edge.kind}-${edge.toId}`)
			.join(" ");
		const summary = `${hit.graph.rootPath} ${primary?.label ?? "flow"} ${edgeSummary}`;
		candidates.push({
			key: `flow_graph:${hit.graph.id}:${primary?.id ?? hit.matchedKeywords.join(",")}`,
			kind: "flow_graph",
			label: `${hit.graph.rootPath}:${primary?.label ?? "flow"}`,
			summary: snippet(summary, 260),
			sourceIds: [hit.graph.id, primary?.id].filter((value): value is string => !!value),
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.knowledgeGraphRecalls) {
		const edgeLabels = hit.edges
			.slice(0, 5)
			.map((edge) => `${edge.fromId}-${edge.relation}-${edge.toId}`)
			.join(" ");
		const label = hit.nodes[0]?.label ?? hit.edges[0]?.relation ?? "knowledge";
		const summary = `${label} ${edgeLabels}`;
		candidates.push({
			key: `knowledge_graph:${hit.edges
				.slice(0, 3)
				.map((edge) => edge.id)
				.join(",")}`,
			kind: "knowledge_graph",
			label,
			summary: snippet(summary, 260),
			sourceIds: [...hit.nodes.map((node) => node.id), ...hit.edges.map((edge) => edge.id)].slice(0, 12),
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const hit of bundle.sparseTreeGrepRecalls) {
		const summary = `${hit.documentName} ${hit.chunkId} ${hit.nodeLabel ?? ""} ${hit.chunkSummary}`;
		candidates.push({
			key: `sparse_tree_grep:${hit.documentId}:${hit.chunkId}`,
			kind: "sparse_tree_grep",
			label: `${hit.documentName}:${hit.chunkId}`,
			summary: snippet(summary, 260),
			sourceIds: [hit.documentId, hit.chunkId],
			matchedKeywords: hit.matchedKeywords,
			relevanceScore: hit.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	for (const concept of bundle.conceptRecalls) {
		const summary = `${concept.problemClass}: ${concept.reflectionIds.length} reflections, ${concept.skillIds.length} skills, ${concept.edges.length} edges.`;
		candidates.push({
			key: `concept:${concept.problemClass.toLowerCase()}`,
			kind: "concept",
			label: concept.problemClass,
			summary,
			sourceIds: [...concept.reflectionIds, ...concept.skillIds].slice(0, 12),
			matchedKeywords: [concept.problemClass],
			relevanceScore: concept.score,
			estimatedTokens: estimateTokens(summary),
		});
	}

	return candidates;
}

function filterBundleByContextLedger(bundle: RecallBundle, injectedKeys: Set<string>): RecallBundle {
	return {
		recalls: bundle.recalls.filter((hit) => injectedKeys.has(`reflection:${hit.reflection.id}`)),
		skillRecalls: bundle.skillRecalls.filter((hit) => injectedKeys.has(`skill:${hit.skill.id}`)),
		understandingRecalls: bundle.understandingRecalls.filter((hit) =>
			injectedKeys.has(`understanding:${hit.understanding.id}`),
		),
		codeGraphRecalls: bundle.codeGraphRecalls.filter((hit) => {
			const primary = hit.nodes[0];
			return injectedKeys.has(`code_graph:${hit.graph.id}:${primary?.id ?? hit.matchedKeywords.join(",")}`);
		}),
		flowGraphRecalls: bundle.flowGraphRecalls.filter((hit) => {
			const primary = hit.nodes[0];
			return injectedKeys.has(`flow_graph:${hit.graph.id}:${primary?.id ?? hit.matchedKeywords.join(",")}`);
		}),
		knowledgeGraphRecalls: bundle.knowledgeGraphRecalls.filter((hit) =>
			injectedKeys.has(
				`knowledge_graph:${hit.edges
					.slice(0, 3)
					.map((edge) => edge.id)
					.join(",")}`,
			),
		),
		sparseTreeGrepRecalls: bundle.sparseTreeGrepRecalls.filter((hit) =>
			injectedKeys.has(`sparse_tree_grep:${hit.documentId}:${hit.chunkId}`),
		),
		conceptRecalls: bundle.conceptRecalls.filter((concept) =>
			injectedKeys.has(`concept:${concept.problemClass.toLowerCase()}`),
		),
	};
}

export class AXIOMRuntime {
	private readonly classifier = new TaskClassifier();
	private readonly validator = new IPValidator();
	private readonly stepBack = new StepBackAbstractor();
	private readonly ascot = new ASCoTPlanner();
	private readonly context = new ContextAgent();
	private readonly contextLedger = new ContextLedgerStore();
	private readonly graphPlanner = new GraphPlanner();
	private readonly rstarPlanner = new RStarPlanner();
	private readonly critic = new ReasoningCritic();
	private readonly benchmarkProtocol = new BenchmarkProtocol();
	private readonly taskPrimer = new TaskPrimer();
	private readonly traceStore: AXIOMTraceStore;
	private readonly settings: AxiomRuntimeSettings;
	private readonly cwd: string;
	/** Lazy: only constructed when autoRetrieval first fires. Cheap on
	 * construction (no I/O) but the first .query() walks the repo, so we
	 * defer until we actually need it. */
	private codeSymbolIndex: CodeSymbolIndex | undefined;
	/** Lazy per-repo style profile. Same gate as autoRetrieval — both are
	 * pre-task context injection. ~50-200ms cold; cached on disk thereafter. */
	private codebaseFingerprint: CodebaseFingerprint | undefined;

	constructor(options: { cwd: string; sessionId: string; settings: AxiomRuntimeSettings }) {
		this.settings = options.settings;
		this.cwd = options.cwd;
		this.traceStore = new AXIOMTraceStore({
			cwd: options.cwd,
			sessionId: options.sessionId,
			enabled: options.settings.enabled && options.settings.trace,
		});
	}

	classifyPrompt(context: AxiomRuntimePromptContext): AxiomTaskClassification {
		if (!this.settings.enabled) {
			return {
				id: "disabled",
				kind: "general",
				route: "direct",
				complexity: 50,
				confidence: 0,
				reasons: ["AXIOM runtime disabled"],
			};
		}

		if (!this.settings.difficultyRouter) {
			return {
				id: randomUUID(),
				kind: "general",
				route: "direct",
				complexity: 50,
				confidence: 0,
				reasons: ["AXIOM difficulty router disabled"],
			};
		}

		const classification = this.classifier.classify({
			text: context.text,
			hasImages: context.hasImages,
			hasPendingContext: context.hasPendingContext,
			activeToolNames: context.activeToolNames,
		});

		if (!this.settings.fastPath) {
			return {
				...classification,
				route: classification.route === "local" ? "direct" : classification.route,
				fastPathReply: undefined,
			};
		}

		return classification;
	}

	/**
	 * Build the full pre-task plan: Step-Back abstraction, Reflexion recall, and
	 * ASCoT depth selection. Safe to call always; respects settings flags and
	 * degrades gracefully if any sub-step fails.
	 */
	async planTask(options: {
		traceId: string;
		text: string;
		classification: AxiomTaskClassification;
		model?: Model<any>;
		auth?: { apiKey: string; headers?: Record<string, string> };
		stepBackTimeoutMs?: number;
		graphPlannerTimeoutMs?: number;
		criticTimeoutMs?: number;
		availableTools?: string[];
	}): Promise<AxiomTaskPlan> {
		const { traceId, text, classification, model, auth } = options;

		// Step 1: abstraction
		let abstraction: AxiomAbstraction;
		const shouldUseLLM =
			this.settings.enabled &&
			this.settings.stepBack &&
			classification.complexity >= this.settings.stepBackMinComplexity &&
			!!model &&
			!!auth;
		if (shouldUseLLM && model && auth) {
			const llmResult = await this.stepBack.llm(text, {
				model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				timeoutMs: options.stepBackTimeoutMs ?? 5000,
			});
			abstraction = llmResult ?? this.stepBack.fallback(text);
		} else {
			abstraction = this.stepBack.fallback(text);
		}

		this.traceStore.record({
			type: "step_back",
			timestamp: new Date().toISOString(),
			traceId,
			source: abstraction.source,
			problemClass: abstraction.problemClass,
			keywords: abstraction.keywords,
			domain: abstraction.domain,
			latencyMs: abstraction.latencyMs,
		});

		// Step 2: unified Context Agent recall (reflections + skills + code understandings + concepts)
		const recallKeywords = [...abstraction.keywords, ...abstraction.problemClass.map((p) => p.toLowerCase())];
		const limitReflections = this.settings.enabled && this.settings.reflexion ? this.settings.reflexionMaxRecall : 0;
		const limitSkills = this.settings.enabled && this.settings.skillEvolution ? this.settings.skillMaxRecall : 0;
		const limitUnderstandings =
			this.settings.enabled && this.settings.codeUnderstanding ? this.settings.codeUnderstandingMaxRecall : 0;
		const limitCodeGraphs = this.settings.enabled && this.settings.codeGraph ? this.settings.codeGraphMaxRecall : 0;
		const limitFlowGraphs = this.settings.enabled && this.settings.flowGraph ? this.settings.flowGraphMaxRecall : 0;
		const limitKnowledgeGraph =
			this.settings.enabled && this.settings.knowledgeGraph ? this.settings.knowledgeGraphMaxRecall : 0;
		const limitSparseTreeGrep =
			this.settings.enabled && this.settings.sparseTreeGrep ? this.settings.sparseTreeGrepMaxRecall : 0;
		const limitConcepts = this.settings.enabled ? this.settings.conceptMaxRecall : 0;
		let {
			reflections: recalls,
			skills: skillRecalls,
			understandings: understandingRecalls,
			codeGraphs: codeGraphRecalls,
			flowGraphs: flowGraphRecalls,
			knowledge: knowledgeGraphRecalls,
			sparseTreeGrep: sparseTreeGrepRecalls,
			concepts: conceptRecalls,
		} = await this.context.recall({
			keywords: recallKeywords,
			taskKind: classification.kind,
			limitReflections,
			limitSkills,
			limitUnderstandings,
			limitCodeGraphs,
			limitFlowGraphs,
			limitKnowledgeGraph,
			limitSparseTreeGrep,
			limitConcepts,
		});
		let contextLedger: AxiomTaskPlan["contextLedger"];
		if (this.settings.enabled && this.settings.contextLedger) {
			const bundle: RecallBundle = {
				recalls,
				skillRecalls,
				understandingRecalls,
				codeGraphRecalls,
				flowGraphRecalls,
				knowledgeGraphRecalls,
				sparseTreeGrepRecalls,
				conceptRecalls,
			};
			contextLedger = this.contextLedger.evaluateAndRecord({
				traceId,
				taskSignature: taskSignatureFor({ text, classification, keywords: recallKeywords }),
				taskKind: classification.kind,
				keywords: recallKeywords,
				candidates: buildContextLedgerCandidates(bundle),
				maxEstimatedTokens: this.settings.contextLedgerMaxTokens,
			});
			const filtered = filterBundleByContextLedger(
				bundle,
				new Set(contextLedger.injected.map((decision) => decision.key)),
			);
			recalls = filtered.recalls;
			skillRecalls = filtered.skillRecalls;
			understandingRecalls = filtered.understandingRecalls;
			codeGraphRecalls = filtered.codeGraphRecalls;
			flowGraphRecalls = filtered.flowGraphRecalls;
			knowledgeGraphRecalls = filtered.knowledgeGraphRecalls;
			sparseTreeGrepRecalls = filtered.sparseTreeGrepRecalls;
			conceptRecalls = filtered.conceptRecalls;
			this.traceStore.record({
				type: "context_ledger",
				timestamp: new Date().toISOString(),
				traceId,
				injectedCount: contextLedger.injected.length,
				droppedCount: contextLedger.dropped.length,
				estimatedTokensInjected: contextLedger.estimatedTokensInjected,
				estimatedTokensSaved: contextLedger.estimatedTokensSaved,
				dropped: contextLedger.dropped.slice(0, 12).map((decision) => ({
					key: decision.key,
					kind: decision.kind,
					reason: decision.reason,
				})),
			});
		}

		this.traceStore.record({
			type: "reflection_recall",
			timestamp: new Date().toISOString(),
			traceId,
			recalledIds: recalls.map((r) => r.reflection.id),
			scores: recalls.map((r) => r.score),
		});
		this.traceStore.record({
			type: "skill_recall",
			timestamp: new Date().toISOString(),
			traceId,
			recalledIds: skillRecalls.map((s) => s.skill.id),
			scores: skillRecalls.map((s) => s.score),
		});

		// Confidence tracking: bump each recalled skill's recallCount immediately so
		// even if the task is abandoned before completion, the recall is recorded.
		// The session credits/debits success/failure later via recordSkillOutcome().
		if (this.settings.enabled && this.settings.skillEvolution && skillRecalls.length > 0) {
			const recalledIds = skillRecalls.map((s) => s.skill.id);
			this.context.skillStore.updateOutcome(recalledIds, "recall");
			this.traceStore.record({
				type: "skill_outcome",
				timestamp: new Date().toISOString(),
				traceId,
				outcome: "recall",
				skillIds: recalledIds,
			});
		}
		this.traceStore.record({
			type: "concept_recall",
			timestamp: new Date().toISOString(),
			traceId,
			problemClasses: conceptRecalls.map((c) => c.problemClass),
			totalReferences: conceptRecalls.map((c) => c.totalReferences),
		});
		this.traceStore.record({
			type: "code_graph_recall",
			timestamp: new Date().toISOString(),
			traceId,
			hitCount: codeGraphRecalls.length,
			graphIds: [...new Set(codeGraphRecalls.map((hit) => hit.graph.id))],
		});
		this.traceStore.record({
			type: "flow_graph_recall",
			timestamp: new Date().toISOString(),
			traceId,
			hitCount: flowGraphRecalls.length,
			graphIds: [...new Set(flowGraphRecalls.map((hit) => hit.graph.id))],
		});
		this.traceStore.record({
			type: "knowledge_graph_recall",
			timestamp: new Date().toISOString(),
			traceId,
			hitCount: knowledgeGraphRecalls.length,
			nodeCount: knowledgeGraphRecalls.reduce((sum, hit) => sum + hit.nodes.length, 0),
			edgeCount: knowledgeGraphRecalls.reduce((sum, hit) => sum + hit.edges.length, 0),
		});
		this.traceStore.record({
			type: "sparse_tree_grep_recall",
			timestamp: new Date().toISOString(),
			traceId,
			hitCount: sparseTreeGrepRecalls.length,
			documentIds: [...new Set(sparseTreeGrepRecalls.map((hit) => hit.documentId))],
		});

		// Step 3: reasoning graph. Rigorous mode can run rStar-lite first
		// (small MCTS/GoT search); otherwise fall back to the cheaper one-call
		// ToT + AGoT planner. Cheaper task kinds keep the flat-prompt path.
		let graph: AxiomReasoningGraph | undefined;
		const shouldPlanGraph =
			this.settings.enabled &&
			this.settings.reasoningGraph &&
			classification.complexity >= this.settings.reasoningGraphMinComplexity &&
			!!model &&
			!!auth;
		if (shouldPlanGraph && model && auth) {
			const plannerTimeoutMs = options.graphPlannerTimeoutMs ?? 12000;
			const availableTools = options.availableTools ?? [];
			if (this.settings.rStarSearch) {
				graph =
					(await this.rstarPlanner.plan({
						text,
						classification,
						abstraction,
						availableTools,
						llm: {
							model,
							apiKey: auth.apiKey,
							headers: auth.headers,
							timeoutMs: plannerTimeoutMs,
							candidateCount: this.settings.totCandidates,
							rollouts: this.settings.rStarRollouts,
							maxDepth: this.settings.rStarMaxDepth,
							exploration: this.settings.rStarExploration,
						},
					})) ?? undefined;
			}
			graph ??= await this.graphPlanner.plan({
				text,
				classification,
				abstraction,
				availableTools,
				llm: {
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					timeoutMs: plannerTimeoutMs,
					candidateCount: this.settings.totCandidates,
				},
			});
			const planned = graph;
			const chosenCandidate = planned.candidates.find((c) => c.id === planned.chosenId);
			this.traceStore.record({
				type: "reasoning_graph",
				timestamp: new Date().toISOString(),
				traceId,
				source: planned.source,
				candidateCount: planned.candidates.length,
				chosenId: planned.chosenId,
				chosenScore: chosenCandidate?.combinedScore ?? chosenCandidate?.meanValue ?? chosenCandidate?.score,
				chosenOverridden: planned.chosenOverridden,
				nodeCount: planned.nodes.length,
				latencyMs: planned.latencyMs,
			});

			// Step 3b: independent critic re-scores candidates on different axes.
			// Only fires when the graph came from the LLM (not the single-node
			// fallback) and there's more than one candidate to choose between.
			if (
				this.settings.reasoningCritic &&
				planned.source === "llm" &&
				planned.candidates.length > 1 &&
				model &&
				auth
			) {
				const criticStartedAt = Date.now();
				const scores = await this.critic.score({
					task: text,
					candidates: planned.candidates,
					llm: {
						model,
						apiKey: auth.apiKey,
						headers: auth.headers,
						timeoutMs: options.criticTimeoutMs ?? 10000,
					},
				});
				if (scores.size > 0) {
					for (const candidate of planned.candidates) {
						const s = scores.get(candidate.id);
						if (!s) continue;
						candidate.criticCost = s.cost;
						candidate.criticCoverage = s.coverage;
						candidate.criticUndoability = s.undoability;
						candidate.criticScore = s.score;
						candidate.criticRationale = s.rationale;
						candidate.combinedScore =
							typeof candidate.score === "number" && typeof candidate.criticScore === "number"
								? candidate.score + candidate.criticScore
								: (candidate.score ?? candidate.criticScore);
					}

					const eligible = planned.candidates.filter((c) => typeof c.combinedScore === "number");
					if (eligible.length > 1) {
						const winner = eligible.reduce((best, current) =>
							(current.combinedScore ?? -Infinity) > (best.combinedScore ?? -Infinity) ? current : best,
						);
						if (winner.id !== planned.chosenId) {
							const priorChosen = planned.chosenId;
							planned.chosenId = winner.id;
							planned.chosenReason = `Critic-revised pick — combined score ${winner.combinedScore} beat prior choice "${priorChosen}".`;
							planned.chosenOverridden = true;
						}
					}
				}

				this.traceStore.record({
					type: "reasoning_critic",
					timestamp: new Date().toISOString(),
					traceId,
					scoredCount: scores.size,
					chosenId: planned.chosenId,
					chosenOverridden: !!planned.chosenOverridden,
					latencyMs: Date.now() - criticStartedAt,
				});
			}
		}

		// Step 4: ASCoT depth + hints
		const ascot = this.ascot.plan({
			classification,
			abstraction,
			recalls,
			enabled: this.settings.enabled && this.settings.ascotDepth,
			availableTools: options.availableTools,
		});

		this.traceStore.record({
			type: "ascot_plan",
			timestamp: new Date().toISOString(),
			traceId,
			complexity: classification.complexity,
			thinkingLevel: ascot.thinkingLevel,
			strategyHintCount: ascot.strategyHints.length,
		});

		const benchmarkProtocol =
			this.settings.enabled && this.settings.benchmarkMode
				? this.benchmarkProtocol.plan({ classification, availableTools: options.availableTools ?? [] })
				: undefined;
		if (benchmarkProtocol) {
			this.traceStore.record({
				type: "benchmark_protocol",
				timestamp: new Date().toISOString(),
				traceId,
				directiveCount: benchmarkProtocol.directives.length,
				toolSequenceCount: benchmarkProtocol.toolSequence.length,
			});
		}

		// Step 5: auto-retrieval task primer (Aider-style repo-map). Runs only
		// when enabled and degrades silently on any error — the rest of the
		// plan is unaffected if ripgrep is missing / cwd is weird / etc.
		let primer: AxiomTaskPrimer | undefined;
		if (this.settings.enabled && this.settings.autoRetrieval) {
			try {
				if (!this.codeSymbolIndex) {
					this.codeSymbolIndex = new CodeSymbolIndex({ cwd: this.cwd });
				}
				const result = await this.taskPrimer.prime({
					cwd: this.cwd,
					prompt: text,
					keywords: recallKeywords,
					codeGraphs: this.context.codeGraphStore,
					flowGraphs: this.context.flowGraphStore,
					sparseTreeGrep: this.context.sparseTreeGrepStore,
					symbolIndex: this.codeSymbolIndex,
				});
				if (
					result.bugLens.length > 0 ||
					result.extractedSymbols.length > 0 ||
					result.fileHits.length > 0 ||
					result.symbolWalks.length > 0 ||
					result.fileStructures.length > 0 ||
					result.flowSlices.length > 0 ||
					result.documentHits.length > 0
				) {
					primer = result;
				}
				this.traceStore.record({
					type: "task_primer",
					timestamp: new Date().toISOString(),
					traceId,
					extractedSymbolCount: result.extractedSymbols.length,
					bugLensCount: result.bugLens.length,
					fileHitCount: result.fileHits.length,
					symbolWalkCount: result.symbolWalks.length,
					fileStructureCount: result.fileStructures.length,
					flowSliceCount: result.flowSlices.length,
					documentHitCount: result.documentHits.length,
					briefTokens: result.briefTokens,
					durationMs: result.durationMs,
				});
			} catch {
				// Best-effort — fall through with no primer attached.
			}
		}

		return {
			abstraction,
			recalls,
			skillRecalls,
			understandingRecalls,
			codeGraphRecalls,
			flowGraphRecalls,
			knowledgeGraphRecalls,
			sparseTreeGrepRecalls,
			conceptRecalls,
			contextLedger,
			benchmarkProtocol,
			graph,
			ascot,
			primer,
		};
	}

	/**
	 * Format the AXIOM context block that gets appended to the system prompt for
	 * the upcoming turn. Returns an empty string when nothing to inject.
	 */
	buildSystemPromptAppend(plan: AxiomTaskPlan): string {
		const sections: string[] = [];

		// Codebase fingerprint: per-repo style profile. Shares the autoRetrieval
		// gate because both are pre-task context injection. Deterministic build,
		// disk-cached, hard-capped at ~280 chars. Skipped when string is empty
		// (no code files sampled, or rebuild failed).
		if (this.settings.enabled && this.settings.autoRetrieval) {
			if (!this.codebaseFingerprint) {
				this.codebaseFingerprint = new CodebaseFingerprint({ cwd: this.cwd });
			}
			const brief = this.codebaseFingerprint.renderForPrompt();
			if (brief) {
				sections.push(brief);
				sections.push("");
			}
		}

		if (plan.ascot.strategyHints.length > 0) {
			sections.push("# AXIOM Strategy");
			sections.push("");
			for (const hint of plan.ascot.strategyHints) {
				sections.push(`- ${hint}`);
			}
			sections.push("");
		}

		if (plan.benchmarkProtocol) {
			sections.push("# AXIOM BenchmarkMode");
			sections.push("");
			sections.push(
				"Gemma is the base model; AXIOM must supply benchmark discipline. Follow this protocol for coding/terminal-bench-style tasks.",
			);
			sections.push("");
			for (const directive of plan.benchmarkProtocol.directives) {
				sections.push(`- ${directive}`);
			}
			if (plan.benchmarkProtocol.toolSequence.length > 0) {
				sections.push("");
				sections.push("Tool sequence:");
				for (const tool of plan.benchmarkProtocol.toolSequence) {
					sections.push(`- ${tool}`);
				}
			}
			sections.push("");
			sections.push("Verifier policy:");
			for (const rule of plan.benchmarkProtocol.verifierPolicy) {
				sections.push(`- ${rule}`);
			}
			sections.push("");
			sections.push("Stop rules:");
			for (const rule of plan.benchmarkProtocol.stopRules) {
				sections.push(`- ${rule}`);
			}
			sections.push("");
		}

		if (plan.abstraction.problemClass.length > 0 || plan.abstraction.domain !== "general") {
			sections.push("# AXIOM Task Framing");
			sections.push("");
			if (plan.abstraction.domain !== "general") {
				sections.push(`- Domain: ${plan.abstraction.domain}`);
			}
			if (plan.abstraction.problemClass.length > 0) {
				sections.push(`- Underlying problem class: ${plan.abstraction.problemClass.join(", ")}`);
			}
			sections.push("");
		}

		if (plan.recalls.length > 0) {
			sections.push("# Past lessons (Reflexion)");
			sections.push("");
			sections.push("Apply these lessons from past similar tasks. Do not repeat these failure modes.");
			sections.push("");
			for (const hit of plan.recalls) {
				const r = hit.reflection;
				sections.push(`- **Failure (${r.failureType}):** ${snippet(r.cause, 200)}`);
				sections.push(`  **Correction:** ${snippet(r.correction, 200)}`);
			}
			sections.push("");
		}

		if (plan.skillRecalls.length > 0) {
			sections.push("# Past successes (Skills)");
			sections.push("");
			sections.push(
				"Similar tasks have previously been solved with the approaches below. Consider re-using these tool sequences as a starting point — but adapt to the current task; do not blindly follow.",
			);
			sections.push("");
			for (const hit of plan.skillRecalls) {
				const s = hit.skill;
				const tools = s.toolsUsed.length > 0 ? s.toolsUsed.join(" → ") : "(no tools)";
				const successes = s.successCount ?? 0;
				const failures = s.failureCount ?? 0;
				const recalls = s.recallCount ?? 0;
				const confidenceTag =
					recalls > 0
						? ` — ${successes}✓/${failures}✗ across ${recalls} prior recall(s)`
						: " — first recall, no track record yet";
				sections.push(
					`- **${s.title}** (${s.taskKind}/${s.domain}, ${s.stepCount} step${s.stepCount === 1 ? "" : "s"})${confidenceTag}`,
				);
				sections.push(`  Tools: ${tools}`);
			}
			sections.push("");
		}

		if (plan.conceptRecalls.length > 0) {
			sections.push("# Related concepts (Context Agent)");
			sections.push("");
			sections.push(
				"AXIOM has seen these problem classes before. Treat these counts as a familiarity signal, not a directive.",
			);
			sections.push("");
			for (const c of plan.conceptRecalls) {
				const parts: string[] = [];
				if (c.reflectionIds.length > 0) parts.push(`${c.reflectionIds.length} reflection(s)`);
				if (c.skillIds.length > 0) parts.push(`${c.skillIds.length} skill(s)`);
				const addresses = c.edges.filter((e) => e.type === "addresses").length;
				if (addresses > 0) parts.push(`${addresses} skill→failure link(s)`);
				sections.push(`- **${c.problemClass}** — ${parts.join(", ")}, last seen ${c.lastSeen}`);
			}
			sections.push("");
		}

		if (plan.understandingRecalls.length > 0) {
			sections.push("# Related code understandings (Context Agent)");
			sections.push("");
			sections.push(
				"These are previously captured structured file/symbol summaries. Use them to choose what to inspect next; do not assume they are current if files may have changed.",
			);
			sections.push("");
			for (const hit of plan.understandingRecalls) {
				const u = hit.understanding;
				sections.push(`- **${u.rootPath}** — ${u.fileCount} file(s), matched: ${hit.matchedKeywords.join(", ")}`);
				for (const file of u.files.slice(0, 4)) {
					const symbols = file.symbols
						.slice(0, 6)
						.map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`)
						.join(", ");
					sections.push(`  - ${file.path}${symbols ? ` (${symbols})` : ""}`);
				}
			}
			sections.push("");
		}

		if (plan.codeGraphRecalls.length > 0) {
			sections.push("# Code graph (Context Agent)");
			sections.push("");
			sections.push(
				"Graphify-style codebase relationship hits from prior code_graph indexing. Use code_graph search/neighbors/path when exact relationships matter, and read files before editing.",
			);
			sections.push("");
			for (const hit of plan.codeGraphRecalls) {
				const primary = hit.nodes[0];
				sections.push(
					`- **${hit.graph.rootPath}** (${hit.graph.fileCount} file(s)) matched: ${hit.matchedKeywords.join(", ")}${primary ? `; primary: ${primary.label} [${primary.kind}]` : ""}`,
				);
				for (const edge of hit.edges.slice(0, 4)) {
					const from =
						hit.nodes.find((node) => node.id === edge.fromId) ??
						hit.graph.nodes.find((node) => node.id === edge.fromId);
					const to =
						hit.nodes.find((node) => node.id === edge.toId) ??
						hit.graph.nodes.find((node) => node.id === edge.toId);
					sections.push(`  - ${from?.label ?? edge.fromId} --${edge.kind}--> ${to?.label ?? edge.toId}`);
				}
			}
			sections.push("");
		}

		if (plan.flowGraphRecalls.length > 0) {
			sections.push("# Flow graph (Context Agent)");
			sections.push("");
			sections.push(
				"Static/runtime flow hits from prior flow_graph analysis. Use flow_graph path/data/effects/explain/debug when behavior, data movement, effects, events, or failures matter.",
			);
			sections.push("");
			for (const hit of plan.flowGraphRecalls) {
				const primary = hit.nodes[0];
				sections.push(
					`- **${hit.graph.rootPath}** (${hit.graph.fileCount} file(s)) matched: ${hit.matchedKeywords.join(", ")}${primary ? `; primary: ${primary.label} [${primary.kind}]` : ""}`,
				);
				for (const edge of hit.edges.slice(0, 5)) {
					const from =
						hit.nodes.find((node) => node.id === edge.fromId) ??
						hit.graph.nodes.find((node) => node.id === edge.fromId);
					const to =
						hit.nodes.find((node) => node.id === edge.toId) ??
						hit.graph.nodes.find((node) => node.id === edge.toId);
					sections.push(`  - ${from?.label ?? edge.fromId} --${edge.kind}--> ${to?.label ?? edge.toId}`);
				}
			}
			sections.push("");
		}

		if (plan.knowledgeGraphRecalls.length > 0) {
			sections.push("# Knowledge graph (Context Agent)");
			sections.push("");
			sections.push(
				"Durable non-code knowledge from prior sessions. Prefer user-stated/extracted edges over inferred or ambiguous edges.",
			);
			sections.push("");
			for (const hit of plan.knowledgeGraphRecalls) {
				for (const edge of hit.edges.slice(0, 4)) {
					const from = hit.nodes.find((node) => node.id === edge.fromId);
					const to = hit.nodes.find((node) => node.id === edge.toId);
					sections.push(
						`- ${from?.label ?? edge.fromId} --${edge.relation}--> ${to?.label ?? edge.toId} (${edge.status}, confidence ${edge.confidence})`,
					);
					if (edge.evidence) {
						sections.push(`  Evidence: ${snippet(edge.evidence, 180)}`);
					}
				}
			}
			sections.push("");
		}

		if (plan.sparseTreeGrepRecalls.length > 0) {
			sections.push("# SparseTreeGrep document hits");
			sections.push("");
			sections.push(
				"Expandable non-code document index hits. Use sparse_tree_grep extract with documentId/chunkId when exact source text is needed.",
			);
			sections.push("");
			for (const hit of plan.sparseTreeGrepRecalls) {
				sections.push(
					`- **${hit.documentName}** ${hit.chunkId}${hit.nodeLabel ? ` (${hit.nodeLabel})` : ""} page ${hit.page}, bytes ${hit.byteStart}-${hit.byteEnd}, matched: ${hit.matchedKeywords.join(", ")}`,
				);
				sections.push(`  ${snippet(hit.chunkSummary, 220)}`);
			}
			sections.push("");
		}

		if (plan.graph && plan.graph.nodes.length > 1) {
			sections.push(
				plan.graph.source === "rstar"
					? "# Recursive Execution Plan (rStar-lite)"
					: "# Recursive Execution Plan (AGoT)",
			);
			sections.push("");
			if (plan.graph.search) {
				sections.push(
					`rStar-lite explored ${plan.graph.search.expandedNodes} node(s) across ${plan.graph.search.rollouts} rollout(s), max depth ${plan.graph.search.maxDepth}, exploration ${plan.graph.search.exploration}.`,
				);
				sections.push("");
			}
			if (plan.graph.candidates.length > 1) {
				const chosen = plan.graph.candidates.find((c) => c.id === plan.graph?.chosenId);
				const overrideNote = plan.graph.chosenOverridden ? " (score-override)" : "";
				const selfPart =
					chosen && typeof chosen.score === "number"
						? ` [self ${chosen.score}: feasibility ${chosen.feasibility}, completeness ${chosen.completeness}, risk ${chosen.risk}]`
						: "";
				const searchPart =
					chosen && typeof chosen.meanValue === "number"
						? ` [search mean ${chosen.meanValue}, visits ${chosen.visits ?? 0}]`
						: "";
				const criticPart =
					chosen && typeof chosen.criticScore === "number"
						? ` [critic ${chosen.criticScore}: cost ${chosen.criticCost}, coverage ${chosen.criticCoverage}, undoability ${chosen.criticUndoability}]`
						: "";
				const combinedPart =
					chosen && typeof chosen.combinedScore === "number" ? ` → combined ${chosen.combinedScore}` : "";
				sections.push(
					`Of ${plan.graph.candidates.length} candidate approach(es), AXIOM picked **${plan.graph.chosenId}**${overrideNote}${selfPart}${searchPart}${criticPart}${combinedPart}: ${plan.graph.chosenReason}`,
				);
				if (chosen?.criticRationale) {
					sections.push(`  Critic: ${chosen.criticRationale}`);
				}
				const rivals = plan.graph.candidates
					.filter((c) => c.id !== plan.graph?.chosenId && typeof c.score === "number")
					.sort((a, b) => (b.combinedScore ?? b.score ?? 0) - (a.combinedScore ?? a.score ?? 0));
				if (rivals.length > 0) {
					sections.push("");
					sections.push("Alternatives considered:");
					for (const r of rivals) {
						const rivalScore = typeof r.combinedScore === "number" ? r.combinedScore : r.score;
						const label =
							typeof r.combinedScore === "number"
								? "combined"
								: typeof r.meanValue === "number"
									? "search"
									: "self";
						const displayedScore =
							typeof r.meanValue === "number" && label === "search" ? r.meanValue : rivalScore;
						sections.push(`- **${r.id}** [${label} ${displayedScore}]: ${r.summary}`);
					}
				}
				sections.push("");
			}
			sections.push(
				"Execute the recursive task tree below in dependency order. Non-atomic nodes are planning/grouping nodes; atomic leaf nodes are the concrete actions to execute. Do not skip directly from a broad node to implementation if it has children.",
			);
			sections.push(
				"AXIOM may append <axiom_graph_execution> status blocks to tool results. Use those blocks to adapt the next subgoal without restarting the whole plan.",
			);
			sections.push("");
			sections.push(...renderReasoningGraphTree(plan.graph));
			sections.push("");
		}

		// Auto-retrieval brief: rendered last so the agent reads it right
		// before its first turn. Hard token cap defends the system prompt.
		if (plan.primer) {
			const brief = renderTaskPrimerBrief(plan.primer, 500);
			if (brief) {
				sections.push(brief);
				sections.push("");
			}
		}

		return sections.join("\n").trim();
	}

	/**
	 * Persist a successful task pattern as a skill. Caller is responsible for
	 * deciding whether this task qualifies (uses tools, complexity, no IP
	 * retries, etc.) — this method only filters by the global enabled flag.
	 * Returns the saved skill id when successful, undefined otherwise.
	 */
	captureSkill(options: {
		traceId: string | undefined;
		taskText: string;
		taskKind: AxiomTaskKind;
		abstraction: AxiomAbstraction;
		complexity: number;
		toolsUsed: string[];
		stepCount: number;
	}): string | undefined {
		if (!this.settings.enabled || !this.settings.skillEvolution) {
			return undefined;
		}
		const skill: AxiomSkill = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			taskKind: options.taskKind,
			domain: options.abstraction.domain,
			problemClass: options.abstraction.problemClass,
			keywords: options.abstraction.keywords,
			toolsUsed: options.toolsUsed,
			stepCount: options.stepCount,
			complexity: options.complexity,
			title: buildSkillTitle(options),
			taskSnippet: snippet(options.taskText, 320),
			sourceTraceId: options.traceId,
		};
		const ok = this.context.skillStore.save(skill);
		if (!ok) return undefined;
		// Edge persistence: link this skill to existing reflections that share a
		// problem class. Best-effort — the skill is already on disk, edge failure
		// is non-fatal. See ContextAgent.linkSkillToReflections.
		try {
			this.context.linkSkillToReflections(skill);
		} catch {
			// ignored — edges are a derived signal, not load-bearing
		}
		this.traceStore.record({
			type: "skill_capture",
			timestamp: new Date().toISOString(),
			traceId: options.traceId ?? skill.id,
			skillId: skill.id,
			toolsUsed: skill.toolsUsed,
			stepCount: skill.stepCount,
			complexity: skill.complexity,
		});
		return skill.id;
	}

	/**
	 * Persist a failure reflection so future similar tasks can avoid the same
	 * mistake. Safe to call even when reflexion is disabled (becomes a no-op).
	 * Returns the saved reflection id when successful, undefined otherwise.
	 */
	captureFailure(options: {
		traceId: string | undefined;
		taskText: string;
		taskKind: AxiomTaskKind;
		abstraction: AxiomAbstraction;
		failureType: string;
		failureCodes: string[];
		cause: string;
		correction: string;
	}): string | undefined {
		if (!this.settings.enabled || !this.settings.reflexion) {
			return undefined;
		}
		const reflection: AxiomReflection = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			taskKind: options.taskKind,
			domain: options.abstraction.domain,
			problemClass: options.abstraction.problemClass,
			keywords: options.abstraction.keywords,
			failureType: options.failureType,
			failureCodes: options.failureCodes,
			taskSnippet: snippet(options.taskText, 320),
			cause: options.cause,
			correction: options.correction,
			sourceTraceId: options.traceId,
		};
		const ok = this.context.reflexionStore.save(reflection);
		if (!ok) return undefined;
		// Edge persistence: wire this reflection to existing skills that share a
		// problem class. Those skills are candidate corrections for the failure
		// just recorded. Best-effort — see captureSkill for the same rationale.
		try {
			this.context.linkReflectionToSkills(reflection);
		} catch {
			// ignored — derived signal, not load-bearing
		}
		this.traceStore.record({
			type: "reflection_capture",
			timestamp: new Date().toISOString(),
			traceId: options.traceId ?? reflection.id,
			reflectionId: reflection.id,
			failureType: reflection.failureType,
			failureCodes: reflection.failureCodes,
		});
		return reflection.id;
	}

	startTrace(options: {
		traceId: string;
		sessionId: string;
		cwd: string;
		input: string;
		classification: AxiomTaskClassification;
		model?: AxiomTraceModelSnapshot;
	}): void {
		this.traceStore.start(options);
	}

	recordAgentEvent(traceId: string | undefined, event: AgentEvent): void {
		if (!traceId) {
			return;
		}

		this.traceStore.record({
			type: "agent_event",
			timestamp: new Date().toISOString(),
			traceId,
			event: { type: event.type },
		});
	}

	recordMessageEnd(
		traceId: string | undefined,
		message: AssistantMessage,
		validation: AxiomIPValidationResult | undefined,
	): void {
		if (!traceId) {
			return;
		}

		const stats = textAndThinkingStats(message);
		const summary: AxiomTraceMessageSummary = {
			role: message.role,
			stopReason: message.stopReason,
			provider: message.provider,
			model: message.model,
			...stats,
			usage: message.usage,
			validation,
		};

		this.traceStore.record({
			type: "message_end",
			timestamp: new Date().toISOString(),
			traceId,
			message: summary,
		});
	}

	recordLocalFastPath(traceId: string, reply: string, latencyMs: number): void {
		this.traceStore.record({
			type: "local_fast_path",
			timestamp: new Date().toISOString(),
			traceId,
			replyChars: reply.length,
			latencyMs,
		});
	}

	recordIPRetry(
		traceId: string | undefined,
		attempt: number,
		maxAttempts: number,
		issues: AxiomIPIssue[],
		feedbackChars: number,
	): void {
		if (!traceId) {
			return;
		}
		this.traceStore.record({
			type: "ip_retry",
			timestamp: new Date().toISOString(),
			traceId,
			attempt,
			maxAttempts,
			issues,
			feedbackChars,
		});
	}

	recordStreamCheck(traceId: string | undefined, result: StreamingChunkCheckResult): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "ip_stream_check",
			timestamp: new Date().toISOString(),
			traceId,
			language: result.resolvedLanguage,
			ok: result.ok,
			latencyMs: result.latencyMs,
			line: result.line,
			column: result.column,
		});
	}

	recordStreamAbort(
		traceId: string | undefined,
		language: string,
		abortIndex: number,
		location?: { line?: number; column?: number },
	): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "ip_stream_abort",
			timestamp: new Date().toISOString(),
			traceId,
			language,
			line: location?.line,
			column: location?.column,
			abortIndex,
		});
	}

	/**
	 * Build the hidden retry message that gets injected after a stream abort.
	 * Wrapped in the same sentinel as post-message IP retries so the chat UI
	 * filters it out automatically.
	 */
	buildStreamAbortFeedback(result: StreamingChunkCheckResult): string {
		const loc =
			result.line !== undefined
				? result.column !== undefined
					? `line ${result.line}, column ${result.column}`
					: `line ${result.line}`
				: "(unknown location)";
		const fix = result.fixHint ?? "Re-emit the block without the syntax error.";
		const detail = result.message ?? "Syntax check failed.";
		return [
			AXIOM_IP_RETRY_TAG,
			`Your previous response was aborted by AXIOM's streaming syntax check. A ${result.resolvedLanguage} code block failed to parse.`,
			"",
			`- Location: ${loc}`,
			`- Error: ${detail}`,
			`- Fix: ${fix}`,
			"",
			"Re-answer the original user request. Keep everything that was correct in your aborted reply, but emit a CORRECT version of the failed code block. Do not apologize.",
			AXIOM_IP_RETRY_END_TAG,
		].join("\n");
	}

	recordGraphNodeUpdate(
		traceId: string | undefined,
		update: AxiomGraphExecutionUpdate,
		snapshot: AxiomGraphExecutionSnapshot,
	): void {
		if (!traceId) {
			return;
		}
		this.traceStore.record({
			type: "graph_node_update",
			timestamp: new Date().toISOString(),
			traceId,
			update,
			snapshot,
		});
	}

	/**
	 * Credit (success) or debit (failure) a batch of recalled skill ids. Called
	 * by the session at task end. No-op when skill evolution is disabled or the
	 * list is empty. Updates both the on-disk index and the in-process cache.
	 */
	recordSkillOutcome(traceId: string | undefined, outcome: AxiomSkillOutcome, skillIds: readonly string[]): void {
		if (!this.settings.enabled || !this.settings.skillEvolution) return;
		if (skillIds.length === 0) return;
		this.context.skillStore.updateOutcome(skillIds, outcome);
		if (!traceId) return;
		this.traceStore.record({
			type: "skill_outcome",
			timestamp: new Date().toISOString(),
			traceId,
			outcome,
			skillIds: [...skillIds],
		});
	}

	recordContextLedgerOutcome(traceId: string | undefined, outcome: AxiomContextLedgerOutcome): void {
		if (!this.settings.enabled || !this.settings.contextLedger) return;
		const itemCount = this.contextLedger.recordOutcome(traceId, outcome);
		if (!traceId || itemCount === 0) return;
		this.traceStore.record({
			type: "context_ledger_outcome",
			timestamp: new Date().toISOString(),
			traceId,
			outcome,
			itemCount,
		});
	}

	recordRepairAttempt(
		traceId: string | undefined,
		params: {
			attempt: number;
			maxAttempts: number;
			verifierCommand: string;
			verifierKind: string;
			passed: boolean;
			exitCode: number | null;
			timedOut: boolean;
			durationMs: number;
			issueCount: number;
			signature: string;
			patchRiskLevel?: string;
			patchRiskScore?: number;
			patchRiskBlocked?: boolean;
			patchRiskSignalCount?: number;
		},
	): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "repair_attempt",
			timestamp: new Date().toISOString(),
			traceId,
			...params,
		});
	}

	recordRepairExhausted(
		traceId: string | undefined,
		params: { attempts: number; reason: "max-attempts" | "repeat" | "growth"; signature: string },
	): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "repair_exhausted",
			timestamp: new Date().toISOString(),
			traceId,
			...params,
		});
	}

	recordBestOfNCandidate(
		traceId: string | undefined,
		params: {
			candidateId: string;
			rolloutIndex: number;
			attemptIndex: number;
			passed: boolean;
			issueCount: number;
			changedFileCount: number;
			signature: string;
			skillConfidence?: number;
			durationMs: number;
		},
	): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "bestof_candidate",
			timestamp: new Date().toISOString(),
			traceId,
			...params,
		});
	}

	recordBestOfNWinner(
		traceId: string | undefined,
		params: {
			winnerId: string;
			totalCandidates: number;
			regressionDetected: boolean;
			reason: string;
			passed: boolean;
			issueCount: number;
		},
	): void {
		if (!traceId) return;
		this.traceStore.record({
			type: "bestof_winner",
			timestamp: new Date().toISOString(),
			traceId,
			...params,
		});
	}

	recordGraphExecutionSummary(traceId: string | undefined, snapshot: AxiomGraphExecutionSnapshot): void {
		if (!traceId) {
			return;
		}
		this.traceStore.record({
			type: "graph_execution_summary",
			timestamp: new Date().toISOString(),
			traceId,
			snapshot,
		});
	}

	finishTrace(traceId: string | undefined, startedAt: number, outcome: "completed" | "error"): void {
		if (!traceId) {
			return;
		}

		this.traceStore.record({
			type: "task_end",
			timestamp: new Date().toISOString(),
			traceId,
			latencyMs: Date.now() - startedAt,
			outcome,
		});
	}

	validateAssistantMessage(options: {
		userText: string;
		classification: AxiomTaskClassification;
		message: AssistantMessage;
	}): AxiomIPValidationResult | undefined {
		if (!this.settings.enabled || !this.settings.ipValidation) {
			return undefined;
		}
		return this.validator.validateAssistantMessage(options);
	}
}
