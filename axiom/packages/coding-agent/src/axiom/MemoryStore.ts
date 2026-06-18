import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent-curated long-term memory + a lightweight user model.
 *
 * The agent decides what is worth remembering across sessions (a durable fact, a
 * user preference, a project constraint) and writes it here. Next session it can
 * `recall` the most relevant entries for the task at hand. This is the small-model
 * analogue of a large context window: instead of re-deriving who the user is and
 * how the project works every session, the agent reads back a handful of curated
 * notes.
 *
 * Storage (under <baseDir>, default <cwd>/.axiom/memory):
 *   index.jsonl   append-only log of entries (one JSON per line)
 *   MEMORY.md     human-browsable surface of all memories, grouped by type
 *   USER.md       the distilled user model (type=user + type=preference)
 *
 * Retrieval is deterministic keyword-overlap scoring with type weighting and a
 * mild recency bonus — no embeddings, so it is reproducible and greppable. The
 * two markdown surfaces are regenerated on every mutation so a human (or a plain
 * `read`) always sees the current state.
 */

export type MemoryType = "fact" | "preference" | "project" | "user";

export interface MemoryEntry {
	id: string;
	type: MemoryType;
	text: string;
	tags: string[];
	createdAt: string;
}

export interface MemoryInput {
	type: MemoryType;
	text: string;
	tags?: string[];
}

export interface MemoryRecallHit {
	entry: MemoryEntry;
	score: number;
	matched: string[];
}

const TYPE_ORDER: MemoryType[] = ["user", "preference", "project", "fact"];

// Type weighting in recall: who-the-user-is and their preferences are almost
// always relevant, so they get a small standing boost over incidental facts.
const TYPE_WEIGHT: Record<MemoryType, number> = {
	user: 1.5,
	preference: 1.0,
	project: 0.5,
	fact: 0,
};

