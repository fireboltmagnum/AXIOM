import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A single item in the per-task todo list. The agent ticks these off as it
 * makes progress; the TUI renders the most recent snapshot.
 */
export interface AxiomTodoItem {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
	/** Optional one-line note the agent attached when ticking the item (e.g. why it failed). */
	note?: string;
}

/**
 * Whole-list state for one session. Persisted as JSON under
 * ~/.axiom/agent/todos/<sessionId>.json so the next turn still sees the same
 * list even after the agent process restarts.
 */
export interface AxiomTodoList {
	sessionId: string;
	title?: string;
	items: AxiomTodoItem[];
	createdAt: string;
	updatedAt: string;
}

/**
 * Filesystem-backed todo list store keyed by session id. One JSON file per
 * session. The store is intentionally tiny — no indexing, no recall — because
 * the list is ephemeral progress tracking, not durable memory. The Context
 * Agent is the place for long-term recall.
 */
export class TodoListStore {
	private readonly baseDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "todos");
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

	private pathFor(sessionId: string): string {
		// session id is a uuid in normal use; if something stranger turns up,
		// scrub it to a filename-safe slug so disk writes can't escape baseDir.
		const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
		return join(this.baseDir, `${safe}.json`);
	}

	/** Load the list for a session. Returns undefined if none has been created yet. */
	load(sessionId: string): AxiomTodoList | undefined {
		const path = this.pathFor(sessionId);
		if (!existsSync(path)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as AxiomTodoList;
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	/** Replace the entire list. Returns the saved snapshot. */
	save(list: AxiomTodoList): AxiomTodoList | undefined {
		if (!this.ensureDir()) return undefined;
		try {
			writeFileSync(this.pathFor(list.sessionId), `${JSON.stringify(list, null, 2)}\n`, "utf-8");
			return list;
		} catch {
			return undefined;
		}
	}

	/** Convenience: create a fresh list, persist, return. */
	create(options: { sessionId: string; title?: string; items: string[] }): AxiomTodoList | undefined {
		const now = new Date().toISOString();
		const list: AxiomTodoList = {
			sessionId: options.sessionId,
			title: options.title,
			items: options.items.map((text, idx) => ({ id: idx + 1, text: text.trim(), status: "pending" })),
			createdAt: now,
			updatedAt: now,
		};
		return this.save(list);
	}
}
