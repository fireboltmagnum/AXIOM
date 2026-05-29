import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { analyzeFile, languageForPath } from "./CodeAnalyzer.ts";
import type {
	AxiomFileUnderstanding,
	AxiomFlowGraph,
	AxiomFlowGraphEdge,
	AxiomFlowGraphEdgeKind,
	AxiomFlowGraphHit,
	AxiomFlowGraphNode,
	AxiomFlowGraphNodeKind,
	AxiomFlowRuntimeTrace,
	AxiomFlowStackFrame,
	AxiomSymbolEntry,
} from "./RuntimeTypes.ts";

const SKIP_DIRS = new Set([
	".axiom",
	".git",
	".next",
	".turbo",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
]);

const CALL_EXCLUDES = new Set(["catch", "do", "for", "function", "if", "new", "return", "switch", "while", "with"]);

export interface FlowGraphAnalyzeOptions {
	path: string;
	maxFiles?: number;
	maxBytesPerFile?: number;
}

export interface FlowGraphPathResult {
	graph: AxiomFlowGraph;
	nodes: AxiomFlowGraphNode[];
	edges: AxiomFlowGraphEdge[];
}

export type FlowGraphSliceMode = "summary" | "expanded";

export interface FlowGraphSliceSection {
	title: string;
	nodes: AxiomFlowGraphNode[];
	edges: AxiomFlowGraphEdge[];
}

export interface FlowGraphSliceResult {
	graph: AxiomFlowGraph;
	mode: FlowGraphSliceMode;
	focus?: AxiomFlowGraphNode;
	sections: FlowGraphSliceSection[];
	expansionHints: Array<{ node: AxiomFlowGraphNode; reason: string }>;
}

export interface FlowGraphDebugOptions {
	command: string;
	cwd: string;
	graphId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Static + runtime flow map storage.
 *
 * This is deliberately deterministic and dependency-free for the first phase.
 * It uses CodeAnalyzer's file/symbol summaries as its substrate, then adds
 * approximate execution, data, error, effect, event, and runtime-debug edges.
 */
export class FlowGraphStore {
	private readonly baseDir: string;
	private readonly graphsDir: string;
	private readonly runtimeDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? path.join(homedir(), ".axiom", "agent", "flow-graphs");
		this.graphsDir = path.join(this.baseDir, "graphs");
		this.runtimeDir = path.join(this.baseDir, "runtime");
	}

	analyze(options: FlowGraphAnalyzeOptions): AxiomFlowGraph {
		const rootPath = path.resolve(options.path);
		if (!existsSync(rootPath)) throw new Error(`Path not found: ${rootPath}`);
		const maxFiles = Math.max(1, Math.min(1000, Math.floor(options.maxFiles ?? 250)));
		const maxBytesPerFile = Math.max(1000, Math.floor(options.maxBytesPerFile ?? 250_000));
		const collected = collectSourceFiles(rootPath, { maxFiles, maxBytesPerFile });
		const rootForRel = statSync(rootPath).isDirectory() ? rootPath : path.dirname(rootPath);
		const sources: FlowSourceFile[] = collected.map((file) => {
			const source = readFileSync(file, "utf-8");
			const relativePath = toPosix(path.relative(rootForRel, file) || path.basename(file));
			return {
				understanding: analyzeFile(relativePath, source),
				source,
				sourceHash: hash(source, 12),
			};
		});

		const graphId = `fg_${hash(`${rootPath}:${sources.map((f) => `${f.understanding.path}:${f.sourceHash}`).join("|")}`, 18)}`;
		const { nodes, edges } = buildGraph(sources);
		const graph: AxiomFlowGraph = {
			id: graphId,
			timestamp: new Date().toISOString(),
			rootPath: toPosix(path.relative(process.cwd(), rootPath) || rootPath),
			fileCount: sources.length,
			nodeCount: nodes.length,
			edgeCount: edges.length,
			nodes,
			edges,
			keywords: [...new Set(nodes.flatMap((node) => node.keywords))].slice(0, 800),
		};
		this.save(graph);
		return graph;
	}

	search(
		query: string,
		options?: { graphId?: string; limit?: number; kinds?: AxiomFlowGraphNodeKind[] },
	): AxiomFlowGraphHit[] {
		const tokens = tokenize(query);
		if (tokens.length === 0) return [];
		const limit = Math.max(1, Math.min(50, Math.floor(options?.limit ?? 8)));
		const kindFilter = options?.kinds ? new Set(options.kinds) : undefined;
		const graphs = options?.graphId ? [this.load(options.graphId)].filter(Boolean) : this.list();
		const hits: AxiomFlowGraphHit[] = [];
		for (const graph of graphs) {
			if (!graph) continue;
			for (const node of graph.nodes) {
				if (kindFilter && !kindFilter.has(node.kind)) continue;
				const nodeTerms = new Set([
					...node.keywords,
					...tokenize(node.label),
					...tokenize(node.path ?? ""),
					...tokenize(node.summary ?? ""),
				]);
				const matched = tokens.filter((token) => nodeTerms.has(token));
				if (matched.length === 0) continue;
				const incident = incidentEdges(graph, node.id).slice(0, 14);
				const neighbors = neighborNodes(graph, node.id, incident);
				const kindBoost = node.kind === "function" || node.kind === "method" ? 3 : node.kind === "effect" ? 2 : 0;
				hits.push({
					graph,
					score: matched.length * 6 + incident.length * 0.2 + kindBoost,
					matchedKeywords: [...new Set(matched)],
					nodes: [node, ...neighbors],
					edges: incident,
				});
			}
		}
		hits.sort((a, b) => b.score - a.score || a.nodes[0]?.label.localeCompare(b.nodes[0]?.label ?? "") || 0);
		return hits.slice(0, limit);
	}

