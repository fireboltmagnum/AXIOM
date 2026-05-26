import type { AgentEvent } from "@axiom/agent-core";
import type { AssistantMessage, Model, StopReason, Usage } from "@axiom/ai";

export type AxiomTaskRoute = "local" | "direct" | "agent";
export type AxiomTaskKind =
	| "greeting"
	| "gratitude"
	| "identity"
	| "status"
	| "coding"
	| "question"
	| "command"
	| "general";
export type AxiomValidationStatus = "passed" | "warning" | "failed";

export interface AxiomRuntimeSettings {
	effort: string;
	enabled: boolean;
	difficultyRouter: boolean;
	fastPath: boolean;
	trace: boolean;
	ipValidation: boolean;
	ipMaxRetries: number;
	/**
	 * Streaming code-chunk validator. Watches each fenced code block as it
	 * closes and runs a language-specific syntax check. On failure the runtime
	 * aborts the stream and injects a hidden retry message pointing at the
	 * broken block by (line, column).
	 */
	ipStreaming: boolean;
	/** Per-chunk hard timeout in ms. Total budget for one chunk check. */
	ipStreamingTimeoutMs: number;
	/** Max stream-aborts allowed per task. After this, streaming validation goes silent. */
	ipStreamingMaxAbortsPerTask: number;
	reflexion: boolean;
	stepBack: boolean;
	ascotDepth: boolean;
	/** Complexity threshold (0-100) above which Step-Back fires. Below this, abstraction is keyword-only. */
	stepBackMinComplexity: number;
	/** Soft cap on how many past reflections to inject per task. */
	reflexionMaxRecall: number;
	/** Auto-capture successful task patterns into a skill library, recall on similar tasks. */
	skillEvolution: boolean;
	/** Soft cap on how many past skills to inject per task. */
	skillMaxRecall: number;
	/** Capture only tasks with complexity >= this threshold. Avoids skill explosion on trivia. */
	skillMinComplexity: number;
	/** Enable structured code-understanding tool and recall. */
	codeUnderstanding: boolean;
	/** Soft cap on remembered code-understanding snapshots injected per task. */
	codeUnderstandingMaxRecall: number;
	/** Enable Graphify-style codebase graph tool and recall. */
	codeGraph: boolean;
	/** Soft cap on remembered code graph hits injected per task. */
	codeGraphMaxRecall: number;
	/** Enable static/runtime flow graph tool and recall. */
	flowGraph: boolean;
	/** Soft cap on remembered flow graph hits injected per task. */
	flowGraphMaxRecall: number;
	/** Enable durable non-code knowledge graph tool and recall. */
	knowledgeGraph: boolean;
	/** Soft cap on remembered graph facts injected per task. */
	knowledgeGraphMaxRecall: number;
	/** Enable SparseTreeGrep expandable document index and recall. */
	sparseTreeGrep: boolean;
	/** Soft cap on SparseTreeGrep hits injected per task. */
	sparseTreeGrepMaxRecall: number;
	/** Enable automatic verifier/repair feedback after code edits. */
	repairLoop: boolean;
	/** Max failed verifier packets injected per task. */
	repairLoopMaxAttempts: number;
	/** Hard timeout in ms for each RepairLoop verifier command. */
	repairLoopTimeoutMs: number;
	/** Enable Playwright browser CLI tool for UI tests, screenshots, traces, and reports. */
	playwrightCli: boolean;
	/**
	 * Reasoning graph (combined ToT + AGoT): one LLM call to sketch N candidate
	 * approaches, pick the winner, and decompose it into a subgoal graph. The graph
	 * is rendered into the system prompt as a numbered plan. Falls back silently
	 * on LLM error.
	 */
	reasoningGraph: boolean;
	/** Complexity threshold above which the reasoning graph LLM call fires. */
	reasoningGraphMinComplexity: number;
	/** Number of candidate approaches asked of the planner LLM. 2-4 is sensible. */
	totCandidates: number;
	/**
	 * Independent critic pass over the ToT candidates. Adds one extra LLM call
	 * per planning round but catches inflated self-scores by re-scoring on
	 * different axes (cost/coverage/undoability). Off by default; rigorous
	 * profile turns it on.
	 */
	reasoningCritic: boolean;
	/**
	 * rStar-lite planner: API-backed MCTS/GoT search over candidate approaches.
	 * Rigorous mode uses this before falling back to the cheaper one-call graph planner.
	 */
	rStarSearch: boolean;
	/** Number of rStar rollout expansions. Kept low because each expansion is one LLM call. */
	rStarRollouts: number;
	/** Max search depth for rStar tree expansion. */
	rStarMaxDepth: number;
	/** UCB exploration constant used during rStar selection. */
	rStarExploration: number;
	/** Soft cap on concept summaries (problem-class aggregations) injected per task. */
	conceptMaxRecall: number;
}

