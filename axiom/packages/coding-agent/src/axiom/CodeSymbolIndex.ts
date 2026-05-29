import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { analyzeFile, languageForPath } from "./CodeAnalyzer.ts";
import type { AxiomSymbolEntry } from "./RuntimeTypes.ts";

/**
 * Persistent symbol-aware inverted index over a codebase.
 *
 * Indexes every code file once by extracting symbols via the existing
 * regex-based {@link analyzeFile}. For every symbol we tokenize its name
 * (Camel/snake/dotted) and add one entry per token to the inverted map:
 *
 *     term  ->  [{file, line, kind, originalName, exported}, ...]
 *
 * Built lazily on first {@link query}; refreshed incrementally per file via
 * mtime checks on every subsequent query. Persisted as gzipless JSON under
 * `~/.axiom/agent/code-index/<repo-hash>.json` so the index survives across
 * AXIOM sessions.
 *
 * Why not just rely on ripgrep:
 *   - ripgrep matches any literal occurrence (including inside comments and
 *     string contents). The symbol index only contains *declarations* —
 *     much higher precision for "where is X defined / who exports Y" queries.
 *   - Each declaration carries kind metadata (function vs class vs type), so
 *     downstream ranking can weight function/class hits over const hits.
 *   - O(token-set-size) lookups instead of O(repo-bytes) scans. ~1000x speed
 *     advantage for symbol lookups on large repos.
 *
 * Hard caps:
 *   - {@link MAX_FILES} files indexed total (avoids choking on huge repos)
 *   - {@link MAX_BYTES_PER_FILE} per source file
 *   - {@link SKIP_DIRS} skips standard build / vendor dirs
 *
 * Falls open: index missing -> {@link query} returns []; downstream callers
 * already have ripgrep as the fast fallback.
 */

const INDEX_VERSION = 1;
const MAX_FILES = 8000;
const MAX_BYTES_PER_FILE = 1_500_000;
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"coverage",
	".turbo",
	".cache",
	"target",
	"vendor",
	".venv",
	"__pycache__",
	".idea",
	".vscode",
	".pytest_cache",
	".gradle",
	".bundle",
	".axiom",
]);

const CODE_EXTS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".rb",
	".php",
	".swift",
	".c",
	".h",
	".cpp",
	".hpp",
	".cc",
	".cs",
]);

interface SymbolPosting {
	file: string;
	line: number;
	kind: AxiomSymbolEntry["kind"];
	name: string;
	exported: boolean;
}

interface FileSnapshot {
	mtimeMs: number;
	bytes: number;
	symbolCount: number;
}

interface PersistedIndex {
	version: number;
	cwd: string;
	updatedAt: string;
	fileCount: number;
	tokenCount: number;
	files: Record<string, FileSnapshot>;
	/** `term -> SymbolPosting[]`. Stored as object for easy JSON round-trip. */
	postings: Record<string, SymbolPosting[]>;
}

export interface CodeSymbolHit {
	file: string;
	line: number;
	kind: AxiomSymbolEntry["kind"];
	name: string;
	exported: boolean;
	/** How many of the query tokens matched this posting's tokens. */
	tokenMatches: number;
}

export interface CodeSymbolFileScore {
	file: string;
	/** Distinct symbol declarations in this file that matched the query. */
	hitCount: number;
	/** Per-file aggregate: sum of (tokenMatches * kindWeight) across hits. */
	score: number;
	/** Most-relevant hit, for display in the TaskPrimer brief. */
	topHit: CodeSymbolHit;
}

export class CodeSymbolIndex {
	private readonly baseDir: string;
	private readonly cwd: string;
	private readonly indexPath: string;
	private data: PersistedIndex | undefined;