	effects(graphId: string, filter?: string, limit = 20): AxiomFlowGraphHit {
		const graph = this.require(graphId);
		const tokens = tokenize(filter ?? "");
		const effectNodes = graph.nodes
			.filter((node) => node.kind === "effect" || node.kind === "event" || node.kind === "error")
			.filter((node) => {
				if (tokens.length === 0) return true;
				const terms = new Set([...node.keywords, ...tokenize(node.path ?? ""), ...tokenize(node.summary ?? "")]);
				return tokens.some((token) => terms.has(token));
			})
			.slice(0, Math.max(1, limit));
		const effectIds = new Set(effectNodes.map((node) => node.id));
		const edges = graph.edges
			.filter((edge) => effectIds.has(edge.fromId) || effectIds.has(edge.toId))
			.slice(0, Math.max(1, limit * 2));
		return {
			graph,
			score: effectNodes.length,
			matchedKeywords: tokens,
			nodes: dedupeNodes([...effectNodes, ...edges.flatMap((edge) => edgeNodes(graph, edge))]),
			edges,
		};
	}

	explain(graphId: string, nodeLabelOrId: string, limit = 20): AxiomFlowGraphHit | undefined {
		const graph = this.require(graphId);
		const node = findNode(graph, nodeLabelOrId);
		if (!node) return undefined;
		const edges = incidentEdges(graph, node.id).slice(0, Math.max(1, limit));
		return {
			graph,
			score: edges.length,
			matchedKeywords: tokenize(nodeLabelOrId),
			nodes: [node, ...neighborNodes(graph, node.id, edges)],
			edges,
		};
	}

	slice(
		graphId: string,
		nodeLabelOrId?: string,
		options?: { mode?: FlowGraphSliceMode; limit?: number; maxDepth?: number },
	): FlowGraphSliceResult {
		const graph = this.require(graphId);
		const limit = Math.max(1, Math.min(80, Math.floor(options?.limit ?? 10)));
		const mode = options?.mode ?? (nodeLabelOrId ? "expanded" : "summary");
		const focus = nodeLabelOrId ? findNode(graph, nodeLabelOrId) : undefined;
		if (mode === "expanded" && focus) {
			return expandedSlice(graph, focus, {
				limit,
				maxDepth: Math.max(1, Math.min(5, Math.floor(options?.maxDepth ?? 2))),
			});
		}
		return summarySlice(graph, limit, focus);
	}

