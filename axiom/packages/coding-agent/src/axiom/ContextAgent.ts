import { CodeGraphStore } from "./CodeGraphStore.ts";
import { CodeUnderstandingStore } from "./CodeUnderstandingStore.ts";
import { ConceptEdgeStore } from "./ConceptEdgeStore.ts";
import { FlowGraphStore } from "./FlowGraphStore.ts";
import { KnowledgeGraphStore } from "./KnowledgeGraphStore.ts";
import { ReflexionStore } from "./ReflexionStore.ts";
import type {
	AxiomCodeGraphHit,
	AxiomConceptEdge,
	AxiomConceptSummary,
	AxiomFlowGraphHit,
	AxiomKnowledgeGraphHit,
	AxiomReflection,
	AxiomReflectionRecallHit,
	AxiomSkill,
	AxiomSkillRecallHit,
	AxiomSparseTreeGrepHit,
	AxiomUnderstandingRecallHit,
} from "./RuntimeTypes.ts";
import { SkillStore } from "./SkillStore.ts";
import { SparseTreeGrepStore } from "./SparseTreeGrepStore.ts";

/**
 * Persistent Context Agent (CA) — unified cognitive memory facade.
 *
 * Wraps the disk-backed reflection and skill stores and exposes a single
 * `recall()` that returns failures, successes, and aggregated *concept
 * summaries* in one call. Concepts here are not stored separately; they are
 * derived at query time by grouping reflection/skill entries that share a
 * problem_class label. This keeps the substrate cheap while still giving the
 * "we've seen this problem class N times" signal the paper calls for.
 *
 * Why a facade instead of just calling the stores directly:
 *   1. Single keyword expansion / scoring pipeline used by everything that
 *      wants past context.
 *   2. Drop-in spot to add new memory types (sessions, agent prefs, concept
 *      nodes with edges) without changing call sites.
 *   3. Lets us swap the backing storage later (e.g., to a real graph DB) with
 *      no surface-area churn.
 *
 * Retrieval stays local and deterministic where possible. SparseTreeGrep may
 * add optional local embeddings for long-document reranking when the optional
 * embedder dependency is installed; it falls back to lexical search otherwise.
 */
export class ContextAgent {
	private readonly reflexion: ReflexionStore;
	private readonly skills: SkillStore;
	private readonly edges: ConceptEdgeStore;
	private readonly understandings: CodeUnderstandingStore;
	private readonly codeGraphs: CodeGraphStore;
	private readonly flowGraphs: FlowGraphStore;
	private readonly knowledge: KnowledgeGraphStore;
	private readonly sparseTreeGrep: SparseTreeGrepStore;

	constructor(options?: {
		reflexion?: ReflexionStore;
		skills?: SkillStore;
		edges?: ConceptEdgeStore;
		understandings?: CodeUnderstandingStore;
		codeGraphs?: CodeGraphStore;
		flowGraphs?: FlowGraphStore;
		knowledge?: KnowledgeGraphStore;
		sparseTreeGrep?: SparseTreeGrepStore;
	}) {
		this.reflexion = options?.reflexion ?? new ReflexionStore();
		this.skills = options?.skills ?? new SkillStore();
		this.edges = options?.edges ?? new ConceptEdgeStore();
		this.understandings = options?.understandings ?? new CodeUnderstandingStore();
		this.codeGraphs = options?.codeGraphs ?? new CodeGraphStore();
		this.flowGraphs = options?.flowGraphs ?? new FlowGraphStore();
		this.knowledge = options?.knowledge ?? new KnowledgeGraphStore();
		this.sparseTreeGrep = options?.sparseTreeGrep ?? new SparseTreeGrepStore();
	}

	get reflexionStore(): ReflexionStore {
		return this.reflexion;
	}

	get skillStore(): SkillStore {
		return this.skills;
	}

	get edgeStore(): ConceptEdgeStore {
		return this.edges;
	}

	get understandingStore(): CodeUnderstandingStore {
		return this.understandings;
	}

	get codeGraphStore(): CodeGraphStore {
		return this.codeGraphs;
	}

	get flowGraphStore(): FlowGraphStore {
		return this.flowGraphs;
	}

	get knowledgeGraphStore(): KnowledgeGraphStore {
		return this.knowledge;
	}

