import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AxiomSkill, AxiomSkillOutcome, AxiomSkillRecallHit } from "./RuntimeTypes.ts";

/**
 * Laplace-smoothed confidence: a brand-new skill (0/0) gets 0.5, not 1.0, so it
 * doesn't immediately outrank a battle-tested one. After many trials the value
 * converges on the true success rate.
 */
function laplaceConfidence(skill: AxiomSkill): number {
	const successes = skill.successCount ?? 0;
	const recalls = skill.recallCount ?? 0;
	return (successes + 1) / (recalls + 2);
}

/**
 * Auto-captured procedural-skill store. Counterpart to {@link ReflexionStore} but
 * keyed on success rather than failure. Each skill records how a task class was
 * solved (tools used in order, step count, original framing) so future similar
 * tasks can be nudged toward the same approach.
 *
 * Layout:
 *   ~/.axiom/agent/skills/auto/
 *     index.jsonl                       # append-only scan index
 *     <id>.md                           # full skill, browsable + greppable
 *
 * The /auto/ subdirectory deliberately isolates machine-written skills from any
 * user-curated ones in ~/.axiom/agent/skills/. We never touch the parent dir.
 */
export class SkillStore {
	private readonly baseDir: string;
	private readonly indexPath: string;
	private cachedIndex: AxiomSkill[] | null = null;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "skills", "auto");
		this.indexPath = join(this.baseDir, "index.jsonl");
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

	private loadIndex(): AxiomSkill[] {
		if (this.cachedIndex) {
			return this.cachedIndex;
		}
		if (!existsSync(this.indexPath)) {
			this.cachedIndex = [];
			return this.cachedIndex;
		}
		try {
			const raw = readFileSync(this.indexPath, "utf-8");
			const entries: AxiomSkill[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					entries.push(JSON.parse(trimmed) as AxiomSkill);
				} catch {
					// skip malformed lines
				}
			}
			this.cachedIndex = entries;
		} catch {
			this.cachedIndex = [];
		}
		return this.cachedIndex;
	}

	/** Save a new skill. Best-effort; returns false on storage failure. */
	save(skill: AxiomSkill): boolean {
		if (!this.ensureDir()) return false;
		try {
			const mdPath = join(this.baseDir, `${skill.id}.md`);
			writeFileSync(mdPath, renderMarkdown(skill), "utf-8");
			const indexLine = `${JSON.stringify(skill)}\n`;
			if (existsSync(this.indexPath)) {
				const current = readFileSync(this.indexPath, "utf-8");
				writeFileSync(this.indexPath, current + indexLine, "utf-8");
			} else {
				writeFileSync(this.indexPath, indexLine, "utf-8");
			}
			if (this.cachedIndex) {
				this.cachedIndex.push(skill);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Top-k skills whose keywords overlap with the query. Same task-kind gets a
	 * small boost; recency provides a tie-breaker so freshly-learned approaches
	 * surface first. Mirrors ReflexionStore.recall but does not mix the two —
	 * skills and reflections serve opposite purposes in the prompt.
	 */
	recall(options: { keywords: string[]; taskKind: string; limit: number }): AxiomSkillRecallHit[] {
		const { keywords, taskKind, limit } = options;
		if (limit <= 0) return [];
		const haystack = this.loadIndex();
		if (haystack.length === 0) return [];

		const queryKeywords = new Set(keywords.map((k) => k.toLowerCase()).filter(Boolean));
		if (queryKeywords.size === 0) return [];

		const now = Date.now();
		const hits: AxiomSkillRecallHit[] = [];
		for (const skill of haystack) {
			const skillKeywords = skill.keywords.map((k) => k.toLowerCase());
			const matched = skillKeywords.filter((k) => queryKeywords.has(k));
			if (matched.length === 0) continue;

			let score = matched.length;
			if (skill.taskKind === taskKind) score += 1;
			const ageDays = (now - Date.parse(skill.timestamp)) / (1000 * 60 * 60 * 24);
			if (Number.isFinite(ageDays)) {
				if (ageDays < 7) score += 0.5;
				else if (ageDays < 30) score += 0.25;
			}
			// Confidence multiplier: a skill recalled 10 times that succeeded 9 of them
			// outranks an equally-keyword-matching skill that succeeded once and failed
			// twice. Brand-new skills sit at 0.5 (Laplace prior) so they get a fair
			// chance to prove themselves without dominating.
			score *= laplaceConfidence(skill);
			hits.push({ skill, score, matchedKeywords: matched });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	/**
	 * Update outcome counters for a batch of recalled skills. Best-effort; a
	 * disk write failure just leaves the prior counters in place. The on-disk
	 * `.md` files are not rewritten — counters live in the JSONL index only, so
	 * `rebuildIndex()` will reset them (deliberate: the markdown body is the
	 * human archive, the index is the running tally).
	 *
	 * Returns the number of skills actually mutated.
	 */
	updateOutcome(ids: readonly string[], outcome: AxiomSkillOutcome): number {
		if (ids.length === 0) return 0;
		const index = this.loadIndex();
		if (index.length === 0) return 0;
		const idSet = new Set(ids);
		const now = new Date().toISOString();
		let mutated = 0;
		for (const skill of index) {
			if (!idSet.has(skill.id)) continue;
			if (outcome === "recall") {
				skill.recallCount = (skill.recallCount ?? 0) + 1;
			} else if (outcome === "success") {
				skill.successCount = (skill.successCount ?? 0) + 1;
			} else if (outcome === "failure") {
				skill.failureCount = (skill.failureCount ?? 0) + 1;
			}
			skill.lastUsedAt = now;
			mutated++;
		}
		if (mutated === 0) return 0;
		this.flushIndex(index);
		return mutated;
	}

	/** Rewrite index.jsonl from the in-memory cache. Best-effort. */
	private flushIndex(entries: AxiomSkill[]): void {
		if (!this.ensureDir()) return;
		try {
			const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
			writeFileSync(this.indexPath, body, "utf-8");
			this.cachedIndex = entries;
		} catch {
			// Counters are best-effort; a single failed flush just delays the next
			// update. The in-memory cache still reflects the new values for this
			// process, so subsequent recalls within the session see the new score.
		}
	}

	/** Test/debug: list all skills. */
	all(): AxiomSkill[] {
		return [...this.loadIndex()];
	}

	/** Test/debug: clear the in-memory cache. */
	clearCache(): void {
		this.cachedIndex = null;
	}

	/** Rebuild the index from the on-disk *.md files (handles external edits). */
	rebuildIndex(): boolean {
		if (!this.ensureDir()) return false;
		try {
			const files = readdirSync(this.baseDir);
			const entries: AxiomSkill[] = [];
			for (const file of files) {
				if (!file.endsWith(".md")) continue;
				const parsed = parseMarkdown(readFileSync(join(this.baseDir, file), "utf-8"));
				if (parsed) entries.push(parsed);
			}
			entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
			writeFileSync(
				this.indexPath,
				entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
				"utf-8",
			);
			this.cachedIndex = entries;
			return true;
		} catch {
			return false;
		}
	}
}

function renderMarkdown(s: AxiomSkill): string {
	const fm: string[] = ["---"];
	fm.push(`id: ${s.id}`);
	fm.push(`timestamp: ${s.timestamp}`);
	fm.push(`task_kind: ${s.taskKind}`);
	fm.push(`domain: ${s.domain}`);
	fm.push(`complexity: ${s.complexity}`);
	fm.push(`step_count: ${s.stepCount}`);
	fm.push(`tools_used: ${s.toolsUsed.join(", ")}`);
	fm.push(`problem_class: ${s.problemClass.join(", ")}`);
	fm.push(`keywords: ${s.keywords.join(", ")}`);
	if (s.sourceTraceId) fm.push(`source_trace: ${s.sourceTraceId}`);
	fm.push("---");
	fm.push("");
	fm.push(`# ${s.title}`);
	fm.push("");
	fm.push("# Approach");
	fm.push("");
	fm.push(
		`Solved a ${s.taskKind} task in ${s.domain} (complexity ${s.complexity}) using ${
			s.toolsUsed.length > 0 ? s.toolsUsed.join(", ") : "no tools"
		} across ${s.stepCount} step(s).`,
	);
	fm.push("");
	fm.push("# Original prompt (snippet)");
	fm.push("");
	fm.push(s.taskSnippet);
	fm.push("");
	return fm.join("\n");
}

function parseMarkdown(text: string): AxiomSkill | null {
	const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
	if (!fmMatch) return null;
	const fm = fmMatch[1];
	const body = fmMatch[2];
	const meta = new Map<string, string>();
	for (const line of fm.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) meta.set(key, value);
	}
	const id = meta.get("id");
	const timestamp = meta.get("timestamp");
	const taskKind = meta.get("task_kind") as AxiomSkill["taskKind"] | undefined;
	if (!id || !timestamp || !taskKind) return null;

	const list = (raw: string | undefined): string[] =>
		(raw ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

	const num = (raw: string | undefined, fallback: number): number => {
		const n = Number.parseInt(raw ?? "", 10);
		return Number.isFinite(n) ? n : fallback;
	};

	const titleMatch = /^#\s+([^\n]+)/m.exec(body);
	const sectionRe = /^#\s+([A-Za-z ()]+)\s*\n+([\s\S]*?)(?=\n#\s|$)/gm;
	const sections = new Map<string, string>();
	let m: RegExpExecArray | null = sectionRe.exec(body);
	while (m) {
		sections.set(m[1].trim().toLowerCase(), m[2].trim());
		m = sectionRe.exec(body);
	}

	return {
		id,
		timestamp,
		taskKind,
		domain: meta.get("domain") ?? "general",
		complexity: num(meta.get("complexity"), 0),
		stepCount: num(meta.get("step_count"), 0),
		toolsUsed: list(meta.get("tools_used")),
		problemClass: list(meta.get("problem_class")),
		keywords: list(meta.get("keywords")),
		sourceTraceId: meta.get("source_trace"),
		title: titleMatch ? titleMatch[1].trim() : "Auto-captured skill",
		taskSnippet: sections.get("original prompt (snippet)") ?? "",
	};
}