	path(graphId: string, fromLabelOrId: string, toLabelOrId: string, maxDepth = 6): FlowGraphPathResult | undefined {
		const graph = this.require(graphId);
		const start = findNode(graph, fromLabelOrId);
		const goal = findNode(graph, toLabelOrId);
		if (!start || !goal) return undefined;
		if (start.id === goal.id) return { graph, nodes: [start], edges: [] };
		const queue: Array<{ nodeId: string; edgeIds: string[]; seen: Set<string> }> = [
			{ nodeId: start.id, edgeIds: [], seen: new Set([start.id]) },
		];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.edgeIds.length >= maxDepth) continue;
			for (const edge of incidentEdges(graph, current.nodeId)) {
				const nextId = edge.fromId === current.nodeId ? edge.toId : edge.fromId;
				if (current.seen.has(nextId)) continue;
				const nextEdgeIds = [...current.edgeIds, edge.id];
				if (nextId === goal.id) {
					const edges = nextEdgeIds
						.map((id) => graph.edges.find((candidate) => candidate.id === id))
						.filter((candidate): candidate is AxiomFlowGraphEdge => candidate !== undefined);
					const nodeIds = new Set([start.id, goal.id, ...edges.flatMap((edge) => [edge.fromId, edge.toId])]);
					return { graph, nodes: graph.nodes.filter((node) => nodeIds.has(node.id)), edges };
				}
				queue.push({ nodeId: nextId, edgeIds: nextEdgeIds, seen: new Set([...current.seen, nextId]) });
			}
		}
		return undefined;
	}

	async debug(options: FlowGraphDebugOptions): Promise<AxiomFlowRuntimeTrace> {
		const startedAt = Date.now();
		const run = await runShellCommand({
			command: options.command,
			cwd: options.cwd,
			timeoutMs: Math.max(1000, Math.floor(options.timeoutMs ?? 30_000)),
			signal: options.signal,
		});
		const stackFrames = parseStackFrames(`${run.stdout}\n${run.stderr}`);
		const candidateGraphs = options.graphId ? [this.load(options.graphId)].filter(Boolean) : this.list().slice(0, 5);
		const correlatedNodes = correlateStackFrames(candidateGraphs, stackFrames);
		const trace: AxiomFlowRuntimeTrace = {
			id: `frt_${randomUUID()}`,
			timestamp: new Date().toISOString(),
			command: options.command,
			cwd: options.cwd,
			exitCode: run.exitCode,
			timedOut: run.timedOut,
			durationMs: Date.now() - startedAt,
			stdoutTail: tail(run.stdout, 12_000),
			stderrTail: tail(run.stderr, 12_000),
			stackFrames,
			correlatedNodes,
		};
		this.saveRuntimeTrace(trace);
		return trace;
	}

	stats(): { graphCount: number; fileCount: number; nodeCount: number; edgeCount: number; runtimeTraceCount: number } {
		const graphs = this.list();
		const runtimeTraceCount = existsSync(this.runtimeDir)
			? readdirSync(this.runtimeDir).filter((file) => file.endsWith(".json")).length
			: 0;
		return {
			graphCount: graphs.length,
			fileCount: graphs.reduce((sum, graph) => sum + graph.fileCount, 0),
			nodeCount: graphs.reduce((sum, graph) => sum + graph.nodeCount, 0),
			edgeCount: graphs.reduce((sum, graph) => sum + graph.edgeCount, 0),
			runtimeTraceCount,
		};
	}

	list(): AxiomFlowGraph[] {
		if (!existsSync(this.graphsDir)) return [];
		const graphs: AxiomFlowGraph[] = [];
		for (const file of readdirSync(this.graphsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				graphs.push(JSON.parse(readFileSync(path.join(this.graphsDir, file), "utf-8")) as AxiomFlowGraph);
			} catch {
				// skip malformed graph
			}
		}
		graphs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return graphs;
	}

	load(graphId: string): AxiomFlowGraph | undefined {
		const graphPath = path.join(this.graphsDir, `${graphId}.json`);
		if (!existsSync(graphPath)) return undefined;
		try {
			return JSON.parse(readFileSync(graphPath, "utf-8")) as AxiomFlowGraph;
		} catch {
			return undefined;
		}
	}

	require(graphId: string): AxiomFlowGraph {
		const graph = this.load(graphId);
		if (!graph) throw new Error(`Flow graph not found: ${graphId}`);
		return graph;
	}

	latestGraphId(): string | undefined {
		return this.list()[0]?.id;
	}

	clearCache(): void {
		// File-backed store has no cache yet.
	}

	private save(graph: AxiomFlowGraph): void {
		if (!existsSync(this.graphsDir)) mkdirSync(this.graphsDir, { recursive: true });
		writeFileSync(path.join(this.graphsDir, `${graph.id}.json`), `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
		writeFileSync(path.join(this.baseDir, "FLOW_REPORT.md"), renderReport(this.list()), "utf-8");
	}

	private saveRuntimeTrace(trace: AxiomFlowRuntimeTrace): void {
		if (!existsSync(this.runtimeDir)) mkdirSync(this.runtimeDir, { recursive: true });
		writeFileSync(path.join(this.runtimeDir, `${trace.id}.json`), `${JSON.stringify(trace, null, 2)}\n`, "utf-8");
	}
}

interface FlowSourceFile {
	understanding: AxiomFileUnderstanding;
	source: string;
	sourceHash: string;
}

function buildGraph(files: FlowSourceFile[]): { nodes: AxiomFlowGraphNode[]; edges: AxiomFlowGraphEdge[] } {
	const nodes: AxiomFlowGraphNode[] = [];
	const edges: AxiomFlowGraphEdge[] = [];
	const nodeByKey = new Map<string, AxiomFlowGraphNode>();
	const fileNodeByPath = new Map<string, AxiomFlowGraphNode>();
	const symbolNodesByName = new Map<string, AxiomFlowGraphNode[]>();
	const symbolNodeByFileAndName = new Map<string, AxiomFlowGraphNode>();

	const getNode = (
		kind: AxiomFlowGraphNodeKind,
		label: string,
		options: Partial<Omit<AxiomFlowGraphNode, "id" | "kind" | "label">> = {},
	): AxiomFlowGraphNode => {
		const key = `${kind}:${options.path ?? ""}:${options.line ?? ""}:${label}`;
		const existing = nodeByKey.get(key);
		if (existing) return existing;
		const node = makeNode(kind, label, options);
		nodeByKey.set(key, node);
		nodes.push(node);
		return node;
	};

	const pushEdge = (
		kind: AxiomFlowGraphEdgeKind,
		fromId: string,
		toId: string,
		label: string | undefined,
		line: number | undefined,
		weight: number,
	): void => {
		edges.push(makeEdge(kind, fromId, toId, label, line, weight));
	};

	for (const file of files) {
		const u = file.understanding;
		const fileNode = getNode("file", u.path, {
			path: u.path,
			language: u.language,
			summary: `${u.language} file with ${u.symbols.length} symbol(s)`,
			keywords: [...tokenize(u.path), u.language, "file", "flow"],
		});
		fileNodeByPath.set(u.path, fileNode);

		for (const symbol of u.symbols) {
			const kind = symbol.kind === "class" ? "class" : symbol.kind === "method" ? "method" : "function";
			const symbolNode = getNode(kind, symbol.name, {
				path: u.path,
				language: u.language,
				line: symbol.line,
				summary: symbol.signature,
				keywords: [...tokenize(symbol.name), ...tokenize(u.path), symbol.kind, u.language],
			});
			pushEdge("contains", fileNode.id, symbolNode.id, symbol.kind, symbol.line, 1);
			symbolNodeByFileAndName.set(`${u.path}:${symbol.name}`, symbolNode);
			const simpleSymbolName = symbol.name.split(".").pop();
			if (simpleSymbolName && simpleSymbolName !== symbol.name) {
				symbolNodeByFileAndName.set(`${u.path}:${simpleSymbolName}`, symbolNode);
			}
			const byName = symbolNodesByName.get(symbol.name) ?? [];
			byName.push(symbolNode);
			symbolNodesByName.set(symbol.name, byName);
			if (simpleSymbolName && simpleSymbolName !== symbol.name) {
				const simpleByName = symbolNodesByName.get(simpleSymbolName) ?? [];
				simpleByName.push(symbolNode);
				symbolNodesByName.set(simpleSymbolName, simpleByName);
			}

			for (const param of extractParamNames(symbol.signature ?? "")) {
				const dataNode = getNode("data", param, {
					path: u.path,
					language: u.language,
					line: symbol.line,
					summary: `parameter of ${symbol.name}`,
					keywords: [...tokenize(param), ...tokenize(symbol.name), "parameter", "data"],
				});
				pushEdge("uses", symbolNode.id, dataNode.id, "parameter", symbol.line, 0.7);
			}
		}
	}

	for (const file of files) {
		scanFlowSource(file, {
			fileNode: fileNodeByPath.get(file.understanding.path)!,
			getNode,
			pushEdge,
			resolveCallTarget: (sourceFilePath, callName) =>
				resolveCallTarget(sourceFilePath, callName, symbolNodeByFileAndName, symbolNodesByName, getNode),
		});
	}

	return { nodes: dedupeNodes(nodes), edges: dedupeEdges(edges) };
}

function scanFlowSource(
	file: FlowSourceFile,
	context: {
		fileNode: AxiomFlowGraphNode;
		getNode: (
			kind: AxiomFlowGraphNodeKind,
			label: string,
			options?: Partial<Omit<AxiomFlowGraphNode, "id" | "kind" | "label">>,
		) => AxiomFlowGraphNode;
		pushEdge: (
			kind: AxiomFlowGraphEdgeKind,
			fromId: string,
			toId: string,
			label: string | undefined,
			line: number | undefined,
			weight: number,
		) => void;
		resolveCallTarget: (sourceFilePath: string, callName: string) => AxiomFlowGraphNode;
	},
): void {
	const u = file.understanding;
	const lines = file.source.split(/\r?\n/);
	const symbols = [...u.symbols].sort((a, b) => a.line - b.line);

	const containerForLine = (lineNo: number): AxiomFlowGraphNode => {
		let candidate: AxiomSymbolEntry | undefined;
		for (const symbol of symbols) {
			if (symbol.line > lineNo) break;
			candidate = symbol;
		}
		if (!candidate) return context.fileNode;
		return context.getNode(
			candidate.kind === "class" ? "class" : candidate.kind === "method" ? "method" : "function",
			candidate.name,
			{
				path: u.path,
				language: u.language,
				line: candidate.line,
				summary: candidate.signature,
				keywords: [...tokenize(candidate.name), ...tokenize(u.path), candidate.kind, u.language],
			},
		);
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const raw = lines[i];
		const line = raw.trim();
		if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;
		const sourceNode = containerForLine(lineNo);

		if (/\b(if|switch|case|else\s+if)\b|\?/.test(line)) {
			const branch = context.getNode("branch", `branch@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 140),
				keywords: [...tokenize(line), "branch", "condition", "execution"],
			});
			context.pushEdge("branches", sourceNode.id, branch.id, "condition", lineNo, 0.8);
		}

		if (/\b(for|while|do)\b|\.forEach\s*\(|\.map\s*\(|\.reduce\s*\(|\.filter\s*\(/.test(line)) {
			const loop = context.getNode("loop", `loop@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 140),
				keywords: [...tokenize(line), "loop", "iteration", "execution"],
			});
			context.pushEdge("loops", sourceNode.id, loop.id, "iteration", lineNo, 0.8);
		}

		const variableMatch = /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)/.exec(line);
		if (variableMatch) {
			const data = context.getNode("data", variableMatch[1], {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(variableMatch[2], 140),
				keywords: [...tokenize(variableMatch[1]), ...tokenize(variableMatch[2]), "data", "value"],
			});
			context.pushEdge("transforms", sourceNode.id, data.id, "assignment", lineNo, 0.8);
		}

		if (/\breturn\b/.test(line)) {
			const returned = context.getNode("data", `return@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line.replace(/^return\s*/, ""), 140),
				keywords: [...tokenize(line), "return", "data"],
			});
			context.pushEdge("returns", sourceNode.id, returned.id, "return", lineNo, 0.9);
		}

		if (/\bthrow\b|\bPromise\.reject\s*\(/.test(line)) {
			const error = context.getNode("error", `error@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 140),
				keywords: [...tokenize(line), "throw", "error", "failure"],
			});
			context.pushEdge("throws", sourceNode.id, error.id, "throw", lineNo, 1);
		}

		if (/\bcatch\s*\(|\.catch\s*\(/.test(line)) {
			const error = context.getNode("error", `catch@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 140),
				keywords: [...tokenize(line), "catch", "error", "fallback"],
			});
			context.pushEdge("catches", sourceNode.id, error.id, "catch", lineNo, 1);
		}

		for (const effect of extractEffects(line)) {
			const effectNode = context.getNode("effect", effect.label, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 160),
				keywords: [...tokenize(effect.label), ...tokenize(line), effect.edgeKind, "effect"],
			});
			context.pushEdge(effect.edgeKind, sourceNode.id, effectNode.id, effect.label, lineNo, 1);
		}

		for (const event of extractEvents(line)) {
			const eventNode = context.getNode("event", event.label, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 160),
				keywords: [...tokenize(event.label), ...tokenize(line), event.edgeKind, "event"],
			});
			context.pushEdge(event.edgeKind, sourceNode.id, eventNode.id, event.label, lineNo, 1);
		}

		const asyncDetected = /\bawait\b|\.then\s*\(|\.finally\s*\(/.test(line);
		if (asyncDetected) {
			const asyncNode = context.getNode("async", `async@${u.path}:${lineNo}`, {
				path: u.path,
				language: u.language,
				line: lineNo,
				summary: snippet(line, 160),
				keywords: [...tokenize(line), "async", "await", "promise"],
			});
			context.pushEdge("awaits", sourceNode.id, asyncNode.id, "async boundary", lineNo, 0.8);
		}

		if (!isDeclarationLine(line)) {
			for (const callName of extractCalls(line)) {
				const target = context.resolveCallTarget(u.path, callName);
				context.pushEdge(asyncDetected ? "awaits" : "calls", sourceNode.id, target.id, callName, lineNo, 1);
			}
		}
	}
}

