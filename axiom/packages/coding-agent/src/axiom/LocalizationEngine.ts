/**
 * Deterministic localization fusion: turn many weak signals into one ranked
 * list of edit targets.
 *
 * Localization — "which file/function do I edit?" — is the dominant failure
 * mode on SWE-Bench-style tasks. Given the correct location, even a small model
 * patches acceptably; most misses are localizing the wrong place. AXIOM already
 * gathers strong signals (TaskPrimer/BugLens fuses explicit file mentions +
 * stack traces + symbol-index hits + ripgrep density), but two high-value
 * signals are NOT yet folded in:
 *
 *   1. CALL-GRAPH PROXIMITY. The buggy site is very often a structural neighbour
 *      (caller/callee/importer) of a file named in the issue, not the named file
 *      itself. Propagating a fraction of a seed's score to its graph neighbours
 *      surfaces those adjacent sites.
 *   2. FAILURE-FINGERPRINT RECURRENCE. Files repeatedly implicated in past
 *      similar verifier failures are prior-likely suspects again.
 *
 * This engine is a PURE, injectable fusion layer: it takes already-gathered
 * signals (or extracts hints from raw text) and a couple of injected lookups
 * (`neighboursOf`, `fileExists`) and produces a ranked {@link EditTarget} list
 * with per-target source attribution and rationale. No fs, no LLM, no store
 * coupling — so it is fully unit-testable with synchronous fakes, and the live
 * wiring later is just "feed BugLens hints + CodeSymbolIndex scores +
 * CodeGraphStore.neighbours + FailureFingerprintStore hits into it".
 *
 * Scoring is additive with documented weights; ties break on file name so the
 * result is deterministic and order-independent.
 */

/** Where a target's score came from — surfaced so the agent/UI can explain a pick. */
export type LocalizationSource = "explicit-line" | "explicit-file" | "lexical" | "graph-neighbour" | "fingerprint";

/** A structured location parsed from task/error text, or supplied by BugLens. */
export interface LocationHint {
	file: string;
	line?: number;
	symbol?: string;
	kind: "traceback" | "path-line" | "path";
	/** Extractor confidence in [0, 1]; informational (weighting uses presence of a line). */
	confidence: number;
}

/** File-level relevance from symbol-index + ripgrep (e.g. CodeSymbolFileScore). */
export interface LexicalFileScore {
	file: string;
	score: number;
	topSymbol?: { name: string; line: number; kind?: string };
}

/** A file repeatedly implicated in prior similar failures. */
export interface FingerprintFileHit {
	file: string;
	/** How many past failures touched this file. Higher = stronger prior. */
	recurrence: number;
}

export interface LocalizationInput {
	/** Raw issue/error text; parsed via {@link extractLocationHints} when `hints` is absent. */
	taskText?: string;
	/** Pre-extracted hints (e.g. from BugLens). When provided, `taskText` is not parsed. */
	hints?: LocationHint[];
	/** File-level lexical relevance scores. */
	lexical?: LexicalFileScore[];
	/** 1-hop call-graph neighbours of a file (callers/callees/importers). */
	neighboursOf?: (file: string) => string[];
	/** Past-failure recurrence hits. */
	fingerprints?: FingerprintFileHit[];
	/** Optional existence filter — hints/neighbours pointing at missing files are dropped. */
	fileExists?: (file: string) => boolean;
	/** Cap on returned targets. Default 10. */
	maxTargets?: number;
}

export interface EditTarget {
	file: string;
	symbol?: string;
	line?: number;
	/** Raw additive score. */
	score: number;
	/** Normalised to [0, 1] against the top score (1 = strongest suspect). */
	confidence: number;
	sources: LocalizationSource[];
	rationale: string[];
}

export interface LocalizationResult {
	targets: EditTarget[];
	/** Files used as graph-expansion seeds (the explicit, high-confidence hits). */
	seeds: string[];
}

// --- Scoring weights (documented; tuned to keep explicit signals dominant) ---
const W_EXPLICIT_LINE = 30; // traceback / path:line — pinpoints a site
const W_EXPLICIT_FILE = 24; // explicit path mention without a line
const W_LEXICAL_CAP = 16; // symbol+ripgrep relevance, capped so it can't outrank explicit
const W_LEXICAL_SCALE = 2;
const W_GRAPH_NEIGHBOUR = 12; // 1-hop proximity to a seed (decayed from the seed)
const GRAPH_DECAY = 0.4; // neighbour gets at most GRAPH_DECAY * seedScore, capped at W_GRAPH_NEIGHBOUR
const W_FINGERPRINT = 8;
const W_FINGERPRINT_CAP = 16;
const DEFAULT_MAX_TARGETS = 10;

interface Acc {
	file: string;
	score: number;
	line?: number;
	symbol?: string;
	sources: Set<LocalizationSource>;
	rationale: string[];
}

