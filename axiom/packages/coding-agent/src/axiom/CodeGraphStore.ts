import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { analyzeFile, languageForPath } from "./CodeAnalyzer.ts";
import type {
	AxiomCodeGraph,
	AxiomCodeGraphEdge,
	AxiomCodeGraphHit,
	AxiomCodeGraphNode,
	AxiomCodeGraphNodeKind,
	AxiomFileUnderstanding,
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

export interface CodeGraphIndexOptions {
	path: string;
	maxFiles?: number;
	maxBytesPerFile?: number;
}

export interface CodeGraphPathResult {
	graph: AxiomCodeGraph;
	nodes: AxiomCodeGraphNode[];
	edges: AxiomCodeGraphEdge[];
}

/**
 * Native Graphify-style code graph.
 *
 * `understand_code` answers "what is inside these files?". `code_graph` answers
 * "how are these files/symbols/modules connected?" and persists that map for
 * Context Agent recall.
 */
export class CodeGraphStore {
	private readonly baseDir: string;
	private readonly graphsDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? path.join(homedir(), ".axiom", "agent", "code-graphs");
		this.graphsDir = path.join(this.baseDir, "graphs");
	}

	index(options: CodeGraphIndexOptions): AxiomCodeGraph {
		const rootPath = path.resolve(options.path);
		if (!existsSync(rootPath)) throw new Error(`Path not found: ${rootPath}`);
		const maxFiles = Math.max(1, Math.min(1000, Math.floor(options.maxFiles ?? 250)));
		const maxBytesPerFile = Math.max(1000, Math.floor(options.maxBytesPerFile ?? 250_000));
		const files = collectSourceFiles(rootPath, { maxFiles, maxBytesPerFile });
		const rootForRel = statSync(rootPath).isDirectory() ? rootPath : path.dirname(rootPath);
		const understandings: AxiomFileUnderstanding[] = files.map((file) =>
			analyzeFile(toPosix(path.relative(rootForRel, file) || path.basename(file)), readFileSync(file, "utf-8")),
		);

		const graphId = `cg_${hash(`${rootPath}:${files.length}:${understandings.map((f) => f.path).join("|")}`, 18)}`;
		const { nodes, edges } = buildGraph(understandings);
		const graph: AxiomCodeGraph = {
			id: graphId,
			timestamp: new Date().toISOString(),
			rootPath: toPosix(path.relative(process.cwd(), rootPath) || rootPath),
			fileCount: understandings.length,
			nodeCount: nodes.length,
			edgeCount: edges.length,
			nodes,
			edges,
			keywords: [...new Set(nodes.flatMap((node) => node.keywords))].slice(0, 600),
		};
		this.save(graph);
		return graph;
	}

	search(query: string, options?: { graphId?: string; limit?: number }): AxiomCodeGraphHit[] {
		const tokens = tokenize(query);
		if (tokens.length === 0) return [];
		const limit = Math.max(1, Math.min(50, Math.floor(options?.limit ?? 8)));
		const graphs = options?.graphId ? [this.load(options.graphId)].filter(Boolean) : this.list();
		const hits: AxiomCodeGraphHit[] = [];
		for (const graph of graphs) {
			if (!graph) continue;
			for (const node of graph.nodes) {
				const nodeTerms = new Set([...node.keywords, ...tokenize(node.label), ...tokenize(node.path ?? "")]);
				const matched = tokens.filter((token) => nodeTerms.has(token));
				if (matched.length === 0) continue;
				const incident = incidentEdges(graph, node.id).slice(0, 12);
				const neighbors = neighborNodes(graph, node.id, incident);
				const kindBoost = node.kind === "symbol" ? 2 : node.kind === "file" ? 1 : 0;
				hits.push({
					graph,
					score: matched.length * 5 + incident.length * 0.2 + kindBoost,
					matchedKeywords: [...new Set(matched)],
					nodes: [node, ...neighbors],
					edges: incident,
				});
			}
		}
		hits.sort((a, b) => b.score - a.score || a.nodes[0]?.label.localeCompare(b.nodes[0]?.label ?? "") || 0);
		return hits.slice(0, limit);
	}

	neighbors(graphId: string, nodeLabelOrId: string, limit = 20): AxiomCodeGraphHit | undefined {
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

	path(graphId: string, fromLabelOrId: string, toLabelOrId: string, maxDepth = 5): CodeGraphPathResult | undefined {
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
						.filter((candidate): candidate is AxiomCodeGraphEdge => candidate !== undefined);
					const nodeIds = new Set([start.id, goal.id, ...edges.flatMap((edge) => [edge.fromId, edge.toId])]);
					return { graph, nodes: graph.nodes.filter((node) => nodeIds.has(node.id)), edges };
				}
				queue.push({ nodeId: nextId, edgeIds: nextEdgeIds, seen: new Set([...current.seen, nextId]) });
			}
		}
		return undefined;
	}

	stats(): { graphCount: number; fileCount: number; nodeCount: number; edgeCount: number } {
		const graphs = this.list();
		return {
			graphCount: graphs.length,
			fileCount: graphs.reduce((sum, graph) => sum + graph.fileCount, 0),
			nodeCount: graphs.reduce((sum, graph) => sum + graph.nodeCount, 0),
			edgeCount: graphs.reduce((sum, graph) => sum + graph.edgeCount, 0),
		};
	}

	list(): AxiomCodeGraph[] {
		if (!existsSync(this.graphsDir)) return [];
		const graphs: AxiomCodeGraph[] = [];
		for (const file of readdirSync(this.graphsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				graphs.push(JSON.parse(readFileSync(path.join(this.graphsDir, file), "utf-8")) as AxiomCodeGraph);
			} catch {
				// skip malformed graph
			}
		}
		graphs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return graphs;
	}

	load(graphId: string): AxiomCodeGraph | undefined {
		const graphPath = path.join(this.graphsDir, `${graphId}.json`);
		if (!existsSync(graphPath)) return undefined;
		try {
			return JSON.parse(readFileSync(graphPath, "utf-8")) as AxiomCodeGraph;
		} catch {
			return undefined;
		}
	}

	require(graphId: string): AxiomCodeGraph {
		const graph = this.load(graphId);
		if (!graph) throw new Error(`Code graph not found: ${graphId}`);
		return graph;
	}

	clearCache(): void {
		// File-backed store has no cache yet.
	}

	private save(graph: AxiomCodeGraph): void {
		if (!existsSync(this.graphsDir)) mkdirSync(this.graphsDir, { recursive: true });
		writeFileSync(path.join(this.graphsDir, `${graph.id}.json`), `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
		writeFileSync(path.join(this.baseDir, "GRAPH_REPORT.md"), renderReport(this.list()), "utf-8");
	}
}

function buildGraph(files: AxiomFileUnderstanding[]): { nodes: AxiomCodeGraphNode[]; edges: AxiomCodeGraphEdge[] } {
	const nodes: AxiomCodeGraphNode[] = [];
	const edges: AxiomCodeGraphEdge[] = [];
	const fileNodeByPath = new Map<string, AxiomCodeGraphNode>();
	const externalNodeByLabel = new Map<string, AxiomCodeGraphNode>();

	for (const file of files) {
		const fileNode = makeNode("file", file.path, {
			path: file.path,
			language: file.language,
			keywords: [...tokenize(file.path), file.language],
		});
		nodes.push(fileNode);
		fileNodeByPath.set(file.path, fileNode);
		for (const symbol of file.symbols) {
			const symbolNode = makeSymbolNode(file, symbol);
			nodes.push(symbolNode);
			edges.push(makeEdge("contains", fileNode.id, symbolNode.id, symbol.kind, 1));
			if (symbol.exported) edges.push(makeEdge("exports", fileNode.id, symbolNode.id, symbol.name, 1));
		}
	}

	for (const file of files) {
		const fileNode = fileNodeByPath.get(file.path);
		if (!fileNode) continue;
		for (const imported of file.imports) {
			const localTarget = resolveLocalImport(file.path, imported, fileNodeByPath);
			if (localTarget) {
				edges.push(makeEdge("imports", fileNode.id, localTarget.id, imported, 1));
				continue;
			}
			let moduleNode = externalNodeByLabel.get(imported);
			if (!moduleNode) {
				moduleNode = makeNode("external", imported, { keywords: tokenize(imported) });
				externalNodeByLabel.set(imported, moduleNode);
				nodes.push(moduleNode);
			}
			edges.push(makeEdge("imports", fileNode.id, moduleNode.id, imported, 0.5));
		}
	}

	return { nodes: dedupeNodes(nodes), edges: dedupeEdges(edges) };
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

function makeSymbolNode(file: AxiomFileUnderstanding, symbol: AxiomSymbolEntry): AxiomCodeGraphNode {
	return makeNode("symbol", symbol.name, {
		path: file.path,
		language: file.language,
		line: symbol.line,
		symbolKind: symbol.kind,
		keywords: [...tokenize(symbol.name), ...tokenize(file.path), symbol.kind, file.language],
	});
}

function makeNode(
	kind: AxiomCodeGraphNodeKind,
	label: string,
	options: Partial<Omit<AxiomCodeGraphNode, "id" | "kind" | "label">>,
): AxiomCodeGraphNode {
	return {
		id: `cgn_${hash(`${kind}:${options.path ?? ""}:${label}:${options.line ?? ""}`, 18)}`,
		kind,
		label,
		path: options.path,
		language: options.language,
		symbolKind: options.symbolKind,
		line: options.line,
		keywords: [...new Set(options.keywords ?? tokenize(label))],
	};
}

function makeEdge(
	kind: AxiomCodeGraphEdge["kind"],
	fromId: string,
	toId: string,
	label: string,
	weight: number,
): AxiomCodeGraphEdge {
	return {
		id: `cge_${hash(`${kind}:${fromId}:${toId}:${label}`, 18)}`,
		kind,
		fromId,
		toId,
		label,
		weight,
	};
}

function resolveLocalImport(
	sourceFilePath: string,
	imported: string,
	fileNodeByPath: Map<string, AxiomCodeGraphNode>,
): AxiomCodeGraphNode | undefined {
	if (!imported.startsWith(".")) return undefined;
	const sourceDir = path.posix.dirname(sourceFilePath);
	const base = path.posix.normalize(path.posix.join(sourceDir, imported));
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		`${base}.py`,
		`${base}/index.ts`,
		`${base}/index.tsx`,
		`${base}/index.js`,
		`${base}/index.jsx`,
	];
	for (const candidate of candidates) {
		const node = fileNodeByPath.get(candidate);
		if (node) return node;
	}
	return undefined;
}

function findNode(graph: AxiomCodeGraph, labelOrId: string): AxiomCodeGraphNode | undefined {
	const normalized = labelOrId.toLowerCase();
	return graph.nodes.find(
		(node) =>
			node.id === labelOrId || node.label.toLowerCase() === normalized || node.path?.toLowerCase() === normalized,
	);
}

function incidentEdges(graph: AxiomCodeGraph, nodeId: string): AxiomCodeGraphEdge[] {
	return graph.edges
		.filter((edge) => edge.fromId === nodeId || edge.toId === nodeId)
		.sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
}

function neighborNodes(graph: AxiomCodeGraph, nodeId: string, edges: AxiomCodeGraphEdge[]): AxiomCodeGraphNode[] {
	const ids = new Set(edges.map((edge) => (edge.fromId === nodeId ? edge.toId : edge.fromId)));
	return graph.nodes.filter((node) => ids.has(node.id));
}

function dedupeNodes(nodes: AxiomCodeGraphNode[]): AxiomCodeGraphNode[] {
	return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function dedupeEdges(edges: AxiomCodeGraphEdge[]): AxiomCodeGraphEdge[] {
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

function renderReport(graphs: AxiomCodeGraph[]): string {
	const out = ["# AXIOM Code Graph Report", ""];
	out.push(`Graphs: ${graphs.length}`);
	out.push("");
	for (const graph of graphs) {
		out.push(`- ${graph.rootPath} (${graph.id})`);
		out.push(`  - files: ${graph.fileCount}, nodes: ${graph.nodeCount}, edges: ${graph.edgeCount}`);
	}
	return `${out.join("\n")}\n`;
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function hash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}