function summarySlice(graph: AxiomFlowGraph, limit: number, focus?: AxiomFlowGraphNode): FlowGraphSliceResult {
	const executionEdges = graph.edges.filter((edge) => edge.kind === "calls" || edge.kind === "awaits").slice(0, limit);
	const dataEdges = graph.edges
		.filter((edge) => edge.kind === "uses" || edge.kind === "transforms" || edge.kind === "returns")
		.slice(0, limit);
	const effectEdges = graph.edges
		.filter((edge) =>
			["reads", "writes", "sends", "runs", "mutates", "throws", "catches", "listens", "emits", "handles"].includes(
				edge.kind,
			),
		)
		.slice(0, limit);
	const branchNodes = graph.nodes
		.filter((node) => node.kind === "branch" || node.kind === "loop" || node.kind === "async")
		.slice(0, limit);
	const primaryNodes = graph.nodes
		.filter((node) => node.kind === "function" || node.kind === "method" || node.kind === "class")
		.sort(
			(a, b) =>
				incidentEdges(graph, b.id).length - incidentEdges(graph, a.id).length || (a.line ?? 0) - (b.line ?? 0),
		)
		.slice(0, limit);
	return {
		graph,
		mode: "summary",
		focus,
		sections: [
			{ title: "Primary execution nodes", nodes: primaryNodes, edges: [] },
			{ title: "Execution calls / async", nodes: nodesForEdges(graph, executionEdges), edges: executionEdges },
			{ title: "Data movement", nodes: nodesForEdges(graph, dataEdges), edges: dataEdges },
			{ title: "Effects / events / errors", nodes: nodesForEdges(graph, effectEdges), edges: effectEdges },
			{ title: "Branches / loops / async boundaries", nodes: branchNodes, edges: [] },
		].filter((section) => section.nodes.length > 0 || section.edges.length > 0),
		expansionHints: expansionHints(graph, primaryNodes, limit),
	};
}