export interface AxiomClassifyInput {
	text: string;
	hasImages: boolean;
	hasPendingContext: boolean;
	activeToolNames: string[];
}

export interface AxiomTaskClassification {
	id: string;
	kind: AxiomTaskKind;
	route: AxiomTaskRoute;
	complexity: number;
	confidence: number;
	fastPathReply?: string;
	reasons: string[];
}

export interface AxiomTraceModelSnapshot {
	provider: string;
	model: string;
	api: string;
	thinkingLevel: string;
}

export interface AxiomTraceStart {
	traceId: string;
	sessionId: string;
	cwd: string;
	input: string;
	classification: AxiomTaskClassification;
	model?: AxiomTraceModelSnapshot;
	startedAt: string;
}

export type AxiomIPCategory = "shape" | "syntax" | "logic" | "leak" | "safety";

export interface AxiomIPIssue {
	code: string;
	severity: "warning" | "error";
	category: AxiomIPCategory;
	message: string;
	/** Short, agent-facing remediation hint. Used to build the retry feedback message. */
	fixHint?: string;
	/** Optional snippet of offending text, for the agent to see what tripped the check. */
	evidence?: string;
}

export interface AxiomIPValidationResult {
	status: AxiomValidationStatus;
	checks: string[];
	issues: AxiomIPIssue[];
	latencyMs: number;
	/**
	 * Pre-formatted feedback message to send back to the agent when status === "failed".
	 * Undefined when validation passed or only produced warnings.
	 */
	agentFeedback?: string;
}

export interface AxiomTraceMessageSummary {
	role: string;
	stopReason?: StopReason;
	provider?: string;
	model?: string;
	textChars: number;
	thinkingChars: number;
	toolCallCount: number;
	usage?: Usage;
	validation?: AxiomIPValidationResult;
}

export interface AxiomIPRetryRecord {
	attempt: number;
	maxAttempts: number;
	issues: AxiomIPIssue[];
	feedbackChars: number;
}

/**
 * Output of Step-Back: a generalized framing of the user's task. Either produced
 * by an LLM (when stepBack is enabled and complexity threshold is met) or by a
 * cheap keyword extractor as fallback.
 */
export interface AxiomAbstraction {
	source: "llm" | "fallback";
	problemClass: string[];
	keywords: string[];
	domain: string;
	latencyMs: number;
}

/**
 * Deterministic ASCoT plan derived from classification + abstraction.
 * Drives thinking-level selection and the strategy hint injected into the system prompt.
 */
export interface AxiomASCoTPlan {
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	strategyHints: string[];
}

/** A reflection captured after a failure, retrievable by future similar tasks. */
export interface AxiomReflection {
	id: string;
	timestamp: string;
	taskKind: AxiomTaskKind;
	domain: string;
	problemClass: string[];
	keywords: string[];
	failureType: string;
	failureCodes: string[];
	taskSnippet: string;
	cause: string;
	correction: string;
	sourceTraceId?: string;
}

export interface AxiomReflectionRecallHit {
	reflection: AxiomReflection;
	score: number;
	matchedKeywords: string[];
}

/**
 * A skill auto-captured from a successful task. Mirrors the Reflexion shape but
 * for what *worked*: tool sequence, step count, problem framing. Used to nudge
 * future similar tasks toward known-good approaches.
 */
export interface AxiomSkill {
	id: string;
	timestamp: string;
	taskKind: AxiomTaskKind;
	domain: string;
	problemClass: string[];
	keywords: string[];
	toolsUsed: string[];
	stepCount: number;
	complexity: number;
	title: string;
	taskSnippet: string;
	sourceTraceId?: string;
	/** How many times this skill has been recalled into a task. Optional for backward compat with old entries. */
	recallCount?: number;
	/** Tasks that succeeded after recalling this skill. */
	successCount?: number;
	/** Tasks that failed (errored / hit IP retries) after recalling this skill. */
	failureCount?: number;
	/** ISO timestamp of the most recent recall or outcome update. */
	lastUsedAt?: string;
}