export class LocalizationEngine {
	/** Fuse all available signals into a ranked edit-target list. Pure & synchronous. */
	localize(input: LocalizationInput): LocalizationResult {
		const exists = input.fileExists ?? (() => true);
		const acc = new Map<string, Acc>();

		const get = (file: string): Acc => {
			let a = acc.get(file);
			if (!a) {
				a = { file, score: 0, sources: new Set(), rationale: [] };
				acc.set(file, a);
			}
			return a;
		};
		const bump = (
			file: string,
			points: number,
			source: LocalizationSource,
			why: string,
			line?: number,
			symbol?: string,
		) => {
			if (!file || points <= 0 || !exists(file)) return;
			const a = get(file);
			a.score += points;
			a.sources.add(source);
			if (!a.rationale.includes(why)) a.rationale.push(why);
			// Keep the most specific line/symbol we have seen (prefer one with a line).
			if (line !== undefined && a.line === undefined) a.line = line;
			if (symbol && !a.symbol) a.symbol = symbol;
		};

		// 1. Explicit hints — strongest. Parsed from text unless supplied.
		const hints = input.hints ?? (input.taskText ? extractLocationHints(input.taskText) : []);
		const seeds: string[] = [];
		for (const hint of hints) {
			if (!exists(hint.file)) continue;
			if (hint.line !== undefined) {
				bump(
					hint.file,
					W_EXPLICIT_LINE,
					"explicit-line",
					`error/trace mention at L${hint.line}`,
					hint.line,
					hint.symbol,
				);
			} else {
				bump(hint.file, W_EXPLICIT_FILE, "explicit-file", "explicitly referenced in task", undefined, hint.symbol);
			}
			if (!seeds.includes(hint.file)) seeds.push(hint.file);
		}

		// 2. Lexical relevance — breadth. Capped so it never outranks an explicit hit.
		for (const lex of input.lexical ?? []) {
			const points = Math.min(W_LEXICAL_CAP, lex.score * W_LEXICAL_SCALE);
			bump(
				lex.file,
				points,
				"lexical",
				lex.topSymbol ? `symbol/text match: ${lex.topSymbol.name}` : "lexical match",
				lex.topSymbol?.line,
				lex.topSymbol?.name,
			);
		}

		// 3. Graph proximity — propagate a decayed fraction of each seed's score to
		// its 1-hop neighbours. Captures "bug is in the caller/callee of the named file".
		if (input.neighboursOf) {
			for (const seed of seeds) {
				const seedScore = acc.get(seed)?.score ?? W_EXPLICIT_FILE;
				const propagated = Math.min(W_GRAPH_NEIGHBOUR, seedScore * GRAPH_DECAY);
				for (const neighbour of input.neighboursOf(seed)) {
					if (neighbour === seed) continue;
					bump(neighbour, propagated, "graph-neighbour", `call-graph neighbour of ${seed}`);
				}
			}
		}

		// 4. Failure-fingerprint recurrence — prior-likely suspects.
		for (const fp of input.fingerprints ?? []) {
			const points = Math.min(W_FINGERPRINT_CAP, fp.recurrence * W_FINGERPRINT);
			bump(fp.file, points, "fingerprint", `implicated in ${fp.recurrence} past failure(s)`);
		}

		const ranked = [...acc.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
		const top = ranked[0]?.score ?? 0;
		const maxTargets = input.maxTargets ?? DEFAULT_MAX_TARGETS;

		const targets: EditTarget[] = ranked.slice(0, Math.max(0, maxTargets)).map((a) => ({
			file: a.file,
			symbol: a.symbol,
			line: a.line,
			score: Math.round(a.score * 100) / 100,
			confidence: top > 0 ? Math.round((a.score / top) * 100) / 100 : 0,
			sources: [...a.sources],
			rationale: a.rationale.slice(0, 4),
		}));

		return { targets, seeds };
	}
}

// --- Pure hint extraction ----------------------------------------------------

const TRACEBACK_PY = /File "([^"]+\.[A-Za-z]{1,5})", line (\d+)/g; // Python
const STACK_FRAME = /\(?([\w./-]+\.[A-Za-z]{1,5}):(\d+)(?::\d+)?\)?/g; // path:line[:col] (JS/TS/Go/etc.)
const BACKTICK_PATH = /`([\w./-]+\.[A-Za-z]{1,5})`/g; // `src/foo.ts`

/**
 * Parse structured code locations out of free task / error text. Deterministic,
 * dependency-free. Strongest-confidence wins per (file,line). Exported so the
 * live BugLens path can converge on one extractor over time.
 */
export function extractLocationHints(text: string): LocationHint[] {
	if (!text) return [];
	const byKey = new Map<string, LocationHint>();
	const consider = (hint: LocationHint) => {
		const key = `${normalise(hint.file)}#${hint.line ?? ""}`;
		const existing = byKey.get(key);
		if (!existing || hint.confidence > existing.confidence) {
			byKey.set(key, { ...hint, file: normalise(hint.file) });
		}
	};

	for (const m of text.matchAll(TRACEBACK_PY)) {
		consider({ file: m[1], line: Number(m[2]), kind: "traceback", confidence: 0.95 });
	}
	for (const m of text.matchAll(STACK_FRAME)) {
		// Skip bare version-like or non-path tokens (no slash and very short).
		if (!m[1].includes("/") && !m[1].includes("\\") && m[1].length < 6) continue;
		consider({ file: m[1], line: Number(m[2]), kind: "path-line", confidence: 0.8 });
	}
	for (const m of text.matchAll(BACKTICK_PATH)) {
		consider({ file: m[1], kind: "path", confidence: 0.6 });
	}

	// Drop a bare-path hint when a more specific path:line hint for the same file exists.
	const hints = [...byKey.values()];
	const filesWithLine = new Set(hints.filter((h) => h.line !== undefined).map((h) => h.file));
	return hints
		.filter((h) => !(h.line === undefined && filesWithLine.has(h.file)))
		.sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file));
}

function normalise(file: string): string {
	return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