function expandedSlice(
	graph: AxiomFlowGraph,
	focus: AxiomFlowGraphNode,
	options: { limit: number; maxDepth: number },
): FlowGraphSliceResult {
	const edgeIds = new Set<string>();
	const nodeIds = new Set<string>([focus.id]);
	const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: focus.id, depth: 0 }];
	while (queue.length > 0 && nodeIds.size < options.limit * 4) {
		const current = queue.shift()!;
		if (current.depth >= options.maxDepth) continue;
		for (const edge of incidentEdges(graph, current.nodeId)) {
			if (edgeIds.size >= options.limit * 6) break;
			edgeIds.add(edge.id);
			const nextId = edge.fromId === current.nodeId ? edge.toId : edge.fromId;
			if (!nodeIds.has(nextId)) {
				nodeIds.add(nextId);
				queue.push({ nodeId: nextId, depth: current.depth + 1 });
			}
		}
	}
	const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
	const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
	const byKind = (kinds: AxiomFlowGraphEdgeKind[]) => edges.filter((edge) => kinds.includes(edge.kind));
	const execution = byKind(["calls", "awaits", "branches", "loops"]);
	const data = byKind(["uses", "transforms", "returns"]);
	const effects = byKind([
		"reads",
		"writes",
		"sends",
		"runs",
		"mutates",
		"throws",
		"catches",
		"listens",
		"emits",
		"handles",
	]);
	return {
		graph,
		mode: "expanded",
		focus,
		sections: [
			{ title: `Focus: ${focus.label}`, nodes: [focus], edges: [] },
			{ title: "Execution slice", nodes: nodesForEdges(graph, execution), edges: execution },
			{ title: "Data slice", nodes: nodesForEdges(graph, data), edges: data },
			{ title: "Effect / event / error slice", nodes: nodesForEdges(graph, effects), edges: effects },
			{
				title: "Other neighboring nodes",
				nodes: nodes.filter(
					(node) =>
						node.id !== focus.id && !edges.some((edge) => edge.fromId === node.id || edge.toId === node.id),
				),
				edges: [],
			},
		].filter((section) => section.nodes.length > 0 || section.edges.length > 0),
		expansionHints: expansionHints(
			graph,
			nodes.filter((node) => node.id !== focus.id),
			options.limit,
		),
	};
}