	get sparseTreeGrepStore(): SparseTreeGrepStore {
		return this.sparseTreeGrep;
	}

	/**
	 * Create `addresses` edges from a newly-saved skill to every reflection that
	 * shares any of its problem classes. Idempotent: the edge store de-dupes on
	 * (type, fromId, toId).
	 */
	linkSkillToReflections(skill: AxiomSkill): number {
		if (skill.problemClass.length === 0) return 0;
		const skillClasses = new Set(skill.problemClass.map((c) => c.trim()).filter(Boolean));
		if (skillClasses.size === 0) return 0;
		const now = new Date().toISOString();
		let added = 0;
		for (const r of this.reflexion.all() as AxiomReflection[]) {
			for (const rawCls of r.problemClass) {
				const cls = rawCls.trim();
				if (!skillClasses.has(cls)) continue;
				const ok = this.edges.add({
					id: `${skill.id}:${r.id}:addresses`,
					type: "addresses",
					fromKind: "skill",
					fromId: skill.id,
					toKind: "reflection",
					toId: r.id,
					problemClass: cls,
					timestamp: now,
				});
				if (ok) added++;
			}
		}
		return added;
	}

	/**
	 * Inverse of {@link linkSkillToReflections}: when a new reflection lands, wire
	 * up `addresses` edges from every existing skill in the same problem class
	 * (those skills are candidate corrections for this newly-recorded failure).
	 */
	linkReflectionToSkills(reflection: AxiomReflection): number {
		if (reflection.problemClass.length === 0) return 0;
		const reflectionClasses = new Set(reflection.problemClass.map((c) => c.trim()).filter(Boolean));
		if (reflectionClasses.size === 0) return 0;
		const now = new Date().toISOString();
		let added = 0;
		for (const s of this.skills.all() as AxiomSkill[]) {
			for (const rawCls of s.problemClass) {
				const cls = rawCls.trim();
				if (!reflectionClasses.has(cls)) continue;
				const ok = this.edges.add({
					id: `${s.id}:${reflection.id}:addresses`,
					type: "addresses",
					fromKind: "skill",
					fromId: s.id,
					toKind: "reflection",
					toId: reflection.id,
					problemClass: cls,
					timestamp: now,
				});
				if (ok) added++;
			}
		}
		return added;
	}

	/**
	 * Unified recall across all memory types for a task. Each sub-recall is
	 * capped independently (the caller controls relative weighting via the
	 * three `limit*` knobs). All results are best-effort — failures of the
	 * underlying stores degrade silently to empty arrays.
	 */
	async recall(options: {
		keywords: string[];
		taskKind: string;
		limitReflections: number;
		limitSkills: number;
		limitUnderstandings: number;
		limitCodeGraphs: number;
		limitFlowGraphs: number;
		limitKnowledgeGraph: number;
		limitSparseTreeGrep: number;
		limitConcepts: number;
	}): Promise<{
		reflections: AxiomReflectionRecallHit[];
		skills: AxiomSkillRecallHit[];
		understandings: AxiomUnderstandingRecallHit[];
		codeGraphs: AxiomCodeGraphHit[];
		flowGraphs: AxiomFlowGraphHit[];
		knowledge: AxiomKnowledgeGraphHit[];
		sparseTreeGrep: AxiomSparseTreeGrepHit[];
		concepts: AxiomConceptSummary[];
	}> {
		const {
			keywords,
			taskKind,
			limitReflections,
			limitSkills,
			limitUnderstandings,
			limitCodeGraphs,
			limitFlowGraphs,
			limitKnowledgeGraph,
			limitSparseTreeGrep,
			limitConcepts,
		} = options;

		const reflections =
			limitReflections > 0 ? this.reflexion.recall({ keywords, taskKind, limit: limitReflections }) : [];

		const skills = limitSkills > 0 ? this.skills.recall({ keywords, taskKind, limit: limitSkills }) : [];

		const understandings =
			limitUnderstandings > 0 ? this.understandings.recall({ keywords, limit: limitUnderstandings }) : [];

		const codeGraphs =
			limitCodeGraphs > 0 ? this.codeGraphs.search(keywords.join(" "), { limit: limitCodeGraphs }) : [];

		const flowGraphs =
			limitFlowGraphs > 0 ? this.flowGraphs.search(keywords.join(" "), { limit: limitFlowGraphs }) : [];

		const knowledge = limitKnowledgeGraph > 0 ? this.knowledge.search(keywords.join(" "), limitKnowledgeGraph) : [];

		const sparseTreeGrep =
			limitSparseTreeGrep > 0
				? await this.sparseTreeGrep.searchReranked(keywords.join(" "), { limit: limitSparseTreeGrep })
				: [];

		const concepts = limitConcepts > 0 ? this.aggregateConcepts({ keywords, limit: limitConcepts }) : [];

		return { reflections, skills, understandings, codeGraphs, flowGraphs, knowledge, sparseTreeGrep, concepts };
	}