	constructor(options: { cwd: string; baseDir?: string }) {
		this.cwd = resolvePath(options.cwd);
		this.baseDir = options.baseDir ?? join(homedir(), ".axiom", "agent", "code-index");
		const hash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 16);
		this.indexPath = join(this.baseDir, `${hash}.json`);
	}

	/** Available for tests / debugging. */
	get persistedPath(): string {
		return this.indexPath;
	}

	/**
	 * Ensure the index reflects the current repo state. First call builds from
	 * scratch (~50-500ms for medium repos). Subsequent calls walk the file
	 * tree but only re-analyze files whose mtime has changed (~10-30ms typical).
	 *
	 * `force` rebuilds unconditionally. `maxFiles` caps the walk; the default
	 * is generous enough for typical repos. Pass a smaller value on huge repos
	 * to avoid blocking the task-start path for too long.
	 */
	ensureFresh(opts?: { force?: boolean; maxFiles?: number }): void {
		if (!this.data || opts?.force) {
			this.data = this.loadFromDisk() ?? this.emptyIndex();
		}
		this.refreshIncrementally(opts?.maxFiles ?? MAX_FILES);
		this.persist();
	}

	/**
	 * Query the index by an array of search terms. Terms are tokenized the
	 * same way symbol names are, so "validate-session" and "validateSession"
	 * collapse to the same token set. Returns per-file aggregates sorted by
	 * descending score with `topHit` carrying the strongest match.
	 *
	 * `maxFiles` defaults to 16, sufficient for TaskPrimer's brief. Pass a
	 * higher cap when used as a research tool by the agent.
	 */
	query(terms: readonly string[], opts?: { maxFiles?: number }): CodeSymbolFileScore[] {
		this.ensureFresh();
		const data = this.data;
		if (!data) return [];
		const queryTokens = new Set<string>();
		for (const term of terms) {
			for (const token of tokenizeSymbol(term)) queryTokens.add(token);
		}
		if (queryTokens.size === 0) return [];

		// Collect postings hit by any query token. Track the count of *distinct*
		// query tokens each posting matched so we can score "more tokens shared"
		// higher than "one token, many times."
		const postingTokenMatches = new Map<string, { posting: SymbolPosting; matches: number }>();
		for (const token of queryTokens) {
			const postings = data.postings[token];
			if (!postings) continue;
			for (const posting of postings) {
				const key = `${posting.file}#${posting.line}#${posting.name}`;
				const existing = postingTokenMatches.get(key);
				if (existing) {
					existing.matches++;
				} else {
					postingTokenMatches.set(key, { posting, matches: 1 });
				}
			}
		}
		if (postingTokenMatches.size === 0) return [];

		const byFile = new Map<string, CodeSymbolFileScore>();
		for (const { posting, matches } of postingTokenMatches.values()) {
			const hit: CodeSymbolHit = {
				file: posting.file,
				line: posting.line,
				kind: posting.kind,
				name: posting.name,
				exported: posting.exported,
				tokenMatches: matches,
			};
			const weight = kindWeight(posting.kind) * (posting.exported ? 1.3 : 1.0);
			const contribution = matches * weight;
			const existing = byFile.get(posting.file);
			if (existing) {
				existing.hitCount++;
				existing.score += contribution;
				if (matches > existing.topHit.tokenMatches) existing.topHit = hit;
			} else {
				byFile.set(posting.file, { file: posting.file, hitCount: 1, score: contribution, topHit: hit });
			}
		}

		const out = [...byFile.values()];
		out.sort((a, b) => b.score - a.score || b.hitCount - a.hitCount || a.file.localeCompare(b.file));
		return out.slice(0, Math.max(0, opts?.maxFiles ?? 16));
	}

	/** Force a full rebuild. Mostly a debugging hook. */
	rebuild(): void {
		this.data = this.emptyIndex();
		this.refreshIncrementally(MAX_FILES);
		this.persist();
	}

	/** Stats for telemetry / debug surfaces. */
	stats(): { fileCount: number; tokenCount: number; updatedAt: string } | undefined {
		this.ensureFresh();
		if (!this.data) return undefined;
		return {
			fileCount: this.data.fileCount,
			tokenCount: this.data.tokenCount,
			updatedAt: this.data.updatedAt,
		};
	}

	private emptyIndex(): PersistedIndex {
		return {
			version: INDEX_VERSION,
			cwd: this.cwd,
			updatedAt: new Date().toISOString(),
			fileCount: 0,
			tokenCount: 0,
			files: {},
			postings: {},
		};
	}

	private loadFromDisk(): PersistedIndex | undefined {
		if (!existsSync(this.indexPath)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(this.indexPath, "utf-8")) as PersistedIndex;
			if (parsed.version !== INDEX_VERSION || parsed.cwd !== this.cwd) return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	/**
	 * Walk the repo, find code files, compare mtimes against the persisted
	 * snapshot, and re-analyze only what changed. Files that disappeared from
	 * disk are dropped from `files` and their postings cleaned out. Files that
	 * appeared get fully analyzed and indexed.
	 */
	private refreshIncrementally(maxFiles: number): void {
		const data = this.data ?? this.emptyIndex();
		this.data = data;
		const onDisk = new Map<string, FileSnapshot>();
		const filesToReanalyze: string[] = [];
		walk(this.cwd, this.cwd, onDisk, filesToReanalyze, data.files, 0, maxFiles);

		// Drop postings whose file vanished.
		const removedFiles: string[] = [];
		for (const file of Object.keys(data.files)) {
			if (!onDisk.has(file)) removedFiles.push(file);
		}
		if (removedFiles.length > 0) {
			const removedSet = new Set(removedFiles);
			for (const file of removedFiles) delete data.files[file];
			for (const token of Object.keys(data.postings)) {
				const filtered = data.postings[token].filter((p) => !removedSet.has(p.file));
				if (filtered.length === 0) delete data.postings[token];
				else data.postings[token] = filtered;
			}
		}

		// Re-analyze changed / new files. Drop their old postings first.
		if (filesToReanalyze.length > 0) {
			const reanalyzeSet = new Set(filesToReanalyze);
			for (const token of Object.keys(data.postings)) {
				const filtered = data.postings[token].filter((p) => !reanalyzeSet.has(p.file));
				if (filtered.length === 0) delete data.postings[token];
				else data.postings[token] = filtered;
			}
			for (const file of filesToReanalyze) {
				const snap = onDisk.get(file);
				if (!snap) continue;
				const absolute = join(this.cwd, file);
				let source: string;
				try {
					source = readFileSync(absolute, "utf-8");
				} catch {
					data.files[file] = { ...snap, symbolCount: 0 };
					continue;
				}
				const understanding = analyzeFile(file, source);
				let added = 0;
				for (const sym of understanding.symbols) {
					const posting: SymbolPosting = {
						file,
						line: sym.line,
						kind: sym.kind,
						name: sym.name,
						exported: !!sym.exported,
					};
					for (const token of tokenizeSymbol(sym.name)) {
						const list = data.postings[token] ?? [];
						list.push(posting);
						data.postings[token] = list;
					}
					added++;
				}
				data.files[file] = { ...snap, symbolCount: added };
			}
		}

		data.fileCount = Object.keys(data.files).length;
		data.tokenCount = Object.keys(data.postings).length;
		data.updatedAt = new Date().toISOString();
	}

	private persist(): void {
		if (!this.data) return;
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			writeFileSync(this.indexPath, JSON.stringify(this.data), "utf-8");
		} catch {
			// Persistence is best-effort; in-memory index still works.
		}
	}
}