/** Outcome a session reports back about a recalled skill. */
export type AxiomSkillOutcome = "recall" | "success" | "failure";

/**
 * A single declared symbol inside a source file. Captured by AXIOM's regex-based
 * analyzer; not a full AST node — just the bits the agent typically needs to know
 * about a file ("what functions live here, what does it import").
 */
export interface AxiomSymbolEntry {
	kind: "function" | "class" | "interface" | "type" | "enum" | "const" | "method" | "trait" | "struct";
	name: string;
	line: number;
	/** First-line signature text, trimmed and truncated to ~160 chars. */
	signature?: string;
	/** True for exported / public symbols. Heuristic per language. */
	exported?: boolean;
}

/**
 * Structured understanding of a single source file. Stored on disk under
 * ~/.axiom/agent/understandings/ and surfaced by the Context Agent on future
 * tasks that touch related paths or symbols.
 */
export interface AxiomFileUnderstanding {
	path: string;
	language: string;
	lineCount: number;
	symbols: AxiomSymbolEntry[];
	imports: string[];
	exports: string[];
}

/**
 * A snapshot of one `understand_code` invocation: zero or more analyzed files
 * rooted at a single path. Indexed by `id` and `rootPath` for fast lookup.
 */
export interface AxiomCodeUnderstanding {
	id: string;
	timestamp: string;
	rootPath: string;
	fileCount: number;
	files: AxiomFileUnderstanding[];
	/** All distinct keywords across symbol names + paths, used for grep-recall. */
	keywords: string[];
}

export interface AxiomUnderstandingRecallHit {
	understanding: AxiomCodeUnderstanding;
	score: number;
	matchedKeywords: string[];
}

export type AxiomCodeGraphNodeKind = "file" | "symbol" | "module" | "external";
export type AxiomCodeGraphEdgeKind = "contains" | "imports" | "exports";

export interface AxiomCodeGraphNode {
	id: string;
	kind: AxiomCodeGraphNodeKind;
	label: string;
	path?: string;
	language?: string;
	symbolKind?: AxiomSymbolEntry["kind"];
	line?: number;
	keywords: string[];
}

export interface AxiomCodeGraphEdge {
	id: string;
	kind: AxiomCodeGraphEdgeKind;
	fromId: string;
	toId: string;
	label?: string;
	weight: number;
}

export interface AxiomCodeGraph {
	id: string;
	timestamp: string;
	rootPath: string;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	nodes: AxiomCodeGraphNode[];
	edges: AxiomCodeGraphEdge[];
	keywords: string[];
}

export interface AxiomCodeGraphHit {
	graph: AxiomCodeGraph;
	score: number;
	matchedKeywords: string[];
	nodes: AxiomCodeGraphNode[];
	edges: AxiomCodeGraphEdge[];
}

export type AxiomFlowGraphNodeKind =
	| "file"
	| "function"
	| "method"
	| "class"
	| "branch"
	| "loop"
	| "async"
	| "data"
	| "error"
	| "effect"
	| "event"
	| "external"
	| "command";

export type AxiomFlowGraphEdgeKind =
	| "contains"
	| "calls"
	| "branches"
	| "loops"
	| "awaits"
	| "uses"
	| "transforms"
	| "returns"
	| "throws"
	| "catches"
	| "reads"
	| "writes"
	| "sends"
	| "runs"
	| "mutates"
	| "emits"
	| "listens"
	| "handles"
	| "touches";

export interface AxiomFlowGraphNode {
	id: string;
	kind: AxiomFlowGraphNodeKind;
	label: string;
	path?: string;
	language?: string;
	line?: number;
	summary?: string;
	keywords: string[];
}

export interface AxiomFlowGraphEdge {
	id: string;
	kind: AxiomFlowGraphEdgeKind;
	fromId: string;
	toId: string;
	label?: string;
	line?: number;
	weight: number;
}

export interface AxiomFlowGraph {
	id: string;
	timestamp: string;
	rootPath: string;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	nodes: AxiomFlowGraphNode[];
	edges: AxiomFlowGraphEdge[];
	keywords: string[];
}

export interface AxiomFlowGraphHit {
	graph: AxiomFlowGraph;
	score: number;
	matchedKeywords: string[];
	nodes: AxiomFlowGraphNode[];
	edges: AxiomFlowGraphEdge[];
}

