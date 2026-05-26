import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AxiomReflection, AxiomReflectionRecallHit } from "./RuntimeTypes.ts";

/**
 * Persistent failure-memory store. Reflections are written as markdown files with
 * YAML-ish frontmatter so a human can browse them and grep stays useful. Retrieval
 * is keyword-overlap + task-kind filtering, deliberately not embedding-based.
 *
 * Layout:
 *   ~/.axiom/agent/reflections/
 *     index.jsonl                       # append-only index (one JSON per line)
 *     <id>.md                           # full reflection per file
 *
 * The index lets recall scan ~thousands of reflections without opening each file.
 * Full-text grep against the markdown bodies is available too but kept out of the
 * hot path.
 */
export class ReflexionStore {
	private readonly baseDir: string;
	private readonly indexPath: string;
	private cachedIndex: AxiomReflection[] | null = null;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "reflections");
		this.indexPath = join(this.baseDir, "index.jsonl");
	}

	/** Ensure the storage directory exists. Idempotent. Errors are swallowed —
	 * Reflexion is best-effort and must not crash the agent. */
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

	private loadIndex(): AxiomReflection[] {
		if (this.cachedIndex) {
			return this.cachedIndex;
		}
		if (!existsSync(this.indexPath)) {
			this.cachedIndex = [];
			return this.cachedIndex;
		}
		try {
			const raw = readFileSync(this.indexPath, "utf-8");
			const entries: AxiomReflection[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					entries.push(JSON.parse(trimmed) as AxiomReflection);
				} catch {
					// skip malformed lines; index is append-only, partial writes are rare
				}
			}
			this.cachedIndex = entries;
		} catch {
			this.cachedIndex = [];
		}
		return this.cachedIndex;
	}

	/** Save a new reflection. Best-effort; returns false on storage failure. */
	save(reflection: AxiomReflection): boolean {
		if (!this.ensureDir()) return false;
		try {
			const mdPath = join(this.baseDir, `${reflection.id}.md`);
			writeFileSync(mdPath, renderMarkdown(reflection), "utf-8");
			// Append to the index for fast recall scans.
			const indexLine = `${JSON.stringify(reflection)}\n`;
			if (existsSync(this.indexPath)) {
				const current = readFileSync(this.indexPath, "utf-8");
				writeFileSync(this.indexPath, current + indexLine, "utf-8");
			} else {
				writeFileSync(this.indexPath, indexLine, "utf-8");
			}
			if (this.cachedIndex) {
				this.cachedIndex.push(reflection);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Retrieve the top-k reflections whose keywords overlap with the query.
	 * Same task-kind reflections receive a small boost.
	 * Score = keywordOverlapCount + (sameTaskKind ? 1 : 0) + recencyBonus (small).
	 */
	recall(options: { keywords: string[]; taskKind: string; limit: number }): AxiomReflectionRecallHit[] {
		const { keywords, taskKind, limit } = options;
		if (limit <= 0) return [];
		const haystack = this.loadIndex();
		if (haystack.length === 0) return [];

		const queryKeywords = new Set(keywords.map((k) => k.toLowerCase()).filter(Boolean));
		if (queryKeywords.size === 0) return [];

		const now = Date.now();
		const hits: AxiomReflectionRecallHit[] = [];
		for (const reflection of haystack) {
			const reflectionKeywords = reflection.keywords.map((k) => k.toLowerCase());
			const matched = reflectionKeywords.filter((k) => queryKeywords.has(k));
			if (matched.length === 0) continue;

			let score = matched.length;
			if (reflection.taskKind === taskKind) score += 1;

			// Mild recency: reflections from the last 7 days get +0.5, last 30 days +0.25.
			const ageDays = (now - Date.parse(reflection.timestamp)) / (1000 * 60 * 60 * 24);
			if (Number.isFinite(ageDays)) {
				if (ageDays < 7) score += 0.5;
				else if (ageDays < 30) score += 0.25;
			}

			hits.push({ reflection, score, matchedKeywords: matched });
		}

		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	/** Test-only: clear the in-memory index cache. */
	clearCache(): void {
		this.cachedIndex = null;
	}

	/** Test-only: list all reflections in the store. */
	all(): AxiomReflection[] {
		return [...this.loadIndex()];
	}

	/** Scan the directory and rebuild the index from the *.md files. Useful when
	 * reflections were added externally or the index was lost. */
	rebuildIndex(): boolean {
		if (!this.ensureDir()) return false;
		try {
			const files = readdirSync(this.baseDir);
			const entries: AxiomReflection[] = [];
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

function renderMarkdown(r: AxiomReflection): string {
	const fm: string[] = ["---"];
	fm.push(`id: ${r.id}`);
	fm.push(`timestamp: ${r.timestamp}`);
	fm.push(`task_kind: ${r.taskKind}`);
	fm.push(`domain: ${r.domain}`);
	fm.push(`failure_type: ${r.failureType}`);
	fm.push(`failure_codes: ${r.failureCodes.join(", ")}`);
	fm.push(`problem_class: ${r.problemClass.join(", ")}`);
	fm.push(`keywords: ${r.keywords.join(", ")}`);
	if (r.sourceTraceId) fm.push(`source_trace: ${r.sourceTraceId}`);
	fm.push("---");
	fm.push("");
	fm.push("# Cause");
	fm.push("");
	fm.push(r.cause);
	fm.push("");
	fm.push("# Correction");
	fm.push("");
	fm.push(r.correction);
	fm.push("");
	fm.push("# Original prompt (snippet)");
	fm.push("");
	fm.push(r.taskSnippet);
	fm.push("");
	return fm.join("\n");
}

function parseMarkdown(text: string): AxiomReflection | null {
	// Light parser; only used by rebuildIndex(). Tolerates loose frontmatter.
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
	const taskKind = meta.get("task_kind") as AxiomReflection["taskKind"] | undefined;
	if (!id || !timestamp || !taskKind) return null;

	const list = (raw: string | undefined): string[] =>
		(raw ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

	const sectionRe = /^#\s+([A-Za-z ]+)\s*\n+([\s\S]*?)(?=\n#\s|$)/gm;
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
		problemClass: list(meta.get("problem_class")),
		keywords: list(meta.get("keywords")),
		failureType: meta.get("failure_type") ?? "unknown",
		failureCodes: list(meta.get("failure_codes")),
		sourceTraceId: meta.get("source_trace"),
		cause: sections.get("cause") ?? "",
		correction: sections.get("correction") ?? "",
		taskSnippet: sections.get("original prompt (snippet)") ?? "",
	};
}