/**
 * Walk a directory tree, populate `onDisk` with current FileSnapshots, and
 * fill `toReanalyze` with files whose mtime differs from the persisted
 * snapshot (or that are brand-new). Self-bounded by `maxFiles` and by the
 * skip-dirs list.
 */
function walk(
	cwd: string,
	current: string,
	onDisk: Map<string, FileSnapshot>,
	toReanalyze: string[],
	previousFiles: Record<string, FileSnapshot>,
	depth: number,
	maxFiles: number,
): boolean {
	if (onDisk.size >= maxFiles) return false;
	if (depth > 14) return true;
	let entries: Dirent[];
	try {
		entries = readdirSync(current, { withFileTypes: true }) as Dirent[];
	} catch {
		return true;
	}
	for (const entry of entries) {
		if (onDisk.size >= maxFiles) return false;
		if (entry.name.startsWith(".") && entry.name !== ".") {
			if (SKIP_DIRS.has(entry.name)) continue;
		}
		const full = join(current, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (!walk(cwd, full, onDisk, toReanalyze, previousFiles, depth + 1, maxFiles)) return false;
			continue;
		}
		if (!entry.isFile()) continue;
		const ext = extOf(entry.name);
		if (!CODE_EXTS.has(ext)) continue;
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.size > MAX_BYTES_PER_FILE) continue;
		const rel = full.slice(cwd.length + 1);
		const snap: FileSnapshot = { mtimeMs: st.mtimeMs, bytes: st.size, symbolCount: 0 };
		onDisk.set(rel, snap);
		const prev = previousFiles[rel];
		if (!prev || prev.mtimeMs !== snap.mtimeMs || prev.bytes !== snap.bytes) {
			toReanalyze.push(rel);
		} else {
			// Preserve the recorded symbol count from the previous snapshot.
			snap.symbolCount = prev.symbolCount;
		}
		// Sanity: skip files the analyzer doesn't recognize at all.
		if (!languageForPath(rel)) {
			// Already filtered by CODE_EXTS, defensive only.
		}
	}
	return true;
}

function extOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * Symbol-aware tokenization. Returns the lowercased original name plus every
 * meaningful word inside it. `validateSession` -> [`validatesession`,
 * `validate`, `session`]. `auth_middleware` -> [`auth_middleware`, `auth`,
 * `middleware`]. Single-character pieces are dropped.
 */
export function tokenizeSymbol(symbolName: string): string[] {
	const trimmed = symbolName.trim();
	if (!trimmed) return [];
	const out = new Set<string>();
	const lower = trimmed.toLowerCase();
	out.add(lower);
	// CamelCase / PascalCase split: insert a space before every uppercase letter
	// that follows a lowercase one, then split on non-alphanumerics.
	const decamelized = trimmed.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	for (const part of decamelized.split(/[^A-Za-z0-9]+/)) {
		const p = part.toLowerCase();
		if (p.length >= 2) out.add(p);
	}
	return [...out];
}

function kindWeight(kind: AxiomSymbolEntry["kind"]): number {
	switch (kind) {
		case "function":
		case "method":
			return 1.0;
		case "class":
		case "interface":
		case "struct":
		case "trait":
			return 1.2;
		case "type":
		case "enum":
			return 0.9;
		case "const":
			return 0.6;
		default:
			return 0.7;
	}
}