export interface AxiomFlowStackFrame {
	path: string;
	line?: number;
	column?: number;
	raw: string;
}

export interface AxiomFlowRuntimeTrace {
	id: string;
	timestamp: string;
	command: string;
	cwd: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
	stackFrames: AxiomFlowStackFrame[];
	correlatedNodes: AxiomFlowGraphNode[];
}

export type AxiomKnowledgeNodeKind = "entity" | "concept" | "fact" | "preference" | "source" | "task" | "unknown";
export type AxiomKnowledgeEdgeStatus = "extracted" | "inferred" | "ambiguous" | "user_stated";

export interface AxiomKnowledgeNode {
	id: string;
	label: string;
	kind: AxiomKnowledgeNodeKind;
	summary?: string;
	keywords: string[];
	createdAt: string;
	updatedAt: string;
}

export interface AxiomKnowledgeEdge {
	id: string;
	fromId: string;
	toId: string;
	relation: string;
	status: AxiomKnowledgeEdgeStatus;
	confidence: number;
	evidence?: string;
	source?: string;
	createdAt: string;
	updatedAt: string;
}

export interface AxiomKnowledgeGraphSnapshot {
	version: 1;
	updatedAt: string;
	nodes: AxiomKnowledgeNode[];
	edges: AxiomKnowledgeEdge[];
}

export interface AxiomKnowledgeGraphHit {
	score: number;
	matchedKeywords: string[];
	nodes: AxiomKnowledgeNode[];
	edges: AxiomKnowledgeEdge[];
}

export interface AxiomSparseTreeGrepChunk {
	id: string;
	chunkIndex: number;
	byteStart: number;
	byteEnd: number;
	lineStart: number;
	lineEnd: number;
	page: number;
	summary: string;
	keywords: string[];
}

export interface AxiomSparseTreeGrepNode {
	id: string;
	label: string;
	level: number;
	parentId?: string;
	summary: string;
	keywords: string[];
	chunkIds: string[];
	childIds: string[];
	occurrenceCount: number;
}

export interface AxiomSparseTreeGrepIndex {
	version: 1;
	documentId: string;
	documentName: string;
	sourcePath: string;
	/** For PDF inputs, byte offsets target extracted text stored here, not raw PDF bytes. */
	textPath?: string;
	sourceKind: "text" | "pdf_text";
	totalBytes: number;
	generatedAt: string;
	updatedAt: string;
	chunkCount: number;
	pageCount: number;
	chunks: AxiomSparseTreeGrepChunk[];
	nodes: AxiomSparseTreeGrepNode[];
}

export interface AxiomSparseTreeGrepHit {
	score: number;
	documentId: string;
	documentName: string;
	sourcePath: string;
	nodeId?: string;
	nodeLabel?: string;
	chunkId: string;
	chunkSummary: string;
	page: number;
	byteStart: number;
	byteEnd: number;
	lineStart: number;
	lineEnd: number;
	matchedKeywords: string[];
}

export interface AxiomSkillRecallHit {
	skill: AxiomSkill;
	score: number;
	matchedKeywords: string[];
}

/**
 * A concept summary aggregated from the reflection + skill indices. Not stored
 * separately on disk — derived at recall time. Counts how many past artifacts
 * mention a given problem class, useful as "we've seen this before" signal.
 */
export interface AxiomConceptSummary {
	problemClass: string;
	reflectionIds: string[];
	skillIds: string[];
	totalReferences: number;
	lastSeen: string;
	score: number;
	/** Edges connecting artifacts within this concept (e.g. a skill that addresses a past reflection). */
	edges: AxiomConceptEdge[];
}

/**
 * A directed edge between two memory artifacts that share a problem class.
 * Persisted in {@link ConceptEdgeStore}; surfaces in concept summaries so the
 * agent can see "skill X addresses past failure Y" rather than just two
 * unrelated counts.
 *
 * Types:
 *   - "addresses"   — a skill addresses (corrects) a past reflection
 *   - "derived_from"— a skill was derived from / built atop another skill
 *   - "similar_to"  — two reflections describe the same failure mode
 */
export type AxiomConceptEdgeType = "addresses" | "derived_from" | "similar_to";
export type AxiomConceptNodeKind = "skill" | "reflection";

export interface AxiomConceptEdge {
	id: string;
	type: AxiomConceptEdgeType;
	fromKind: AxiomConceptNodeKind;
	fromId: string;
	toKind: AxiomConceptNodeKind;
	toId: string;
	problemClass: string;
	timestamp: string;
}