	/**
	 * Scan reflection + skill indices and aggregate by problem_class label.
	 * Each unique problem-class string becomes a concept summary with the
	 * artifacts that mention it. Score = total references + keyword overlap
	 * with the query so the most relevant concepts surface first.
	 */
	aggregateConcepts(options: { keywords: string[]; limit: number }): AxiomConceptSummary[] {
		const { keywords, limit } = options;
		if (limit <= 0) return [];
		const queryKeywords = new Set(keywords.map((k) => k.toLowerCase()).filter(Boolean));

		const buckets = new Map<
			string,
			{
				problemClass: string;
				reflectionIds: string[];
				skillIds: string[];
				lastSeen: string;
				keywordOverlap: number;
			}
		>();

		const ingest = (
			id: string,
			source: "reflection" | "skill",
			problemClasses: string[],
			itemKeywords: string[],
			timestamp: string,
		): void => {
			if (problemClasses.length === 0) return;
			const overlapCount = itemKeywords.filter((k) => queryKeywords.has(k.toLowerCase())).length;

			for (const rawClass of problemClasses) {
				const cls = rawClass.trim();
				if (!cls) continue;
				let entry = buckets.get(cls);
				if (!entry) {
					entry = {
						problemClass: cls,
						reflectionIds: [],
						skillIds: [],
						lastSeen: timestamp,
						keywordOverlap: 0,
					};
					buckets.set(cls, entry);
				}
				if (source === "reflection") entry.reflectionIds.push(id);
				else entry.skillIds.push(id);
				if (timestamp > entry.lastSeen) entry.lastSeen = timestamp;
				entry.keywordOverlap = Math.max(entry.keywordOverlap, overlapCount);
			}
		};

		for (const r of this.reflexion.all() as AxiomReflection[]) {
			ingest(r.id, "reflection", r.problemClass, r.keywords, r.timestamp);
		}
		for (const s of this.skills.all() as AxiomSkill[]) {
			ingest(s.id, "skill", s.problemClass, s.keywords, s.timestamp);
		}

		const summaries: AxiomConceptSummary[] = [];
		for (const b of buckets.values()) {
			const totalReferences = b.reflectionIds.length + b.skillIds.length;
			const edges = this.edges.forProblemClass(b.problemClass);
			// Score: keyword overlap with the query dominates; total references is a
			// tie-breaker so well-trodden concepts surface above one-offs. Edges add a
			// small bonus — a concept where past failures got corrected by past
			// skills is structurally richer than two isolated tallies.
			const score = b.keywordOverlap * 10 + totalReferences + edges.length;
			if (score <= 0) continue;
			summaries.push({
				problemClass: b.problemClass,
				reflectionIds: b.reflectionIds,
				skillIds: b.skillIds,
				totalReferences,
				lastSeen: b.lastSeen,
				score,
				edges,
			});
		}

		summaries.sort((a, b) => b.score - a.score || b.totalReferences - a.totalReferences);
		return summaries.slice(0, limit);
	}

	/** Test/debug: clear caches across all backing stores. */
	clearCaches(): void {
		this.edges.clearCache();
		this.understandings.clearCache();
		this.codeGraphs.clearCache();
		this.flowGraphs.clearCache();
		this.knowledge.clearCache();
		this.sparseTreeGrep.clearCache();
	}
}

// Type-only re-export to keep `AxiomConceptEdge` reachable from the facade.
export type { AxiomConceptEdge };
