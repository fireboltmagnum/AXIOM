import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AxiomConceptEdge, AxiomConceptEdgeType, AxiomConceptNodeKind } from "./RuntimeTypes.ts";

/**
 * Disk-backed store of directed edges between memory artifacts (skills and
 * reflections). Edges are derived signals — when a skill is captured for a
 * problem class that already has reflections, we write `addresses` edges so
 * the concept graph stops being a bag of independent counts and starts being
 * an actual graph.
 *
 * Layout:
 *   ~/.axiom/agent/concepts/edges.jsonl   # append-only
 *
 * Single JSONL is enough at this scale — recall pulls every edge into memory
 * and filters; if/when the graph grows past tens of thousands of edges we can
 * shard by problem class.
 */
export class ConceptEdgeStore {
	private readonly baseDir: string;
	private readonly edgesPath: string;
	private cached: AxiomConceptEdge[] | null = null;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "concepts");
		this.edgesPath = join(this.baseDir, "edges.jsonl");
	}

	private ensureDir(): boolean {
		try {
			if (!existsSync(this.baseDir)) {
				mkdirSync(this.baseDir, { recursive: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	private load(): AxiomConceptEdge[] {
		if (this.cached) return this.cached;
		if (!existsSync(this.edgesPath)) {
			this.cached = [];
			return this.cached;
		}
		try {
			const raw = readFileSync(this.edgesPath, "utf-8");
			const out: AxiomConceptEdge[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					out.push(JSON.parse(trimmed) as AxiomConceptEdge);
				} catch {
					// skip malformed
				}
			}
			this.cached = out;
		} catch {
			this.cached = [];
		}
		return this.cached;
	}

	/** Append a new edge. De-duplicates on (type, fromId, toId). */
	add(edge: AxiomConceptEdge): boolean {
		if (!this.ensureDir()) return false;
		const existing = this.load();
		if (
			existing.some(
				(e) =>
					e.type === edge.type && e.fromKind === edge.fromKind && e.fromId === edge.fromId && e.toId === edge.toId,
			)
		) {
			return false;
		}
		try {
			const line = `${JSON.stringify(edge)}\n`;
			if (existsSync(this.edgesPath)) {
				const current = readFileSync(this.edgesPath, "utf-8");
				writeFileSync(this.edgesPath, current + line, "utf-8");
			} else {
				writeFileSync(this.edgesPath, line, "utf-8");
			}
			existing.push(edge);
			return true;
		} catch {
			return false;
		}
	}

	/** All edges touching the given problem class. */
	forProblemClass(problemClass: string): AxiomConceptEdge[] {
		const cls = problemClass.trim();
		if (!cls) return [];
		return this.load().filter((e) => e.problemClass === cls);
	}

	/** All edges incident to a specific node (either endpoint). */
	forNode(kind: AxiomConceptNodeKind, id: string): AxiomConceptEdge[] {
		return this.load().filter(
			(e) => (e.fromKind === kind && e.fromId === id) || (e.toKind === kind && e.toId === id),
		);
	}

	/** Edges by type, optionally filtered to a problem class. */
	byType(type: AxiomConceptEdgeType, problemClass?: string): AxiomConceptEdge[] {
		const edges = this.load().filter((e) => e.type === type);
		if (!problemClass) return edges;
		return edges.filter((e) => e.problemClass === problemClass);
	}

	all(): AxiomConceptEdge[] {
		return [...this.load()];
	}

	clearCache(): void {
		this.cached = null;
	}
}