function nodesForEdges(graph: AxiomFlowGraph, edges: AxiomFlowGraphEdge[]): AxiomFlowGraphNode[] {
	const ids = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
	return graph.nodes.filter((node) => ids.has(node.id));
}

function expansionHints(
	graph: AxiomFlowGraph,
	nodes: AxiomFlowGraphNode[],
	limit: number,
): Array<{ node: AxiomFlowGraphNode; reason: string }> {
	return dedupeNodes(nodes)
		.filter((node) => node.kind !== "file")
		.sort((a, b) => incidentEdges(graph, b.id).length - incidentEdges(graph, a.id).length)
		.slice(0, Math.max(1, Math.min(8, limit)))
		.map((node) => ({
			node,
			reason: `${incidentEdges(graph, node.id).length} connected flow edge(s)`,
		}));
}

function resolveCallTarget(
	sourceFilePath: string,
	callName: string,
	symbolNodeByFileAndName: Map<string, AxiomFlowGraphNode>,
	symbolNodesByName: Map<string, AxiomFlowGraphNode[]>,
	getNode: (
		kind: AxiomFlowGraphNodeKind,
		label: string,
		options?: Partial<Omit<AxiomFlowGraphNode, "id" | "kind" | "label">>,
	) => AxiomFlowGraphNode,
): AxiomFlowGraphNode {
	const simpleName = callName.split(".").pop() ?? callName;
	const local = symbolNodeByFileAndName.get(`${sourceFilePath}:${simpleName}`);
	if (local) return local;
	const globalMatches = symbolNodesByName.get(simpleName) ?? [];
	if (globalMatches.length === 1) return globalMatches[0];
	return getNode("external", callName, {
		summary: `external or unresolved call ${callName}`,
		keywords: [...tokenize(callName), "call", "external"],
	});
}

function collectSourceFiles(rootPath: string, options: { maxFiles: number; maxBytesPerFile: number }): string[] {
	const files: string[] = [];
	const visit = (current: string) => {
		if (files.length >= options.maxFiles) return;
		const stat = statSync(current);
		if (stat.isDirectory()) {
			if (SKIP_DIRS.has(path.basename(current))) return;
			for (const entry of readdirSync(current).sort()) {
				visit(path.join(current, entry));
				if (files.length >= options.maxFiles) break;
			}
			return;
		}
		if (!stat.isFile()) return;
		if (languageForPath(current) === "unknown") return;
		if (stat.size > options.maxBytesPerFile) return;
		files.push(current);
	};
	visit(rootPath);
	return files;
}

function extractCalls(line: string): string[] {
	const calls: string[] = [];
	const re = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
	let match: RegExpExecArray | null = re.exec(line);
	while (match) {
		const callName = match[1];
		const simple = callName.split(".").pop() ?? callName;
		if (!CALL_EXCLUDES.has(simple) && !CALL_EXCLUDES.has(callName)) calls.push(callName);
		match = re.exec(line);
	}
	return [...new Set(calls)];
}