/** A single node in the reasoning graph. */
export type AxiomGraphNodeStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";

export interface AxiomGraphNode {
	id: string;
	description: string;
	dependencies: string[];
	expectedTool?: string;
	status: AxiomGraphNodeStatus;
	toolCallId?: string;
	actualTool?: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

/**
 * A single ToT candidate approach. Self-scored by the planner LLM on three axes
 * (1-10 scale). `score` is the derived total used to pick a winner; the parser
 * recomputes it from the components so the model can't hand-wave a high score
 * without also raising the components.
 */
export interface AxiomReasoningCandidate {
	id: string;
	summary: string;
	/** Parent candidate id when produced by rStar tree expansion. */
	parentId?: string;
	/** Tree depth when produced by rStar tree expansion. Root branches are depth 1. */
	depth?: number;
	/** Candidate-id path from root branch to this node. */
	path?: string[];
	pros?: string;
	cons?: string;
	/** Can we actually execute this with the tools/info available? Higher is better. */
	feasibility?: number;
	/** Does this solve the full task, not just part of it? Higher is better. */
	completeness?: number;
	/** Likelihood this derails (loops, gets stuck, produces wrong output). Lower is better. */
	risk?: number;
	/** feasibility + completeness - risk, recomputed by the parser. */
	score?: number;
	/** rStar visit count for this search node. */
	visits?: number;
	/** rStar cumulative backed-up value. */
	totalValue?: number;
	/** rStar average backed-up value. */
	meanValue?: number;
	/** UCB/search score at the point of selection, when available. */
	searchScore?: number;
	/** Token/time/call expense. Lower is better. From the independent critic pass. */
	criticCost?: number;
	/** Edge-case + error coverage. Higher is better. From the independent critic pass. */
	criticCoverage?: number;
	/** Recoverability when things go wrong. Higher is better. From the independent critic pass. */
	criticUndoability?: number;
	/** coverage + undoability - cost, recomputed by the critic. */
	criticScore?: number;
	/** Free-text rationale from the critic, one sentence. */
	criticRationale?: string;
	/** Sum of self-score and critic score, used to pick the final winner when the critic ran. */
	combinedScore?: number;
}

/** Output of the planner: candidate approaches, chosen winner, and the graph. */
export interface AxiomReasoningGraph {
	source: "llm" | "rstar" | "fallback";
	candidates: AxiomReasoningCandidate[];
	chosenId: string;
	chosenReason: string;
	/**
	 * True when the parser overrode the model's `chosenId` because its self-scores
	 * pointed to a different candidate. Surfaced in the rendered plan so the agent
	 * knows the pick was rescued by the score-consistency check.
	 */
	chosenOverridden?: boolean;
	search?: {
		algorithm: "rstar-lite";
		rollouts: number;
		maxDepth: number;
		exploration: number;
		expandedNodes: number;
	};
	nodes: AxiomGraphNode[];
	latencyMs: number;
}

export interface AxiomGraphExecutionUpdate {
	nodeId: string;
	previousStatus: AxiomGraphNodeStatus;
	status: AxiomGraphNodeStatus;
	toolCallId?: string;
	toolName?: string;
	reason: string;
	timestamp: string;
}

export interface AxiomGraphExecutionSnapshot {
	total: number;
	pending: string[];
	inProgress: string[];
	complete: string[];
	failed: string[];
	skipped: string[];
	nextReady: string[];
	completionRatio: number;
}

/** Per-task plan: Step-Back abstraction, recalls, concepts, ASCoT depth, reasoning graph. */
export interface AxiomTaskPlan {
	abstraction: AxiomAbstraction;
	recalls: AxiomReflectionRecallHit[];
	skillRecalls: AxiomSkillRecallHit[];
	understandingRecalls: AxiomUnderstandingRecallHit[];
	codeGraphRecalls: AxiomCodeGraphHit[];
	flowGraphRecalls: AxiomFlowGraphHit[];
	knowledgeGraphRecalls: AxiomKnowledgeGraphHit[];
	sparseTreeGrepRecalls: AxiomSparseTreeGrepHit[];
	conceptRecalls: AxiomConceptSummary[];
	graph?: AxiomReasoningGraph;
	ascot: AxiomASCoTPlan;
}

export type AxiomTraceRecord =
	| ({ type: "task_start"; timestamp: string } & AxiomTraceStart)
	| { type: "agent_event"; timestamp: string; traceId: string; event: Pick<AgentEvent, "type"> }
	| { type: "message_end"; timestamp: string; traceId: string; message: AxiomTraceMessageSummary }
	| { type: "local_fast_path"; timestamp: string; traceId: string; replyChars: number; latencyMs: number }
	| ({ type: "ip_retry"; timestamp: string; traceId: string } & AxiomIPRetryRecord)
	| {
			type: "ip_stream_check";
			timestamp: string;
			traceId: string;
			language: string;
			ok: boolean;
			latencyMs: number;
			line?: number;
			column?: number;
	  }
	| {
			type: "ip_stream_abort";
			timestamp: string;
			traceId: string;
			language: string;
			line?: number;
			column?: number;
			abortIndex: number;
	  }
	| {
			type: "step_back";
			timestamp: string;
			traceId: string;
			source: AxiomAbstraction["source"];
			problemClass: string[];
			keywords: string[];
			domain: string;
			latencyMs: number;
	  }
	| {
			type: "reflection_recall";
			timestamp: string;
			traceId: string;
			recalledIds: string[];
			scores: number[];
	  }
	| {
			type: "reflection_capture";
			timestamp: string;
			traceId: string;
			reflectionId: string;
			failureType: string;
			failureCodes: string[];
	  }
	| {
			type: "ascot_plan";
			timestamp: string;
			traceId: string;
			complexity: number;
			thinkingLevel: AxiomASCoTPlan["thinkingLevel"];
			strategyHintCount: number;
	  }
	| {
			type: "skill_recall";
			timestamp: string;
			traceId: string;
			recalledIds: string[];
			scores: number[];
	  }
	| {
			type: "skill_capture";
			timestamp: string;
			traceId: string;
			skillId: string;
			toolsUsed: string[];
			stepCount: number;
			complexity: number;
	  }
	| {
			type: "skill_outcome";
			timestamp: string;
			traceId: string;
			outcome: AxiomSkillOutcome;
			skillIds: string[];
	  }
	| {
			type: "concept_recall";
			timestamp: string;
			traceId: string;
			problemClasses: string[];
			totalReferences: number[];
	  }
	| {
			type: "knowledge_graph_recall";
			timestamp: string;
			traceId: string;
			hitCount: number;
			nodeCount: number;
			edgeCount: number;
	  }
	| {
			type: "sparse_tree_grep_recall";
			timestamp: string;
			traceId: string;
			hitCount: number;
			documentIds: string[];
	  }
	| {
			type: "code_graph_recall";
			timestamp: string;
			traceId: string;
			hitCount: number;
			graphIds: string[];
	  }
	| {
			type: "flow_graph_recall";
			timestamp: string;
			traceId: string;
			hitCount: number;
			graphIds: string[];
	  }
	| {
			type: "reasoning_graph";
			timestamp: string;
			traceId: string;
			source: AxiomReasoningGraph["source"];
			candidateCount: number;
			chosenId: string;
			chosenScore?: number;
			chosenOverridden?: boolean;
			nodeCount: number;
			latencyMs: number;
	  }
	| {
			type: "reasoning_critic";
			timestamp: string;
			traceId: string;
			scoredCount: number;
			chosenId: string;
			chosenOverridden: boolean;
			latencyMs: number;
	  }
	| {
			type: "graph_node_update";
			timestamp: string;
			traceId: string;
			update: AxiomGraphExecutionUpdate;
			snapshot: AxiomGraphExecutionSnapshot;
	  }
	| {
			type: "graph_execution_summary";
			timestamp: string;
			traceId: string;
			snapshot: AxiomGraphExecutionSnapshot;
	  }
	| { type: "task_end"; timestamp: string; traceId: string; latencyMs: number; outcome: "completed" | "error" };

export interface AxiomTraceWriter {
	start(input: Omit<AxiomTraceStart, "startedAt">): void;
	record(record: AxiomTraceRecord): void;
}

export interface AxiomAssistantValidationContext {
	userText: string;
	classification: AxiomTaskClassification;
	message: AssistantMessage;
}

export interface AxiomRuntimePromptContext {
	text: string;
	hasImages: boolean;
	hasPendingContext: boolean;
	activeToolNames: string[];
	model?: Model<any>;
	thinkingLevel: string;
}