export class MemoryStore {
	private readonly baseDir: string;
	private readonly indexPath: string;
	private cache: MemoryEntry[] | null = null;
	private seq = 0;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
		this.indexPath = join(baseDir, "index.jsonl");
	}

	private ensureDir(): boolean {
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			return true;
		} catch {
			return false;
		}
	}

	private load(): MemoryEntry[] {
		if (this.cache) return this.cache;
		if (!existsSync(this.indexPath)) {
			this.cache = [];
			return this.cache;
		}
		try {
			const entries: MemoryEntry[] = [];
			for (const line of readFileSync(this.indexPath, "utf-8").split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					entries.push(JSON.parse(trimmed) as MemoryEntry);
				} catch {
					// skip malformed line
				}
			}
			this.cache = entries;
		} catch {
			this.cache = [];
		}
		return this.cache;
	}

	private nextId(): string {
		this.seq += 1;
		return `mem_${Date.now().toString(36)}_${this.seq.toString(36)}`;
	}

	/** Store a new memory. Returns the created entry, or null on storage failure. */
	remember(input: MemoryInput): MemoryEntry | null {
		const text = input.text?.trim();
		if (!text) return null;
		if (!this.ensureDir()) return null;
		const entry: MemoryEntry = {
			id: this.nextId(),
			type: input.type,
			text,
			tags: dedupe((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
			createdAt: new Date().toISOString(),
		};
		// De-dup: if an identical (type+text) memory already exists, don't append again.
		const existing = this.load().find((e) => e.type === entry.type && e.text === entry.text);
		if (existing) return existing;
		try {
			const line = `${JSON.stringify(entry)}\n`;
			writeFileSync(
				this.indexPath,
				existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf-8") + line : line,
				"utf-8",
			);
			this.load().push(entry);
			this.renderSurfaces();
			return entry;
		} catch {
			return null;
		}
	}

	/**
	 * Recall the top-k memories most relevant to a free-text query.
	 * Score = matchedTermCount (TF-weighted) + typeWeight + recencyBonus.
	 * With an empty query, returns the most relevant standing memories
	 * (user/preference first), so a session can warm-start with no task yet.
	 */
	recall(query: string, limit = 5): MemoryRecallHit[] {
		if (limit <= 0) return [];
		const entries = this.load();
		if (entries.length === 0) return [];
		const terms = tokenize(query);
		const now = Date.now();

		const hits: MemoryRecallHit[] = [];
		for (const entry of entries) {
			const hay = tokenize(`${entry.text} ${entry.tags.join(" ")}`);
			const haySet = new Set(hay);
			const matched = terms.length === 0 ? [] : dedupe(terms.filter((t) => haySet.has(t)));
			// With a query, require at least one overlap unless it's a standing
			// user/preference memory (those are surfaced even without a keyword hit).
			const isStanding = entry.type === "user" || entry.type === "preference";
			if (terms.length > 0 && matched.length === 0 && !isStanding) continue;

			let score = matched.length + TYPE_WEIGHT[entry.type];
			const ageDays = (now - Date.parse(entry.createdAt)) / 86_400_000;
			if (Number.isFinite(ageDays)) {
				if (ageDays < 7) score += 0.5;
				else if (ageDays < 30) score += 0.25;
			}
			if (terms.length === 0 && !isStanding) score -= 0.5; // demote incidental facts on empty query
			hits.push({ entry, score, matched });
		}
		hits.sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt));
		return hits.slice(0, limit);
	}

	/** Drop a memory by id. Returns true if something was removed. */
	forget(id: string): boolean {
		const entries = this.load();
		const idx = entries.findIndex((e) => e.id === id);
		if (idx === -1) return false;
		entries.splice(idx, 1);
		try {
			writeFileSync(
				this.indexPath,
				entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
				"utf-8",
			);
			this.renderSurfaces();
			return true;
		} catch {
			return false;
		}
	}

	/** The distilled user model: everything we know about who the user is + their preferences. */
	userModel(): MemoryEntry[] {
		return this.load().filter((e) => e.type === "user" || e.type === "preference");
	}

	all(): MemoryEntry[] {
		return [...this.load()];
	}

	/** Test-only: drop the in-memory cache so the next read re-loads from disk. */
	clearCache(): void {
		this.cache = null;
	}

	private renderSurfaces(): void {
		try {
			writeFileSync(join(this.baseDir, "MEMORY.md"), this.renderMemorySurface(), "utf-8");
			writeFileSync(join(this.baseDir, "USER.md"), this.renderUserSurface(), "utf-8");
		} catch {
			// surfaces are best-effort; the jsonl index is the source of truth
		}
	}

	renderMemorySurface(): string {
		const entries = this.load();
		const out: string[] = [
			"# Agent memory",
			"",
			`_${entries.length} ${entries.length === 1 ? "memory" : "memories"}_`,
			"",
		];
		for (const type of TYPE_ORDER) {
			const group = entries.filter((e) => e.type === type);
			if (group.length === 0) continue;
			out.push(`## ${capitalize(type)}`, "");
			for (const e of group) {
				const tags = e.tags.length ? `  _(${e.tags.join(", ")})_` : "";
				out.push(`- ${e.text}${tags}`);
			}
			out.push("");
		}
		return out.join("\n");
	}

	renderUserSurface(): string {
		const model = this.userModel();
		const out: string[] = ["# User model", ""];
		if (model.length === 0) {
			out.push("_No user facts recorded yet._", "");
			return out.join("\n");
		}
		const who = model.filter((e) => e.type === "user");
		const prefs = model.filter((e) => e.type === "preference");
		if (who.length) {
			out.push("## Who they are", "");
			for (const e of who) out.push(`- ${e.text}`);
			out.push("");
		}
		if (prefs.length) {
			out.push("## Preferences", "");
			for (const e of prefs) out.push(`- ${e.text}`);
			out.push("");
		}
		return out.join("\n");
	}
}

function tokenize(text: string): string[] {
	return (text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

function dedupe<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