function extractEffects(line: string): Array<{ edgeKind: AxiomFlowGraphEdgeKind; label: string }> {
	const effects: Array<{ edgeKind: AxiomFlowGraphEdgeKind; label: string }> = [];
	if (/\b(readFileSync|readFile|createReadStream|Bun\.file|Deno\.readTextFile|Deno\.readFile)\b/.test(line)) {
		effects.push({ edgeKind: "reads", label: `file-read:${extractStringArg(line) ?? "unknown"}` });
	}
	if (
		/\b(writeFileSync|writeFile|appendFile|createWriteStream|mkdir|rm|unlink|Deno\.writeTextFile|Deno\.writeFile)\b/.test(
			line,
		)
	) {
		effects.push({ edgeKind: "writes", label: `file-write:${extractStringArg(line) ?? "unknown"}` });
	}
	const envName = extractEnvName(line);
	if (/\bprocess\.env\b|\bDeno\.env\b/.test(line)) {
		effects.push({
			edgeKind: /\bprocess\.env\.[A-Za-z_$][\w$]*\s*=/.test(line) ? "writes" : "reads",
			label: `env:${envName ?? "unknown"}`,
		});
	}
	if (/\b(fetch|axios\.|http\.|https\.|request)\b/.test(line)) {
		effects.push({ edgeKind: "sends", label: `network:${extractStringArg(line) ?? "request"}` });
	}
	if (/\b(spawn|exec|execFile|fork|Bun\.spawn|Deno\.Command)\b/.test(line)) {
		effects.push({ edgeKind: "runs", label: `subprocess:${extractStringArg(line) ?? "command"}` });
	}
	if (/\b(prisma\.|db\.|database\.|query\s*\(|execute\s*\(|findMany\s*\(|insertOne\s*\(|collection\s*\()/.test(line)) {
		effects.push({ edgeKind: "sends", label: "database" });
	}
	if (/\b(globalThis\.|window\.|document\.|localStorage\.|sessionStorage\.)/.test(line)) {
		effects.push({ edgeKind: "mutates", label: "global-state" });
	}
	return effects;
}

function extractEvents(line: string): Array<{ edgeKind: AxiomFlowGraphEdgeKind; label: string }> {
	const events: Array<{ edgeKind: AxiomFlowGraphEdgeKind; label: string }> = [];
	if (/(\.on|addEventListener|subscribe)\s*\(/.test(line)) {
		events.push({ edgeKind: "listens", label: `event-listen:${extractStringArg(line) ?? "unknown"}` });
	}
	if (/(\.emit|dispatchEvent|dispatch|publish|fire)\s*\(/.test(line)) {
		events.push({ edgeKind: "emits", label: `event-emit:${extractStringArg(line) ?? "unknown"}` });
	}
	if (/\bhandle[A-Z]\w*\s*\(|\bon[A-Z]\w*\s*\(/.test(line)) {
		events.push({ edgeKind: "handles", label: "event-handler" });
	}
	return events;
}

function extractStringArg(line: string): string | undefined {
	const match = /["'`]([^"'`]{1,80})["'`]/.exec(line);
	return match?.[1];
}

function extractEnvName(line: string): string | undefined {
	return (
		/process\.env\.([A-Za-z_$][\w$]*)/.exec(line)?.[1] ??
		/process\.env\[['"`]([^'"`]+)['"`]\]/.exec(line)?.[1] ??
		/Deno\.env\.get\(['"`]([^'"`]+)['"`]\)/.exec(line)?.[1] ??
		/Deno\.env\.set\(['"`]([^'"`]+)['"`]\)/.exec(line)?.[1]
	);
}

function extractParamNames(signature: string): string[] {
	const match = /\(([^)]*)\)/.exec(signature);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((part) =>
			part
				.trim()
				.replace(/[?=].*$/, "")
				.replace(/:.*/, "")
				.trim(),
		)
		.map((part) => part.split(/\s+/).pop() ?? "")
		.filter((part) => /^[A-Za-z_$][\w$]*$/.test(part))
		.slice(0, 12);
}

function isDeclarationLine(line: string): boolean {
	if (
		/^(export\s+)?(async\s+)?function\b|^(export\s+)?(abstract\s+)?class\b|^(export\s+)?interface\b|^(export\s+)?type\b/.test(
			line,
		)
	) {
		return true;
	}
	return /^(public|private|protected|static|async|override|readonly|get|set|\s)*[A-Za-z_$][\w$]*\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/.test(
		line,
	);
}

function parseStackFrames(text: string): AxiomFlowStackFrame[] {
	const frames: AxiomFlowStackFrame[] = [];
	for (const raw of text.split(/\r?\n/)) {
		let match = /\(?((?:[A-Za-z]:)?[^()\s]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)\)?/.exec(raw);
		if (match) {
			frames.push({
				path: toPosix(match[1]),
				line: Number.parseInt(match[2], 10),
				column: Number.parseInt(match[3], 10),
				raw: raw.trim(),
			});
			continue;
		}
		match = /File "([^"]+\.py)", line (\d+)/.exec(raw);
		if (match) {
			frames.push({
				path: toPosix(match[1]),
				line: Number.parseInt(match[2], 10),
				raw: raw.trim(),
			});
		}
	}
	return frames.slice(0, 20);
}

function correlateStackFrames(
	graphs: Array<AxiomFlowGraph | undefined>,
	frames: AxiomFlowStackFrame[],
): AxiomFlowGraphNode[] {
	const correlated: AxiomFlowGraphNode[] = [];
	for (const frame of frames) {
		const framePath = toPosix(frame.path);
		for (const graph of graphs) {
			if (!graph) continue;
			const candidates = graph.nodes
				.filter((node) => node.path && framePath.endsWith(node.path))
				.filter((node) => node.kind !== "file");
			if (candidates.length === 0) continue;
			const line = frame.line ?? 0;
			const best = candidates
				.filter((node) => typeof node.line === "number" && (node.line ?? 0) <= line)
				.sort((a, b) => (b.line ?? 0) - (a.line ?? 0))[0];
			correlated.push(best ?? candidates[0]);
		}
	}
	return dedupeNodes(correlated).slice(0, 20);
}

function findNode(graph: AxiomFlowGraph, labelOrId: string): AxiomFlowGraphNode | undefined {
	const normalized = labelOrId.toLowerCase();
	return graph.nodes.find(
		(node) =>
			node.id === labelOrId ||
			node.label.toLowerCase() === normalized ||
			node.path?.toLowerCase() === normalized ||
			node.label.toLowerCase().includes(normalized) ||
			node.keywords.includes(normalized),
	);
}

function incidentEdges(graph: AxiomFlowGraph, nodeId: string): AxiomFlowGraphEdge[] {
	return graph.edges
		.filter((edge) => edge.fromId === nodeId || edge.toId === nodeId)
		.sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
}

function edgeNodes(graph: AxiomFlowGraph, edge: AxiomFlowGraphEdge): AxiomFlowGraphNode[] {
	return graph.nodes.filter((node) => node.id === edge.fromId || node.id === edge.toId);
}

function neighborNodes(graph: AxiomFlowGraph, nodeId: string, edges: AxiomFlowGraphEdge[]): AxiomFlowGraphNode[] {
	const ids = new Set(edges.map((edge) => (edge.fromId === nodeId ? edge.toId : edge.fromId)));
	return graph.nodes.filter((node) => ids.has(node.id));
}

function makeNode(
	kind: AxiomFlowGraphNodeKind,
	label: string,
	options: Partial<Omit<AxiomFlowGraphNode, "id" | "kind" | "label">>,
): AxiomFlowGraphNode {
	return {
		id: `fgn_${hash(`${kind}:${options.path ?? ""}:${options.line ?? ""}:${label}`, 18)}`,
		kind,
		label,
		path: options.path,
		language: options.language,
		line: options.line,
		summary: options.summary,
		keywords: [...new Set(options.keywords ?? tokenize(label))],
	};
}

function makeEdge(
	kind: AxiomFlowGraphEdgeKind,
	fromId: string,
	toId: string,
	label: string | undefined,
	line: number | undefined,
	weight: number,
): AxiomFlowGraphEdge {
	return {
		id: `fge_${hash(`${kind}:${fromId}:${toId}:${label ?? ""}:${line ?? ""}`, 18)}`,
		kind,
		fromId,
		toId,
		label,
		line,
		weight,
	};
}

function dedupeNodes(nodes: AxiomFlowGraphNode[]): AxiomFlowGraphNode[] {
	return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function dedupeEdges(edges: AxiomFlowGraphEdge[]): AxiomFlowGraphEdge[] {
	return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}

export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

function runShellCommand(options: {
	command: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(options.command, {
			cwd: options.cwd,
			env: process.env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const settle = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, exitCode, timedOut });
		};

		const abort = () => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		};

		const timer = setTimeout(abort, options.timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
			if (stdout.length > 64_000) stdout = tail(stdout, 64_000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
			if (stderr.length > 64_000) stderr = tail(stderr, 64_000);
		});
		child.on("error", (error) => {
			stderr += `\n${error instanceof Error ? error.message : String(error)}`;
			settle(null);
		});
		child.on("close", (code) => settle(code));
	});
}

function renderReport(graphs: AxiomFlowGraph[]): string {
	const out = ["# AXIOM Flow Graph Report", ""];
	out.push(`Graphs: ${graphs.length}`);
	out.push("");
	for (const graph of graphs) {
		out.push(`- ${graph.rootPath} (${graph.id})`);
		out.push(`  - files: ${graph.fileCount}, nodes: ${graph.nodeCount}, edges: ${graph.edgeCount}`);
	}
	return `${out.join("\n")}\n`;
}

function snippet(text: string, limit = 240): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function tail(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(text.length - limit);
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function hash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}
