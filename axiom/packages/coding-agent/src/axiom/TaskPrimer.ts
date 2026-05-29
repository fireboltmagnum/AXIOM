import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { analyzeFile } from "./CodeAnalyzer.ts";
import type { CodeGraphStore } from "./CodeGraphStore.ts";
import type { CodeSymbolFileScore, CodeSymbolIndex } from "./CodeSymbolIndex.ts";
import type { FlowGraphSliceResult, FlowGraphStore } from "./FlowGraphStore.ts";
import type {
	AxiomCodeGraphHit,
	AxiomFlowGraphHit,
	AxiomSparseTreeGrepHit,
	AxiomSymbolEntry,
	AxiomTaskPrimer,
	AxiomTaskPrimerBugLensCandidate,
	AxiomTaskPrimerFileHit,
	AxiomTaskPrimerFileStructure,
	AxiomTaskPrimerFlowSlice,
	AxiomTaskPrimerSymbolWalk,
} from "./RuntimeTypes.ts";
import { rankFilesByLexicalMatches, sampleLinesPerFile } from "./ripgrep-search.ts";
import type { SparseTreeGrepStore } from "./SparseTreeGrepStore.ts";

/**
 * Auto-retrieval task priming (Aider-style repo-map injection).
 *
 * Before the agent gets the prompt, we run a fast deterministic pre-flight
 * that gathers structural context from the local codebase + the in-process
 * stores we already maintain (CodeGraph, FlowGraph). The keyword-based
 * recalls over Reflexion/Skill/Knowledge/SparseTreeGrep already happen in
 * {@link AXIOMRuntime.planTask}; TaskPrimer adds the two missing pieces:
 *
 *   1. Ripgrep over the codebase ranks files by lexical relevance to the
 *      user's prompt. Mentioned symbols + free-text keywords are the query.
 *   2. Symbol walks: for each candidate symbol extracted from the prompt,
 *      look it up in CodeGraph and FlowGraph and return 1-hop neighbors.
 *      The graphs may not have the symbol yet (depends on what files have
 *      been analyzed) — when missing we skip silently.
 *
 * Everything is best-effort: missing ripgrep, no graphs, empty prompt — all
 * degrade to an empty primer without affecting the rest of the run.
 *
 * Hard caps so a primer can never balloon the system prompt:
 *   - top {@link MAX_FILES} files
 *   - up to {@link MAX_LINES_PER_FILE} sample lines per file
 *   - up to {@link MAX_SYMBOLS} symbols walked
 *   - {@link TIMEOUT_MS} wall-clock budget for the whole pre-flight
 *
 * Token estimate is char-count / 4 (cheap, deliberately loose); the caller
 * enforces a final token cap before injection.
 */

const MAX_FILES = 8;
const MAX_LINES_PER_FILE = 3;
const MAX_SYMBOLS = 6;
const MAX_FILE_STRUCTURES = 4;
const MAX_FLOW_SLICES = 3;
const MAX_DOCUMENT_HITS = 3;
const MAX_BUG_LENS = 5;
const TIMEOUT_MS = 1500;

/** Words that look like identifiers but are never useful as graph keys. */
const SYMBOL_STOPWORDS = new Set([
	"the",
	"this",
	"that",
	"these",
	"those",
	"and",
	"but",
	"with",
	"from",
	"into",
	"when",
	"where",
	"what",
	"why",
	"how",
	"who",
	"which",
	"main",
	"index",
	"util",
	"utils",
	"helper",
	"helpers",
	"core",
	"common",
	"shared",
	"true",
	"false",
	"null",
	"undefined",
	"none",
	"any",
	"all",
	"some",
	"each",
	"every",
	"todo",
	"fixme",
	"note",
	"hack",
	"bug",
	"feature",
	"fix",
	"add",
	"remove",
	"update",
	"change",
	"new",
	"old",
	"function",
	"class",
	"const",
	"let",
	"var",
	"if",
	"else",
	"for",
	"while",
	"return",
	"import",
	"export",
	"default",
	"async",
	"await",
	"public",
	"private",
	"protected",
	"static",
	"final",
	"abstract",
	"interface",
	"type",
	"void",
	"number",
	"string",
	"boolean",
	"object",
	"array",
	"map",
	"set",
	"list",
	"dict",
	"axiom",
	"agent",
	"user",
	"task",
	"code",
	"error",
	"data",
]);

export interface TaskPrimerOptions {
	cwd: string;
	prompt: string;
	keywords: string[];
	codeGraphs: CodeGraphStore;
	flowGraphs: FlowGraphStore;
	sparseTreeGrep?: SparseTreeGrepStore;
	/** Optional persistent symbol index. When provided, file ranking uses
	 * the index (declarations only, kind-weighted) for high-precision hits
	 * and folds ripgrep in as a fallback density signal. When omitted we
	 * fall back to ripgrep-only behaviour. */
	symbolIndex?: CodeSymbolIndex;
}

export class TaskPrimer {
	async prime(options: TaskPrimerOptions): Promise<AxiomTaskPrimer> {
		const startedAt = Date.now();

		// 1. Extract candidate symbols from the user prompt. These drive the
		// graph walks. Keep the top-N by length-then-frequency so we walk the
		// most distinctive identifiers first.
		const extractedSymbols = extractSymbols(options.prompt).slice(0, MAX_SYMBOLS);

		// 2. Combine symbols + keywords into one ripgrep query. Symbols carry
		// more signal (they're literal identifiers in the code), so we prefer
		// them; keywords fill in when the user described intent in prose.
		const terms = uniqueLowercased([
			...extractedSymbols,
			...options.keywords.filter((k) => k.length > 2 && !SYMBOL_STOPWORDS.has(k.toLowerCase())),
		]).slice(0, 12);

		// 3. Three parallel queries:
		//    - Symbol index lookup (precision: declarations only, kind-weighted)
		//    - Ripgrep lexical pass (recall: catches usages, comments, configs)
		//    - In-memory graph walks for each extracted symbol
		// The graph stores are pure in-memory lookups; symbol index uses an
		// on-disk inverted map (microseconds after first build); ripgrep is the
		// only one needing the real timeout budget.
		const [fileRanking, symbolIndexHits, symbolWalks] = await Promise.all([
			rankFilesByLexicalMatches({
				cwd: options.cwd,
				terms,
				maxFiles: MAX_FILES,
				timeoutMs: TIMEOUT_MS,
			}).catch(() => []),
			Promise.resolve(querySymbolIndex(options.symbolIndex, terms, extractedSymbols)),
			Promise.resolve(walkSymbols(extractedSymbols, options.codeGraphs, options.flowGraphs)),
		]);

		// 4. Merge symbol-index + ripgrep into a single ranked file list. The
		// symbol index dominates when present (declarations carry more signal
		// than raw byte matches); ripgrep fills in files the index didn't
		// catch (configs, markdown, comments, files not yet analyzed).
		const mergedRanking = mergeFileRankings(symbolIndexHits, fileRanking, MAX_FILES);

		// 5. Pull sample lines for the top files. One more ripgrep invocation,
		// targeted at the merged file list we already have.
		let fileHits: AxiomTaskPrimerFileHit[] = [];
		if (mergedRanking.length > 0) {
			const sampledLines = await sampleLinesPerFile({
				cwd: options.cwd,
				terms,
				files: mergedRanking.map((h) => h.file),
				linesPerFile: MAX_LINES_PER_FILE,
				timeoutMs: TIMEOUT_MS,
			}).catch(() => []);
			const byFile = new Map<string, Array<{ line: number; text: string }>>();
			for (const hit of sampledLines) {
				const bucket = byFile.get(hit.file) ?? [];
				bucket.push({ line: hit.line, text: hit.text });
				byFile.set(hit.file, bucket);
			}
			fileHits = mergedRanking.map((rank) => ({
				file: rank.file,
				matchCount: rank.matchCount,
				sampleLines: byFile.get(rank.file)?.slice(0, MAX_LINES_PER_FILE) ?? [],
			}));
		}

		const [fileStructures, flowSlices, documentHits] = await Promise.all([
			Promise.resolve(
				buildFileStructures(
					options.cwd,
					mergedRanking.map((h) => h.file),
				),
			),
			Promise.resolve(buildFlowSlices(options.flowGraphs, extractedSymbols)),
			options.sparseTreeGrep
				? options.sparseTreeGrep.searchReranked(terms.join(" "), { limit: MAX_DOCUMENT_HITS }).catch(() => [])
				: Promise.resolve([] as AxiomSparseTreeGrepHit[]),
		]);
		const bugLens = buildBugLens({
			cwd: options.cwd,
			prompt: options.prompt,
			symbolIndexHits,
			fileRanking,
			fileHits,
			fileStructures,
			codeGraphs: options.codeGraphs,
		});

		const durationMs = Date.now() - startedAt;
		const briefTokens = estimatePrimerTokens(
			bugLens,
			fileHits,
			symbolWalks,
			extractedSymbols,
			fileStructures,
			flowSlices,
			documentHits,
		);

		return {
			extractedSymbols,
			bugLens,
			fileHits,
			symbolWalks,
			fileStructures,
			flowSlices,
			documentHits,
			durationMs,
			briefTokens,
		};
	}
}

/**
 * Pull candidate identifiers from a free-text prompt. Matches CamelCase,
 * snake_case, and backtick-quoted tokens; filters short tokens and the
 * stopword list above. Frequency-then-length ordering keeps repeated and
 * long-distinctive names at the top of the list.
 */
export function extractSymbols(text: string): string[] {
	if (!text) return [];
	const counts = new Map<string, number>();
	const addMatch = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed.length < 3) return;
		if (SYMBOL_STOPWORDS.has(trimmed.toLowerCase())) return;
		counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
	};
	// Backticked identifiers (`foo`, `foo.bar`, `Class#method`)
	for (const m of text.matchAll(/`([A-Za-z_][\w.#]{1,80})`/g)) addMatch(m[1]);
	// CamelCase / PascalCase: at least one lowercase + one uppercase
	for (const m of text.matchAll(/\b([A-Z][a-z][A-Za-z0-9]+)\b/g)) addMatch(m[1]);
	for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+)\b/g)) addMatch(m[1]);
	// snake_case identifiers
	for (const m of text.matchAll(/\b([a-z]+(?:_[a-z][a-z0-9]*)+)\b/g)) addMatch(m[1]);
	// Dotted paths
	for (const m of text.matchAll(/\b([a-zA-Z_][\w]+(?:\.[a-zA-Z_][\w]+){1,3})\b/g)) addMatch(m[1]);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
		.map(([token]) => token);
}

/**
 * Query the persistent symbol index. Combines the prompt-extracted symbols
 * with the broader keyword set so identifiers AND prose-mentioned concepts
 * contribute to the lookup. Returns an empty array when the index is missing
 * or contributes no hits — callers fall back to ripgrep cleanly.
 */
function querySymbolIndex(
	index: CodeSymbolIndex | undefined,
	terms: readonly string[],
	extractedSymbols: readonly string[],
): CodeSymbolFileScore[] {
	if (!index) return [];
	const queryTerms = [...new Set([...extractedSymbols, ...terms])];
	try {
		return index.query(queryTerms, { maxFiles: MAX_FILES });
	} catch {
		return [];
	}
}

/**
 * Merge symbol-index hits with ripgrep density hits into a single ranked
 * file list. Files that appear in BOTH are boosted (signal from two
 * orthogonal sources). The symbol index leads the ordering because
 * declarations are a higher-precision signal than raw byte matches; ripgrep
 * fills gaps where the index has no coverage (configs, markdown, files
 * filtered by the analyzer).
 */
function mergeFileRankings(
	symbolHits: readonly CodeSymbolFileScore[],
	ripgrepHits: readonly { file: string; matchCount: number; density: number }[],
	maxFiles: number,
): Array<{ file: string; matchCount: number }> {
	const map = new Map<string, { file: string; matchCount: number; combinedScore: number }>();
	for (const hit of symbolHits) {
		map.set(hit.file, {
			file: hit.file,
			matchCount: hit.hitCount,
			combinedScore: hit.score * 2, // symbol-index signal weighted 2x
		});
	}
	for (const hit of ripgrepHits) {
		const existing = map.get(hit.file);
		if (existing) {
			// File hits in both — boost the score, sum the match counts.
			existing.combinedScore += hit.density;
			existing.matchCount += hit.matchCount;
		} else {
			map.set(hit.file, { file: hit.file, matchCount: hit.matchCount, combinedScore: hit.density });
		}
	}
	const merged = [...map.values()];
	merged.sort((a, b) => b.combinedScore - a.combinedScore || b.matchCount - a.matchCount);
	return merged.slice(0, Math.max(0, maxFiles)).map(({ file, matchCount }) => ({ file, matchCount }));
}

function buildBugLens(options: {
	cwd: string;
	prompt: string;
	symbolIndexHits: readonly CodeSymbolFileScore[];
	fileRanking: ReadonlyArray<{ file: string; matchCount: number; density: number }>;
	fileHits: readonly AxiomTaskPrimerFileHit[];
	fileStructures: readonly AxiomTaskPrimerFileStructure[];
	codeGraphs?: CodeGraphStore;
}): AxiomTaskPrimerBugLensCandidate[] {
	const candidates = new Map<
		string,
		{
			file: string;
			score: number;
			reasons: string[];
			sampleLines: Array<{ line: number; text: string }>;
			symbols: Array<Pick<AxiomSymbolEntry, "kind" | "name" | "line">>;
		}
	>();
	const add = (file: string, score: number, reason: string) => {
		if (!file) return;
		const existing = candidates.get(file) ?? {
			file,
			score: 0,
			reasons: [],
			sampleLines: [],
			symbols: [],
		};
		existing.score += score;
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
		candidates.set(file, existing);
	};

	// Explicit references (stack traces + prompt file mentions) are the strongest
	// localization signal AND the seeds for call-graph expansion below.
	const seedFiles: string[] = [];
	const seed = (file: string) => {
		if (!seedFiles.includes(file)) seedFiles.push(file);
	};
	for (const hint of extractStackTraceFileHints(options.prompt)) {
		if (existsSync(resolvePath(options.cwd, hint.file))) {
			add(
				hint.file,
				hint.line ? 30 : 24,
				hint.line ? `stack/error mention at L${hint.line}` : "stack/error path mention",
			);
			seed(hint.file);
		}
	}
	for (const file of extractPromptFileHints(options.prompt)) {
		if (existsSync(resolvePath(options.cwd, file))) {
			add(file, 18, "prompt explicitly mentions this file");
			seed(file);
		}
	}
	for (const hit of options.symbolIndexHits.slice(0, 8)) {
		add(
			hit.file,
			Math.min(18, hit.score * 2),
			`symbol hit: ${hit.topHit.kind} ${hit.topHit.name}@${hit.topHit.line}`,
		);
	}
	for (const hit of options.fileRanking.slice(0, 8)) {
		add(hit.file, Math.min(8, hit.density * 4 + hit.matchCount * 0.2), `rg density ${round(hit.density)}`);
	}

	// Call-graph proximity: the bug is often a caller/callee of a file named in
	// the issue, not the named file itself. Surface 1-hop import neighbours of
	// each seed as mid-weight suspects. No-op when no code graph is indexed.
	if (options.codeGraphs && seedFiles.length > 0) {
		for (const seedFile of seedFiles) {
			for (const neighbour of options.codeGraphs.neighborFiles(seedFile, 6)) {
				if (neighbour === seedFile) continue;
				if (existsSync(resolvePath(options.cwd, neighbour))) {
					add(neighbour, 9, `call-graph neighbour of ${seedFile}`);
				}
			}
		}
	}

	const samplesByFile = new Map(options.fileHits.map((hit) => [hit.file, hit.sampleLines]));
	const structuresByFile = new Map(options.fileStructures.map((structure) => [structure.file, structure]));
	for (const candidate of candidates.values()) {
		candidate.sampleLines = samplesByFile.get(candidate.file)?.slice(0, 2) ?? [];
		candidate.symbols = structuresByFile.get(candidate.file)?.symbols.slice(0, 6) ?? [];
	}

	return [...candidates.values()]
		.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
		.slice(0, MAX_BUG_LENS)
		.map((candidate) => ({
			file: candidate.file,
			score: Math.round(candidate.score * 100) / 100,
			reasons: candidate.reasons.slice(0, 4),
			symbols: candidate.symbols,
			sampleLines: candidate.sampleLines,
		}));
}

function extractStackTraceFileHints(text: string): Array<{ file: string; line?: number }> {
	const out: Array<{ file: string; line?: number }> = [];
	const patterns = [
		/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|swift|c|h|cpp|hpp|cs))[:(](\d+)(?::|,|\))/g,
		/File "([^"]+\.(?:py))", line (\d+)/g,
		/-->\s+([A-Za-z0-9_./-]+\.(?:rs)):(\d+):\d+/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			out.push({ file: sanitizePromptPath(match[1]), line: Number.parseInt(match[2], 10) });
		}
	}
	return dedupeFileHints(out);
}

function extractPromptFileHints(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(
		/\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|kt|rb|php|swift|c|h|cpp|hpp|cs|md|txt|yml|yaml))\b/g,
	)) {
		out.push(sanitizePromptPath(match[1]));
	}
	return [...new Set(out.filter(Boolean))];
}

function sanitizePromptPath(path: string): string {
	return path.replace(/^["'`(]+|["'`),.;:]+$/g, "").replace(/^\.\//, "");
}

function dedupeFileHints(hints: Array<{ file: string; line?: number }>): Array<{ file: string; line?: number }> {
	const seen = new Set<string>();
	const out: Array<{ file: string; line?: number }> = [];
	for (const hint of hints) {
		const key = `${hint.file}:${hint.line ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(hint);
	}
	return out;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function walkSymbols(
	symbols: string[],
	codeGraphs: CodeGraphStore,
	flowGraphs: FlowGraphStore,
): AxiomTaskPrimerSymbolWalk[] {
	const walks: AxiomTaskPrimerSymbolWalk[] = [];
	for (const symbol of symbols) {
		const codeHits: AxiomCodeGraphHit[] = safeSearch(codeGraphs, symbol);
		const flowHits: AxiomFlowGraphHit[] = safeSearch(flowGraphs, symbol);
		const codeNeighbors = uniqueLabels(codeHits).slice(0, 6);
		const flowNeighbors = uniqueLabels(flowHits).slice(0, 6);
		if (codeNeighbors.length === 0 && flowNeighbors.length === 0) continue;
		walks.push({ symbol, codeGraphNeighbors: codeNeighbors, flowGraphNeighbors: flowNeighbors });
	}
	return walks;
}

function buildFileStructures(cwd: string, files: string[]): AxiomTaskPrimerFileStructure[] {
	const out: AxiomTaskPrimerFileStructure[] = [];
	for (const file of files.slice(0, MAX_FILE_STRUCTURES)) {
		try {
			const fullPath = resolvePath(cwd, file);
			if (!existsSync(fullPath)) continue;
			const stat = statSync(fullPath);
			if (!stat.isFile() || stat.size > 250_000) continue;
			const source = readFileSync(fullPath, "utf-8");
			if (source.includes("\0")) continue;
			const understanding = analyzeFile(file, source);
			if (understanding.symbols.length === 0 && understanding.imports.length === 0) continue;
			out.push({
				file,
				language: understanding.language,
				lineCount: understanding.lineCount,
				symbols: understanding.symbols.slice(0, 10).map((symbol) => ({
					kind: symbol.kind,
					name: symbol.name,
					line: symbol.line,
				})),
				imports: understanding.imports.slice(0, 8),
			});
		} catch {
			// Best-effort evidence only.
		}
	}
	return out;
}

function buildFlowSlices(flowGraphs: FlowGraphStore, symbols: string[]): AxiomTaskPrimerFlowSlice[] {
	const graphId = safeLatestFlowGraphId(flowGraphs);
	if (!graphId) return [];
	const slices: AxiomTaskPrimerFlowSlice[] = [];
	const seenFocus = new Set<string>();
	for (const symbol of symbols.slice(0, MAX_FLOW_SLICES)) {
		try {
			const slice = flowGraphs.slice(graphId, symbol, { mode: "expanded", limit: 5, maxDepth: 2 });
			if (!slice.focus) continue;
			if (seenFocus.has(slice.focus.label)) continue;
			seenFocus.add(slice.focus.label);
			slices.push(compactFlowSlice(slice));
		} catch {
			// Symbol absent in graph; try the next one.
		}
	}
	if (slices.length === 0) {
		try {
			slices.push(compactFlowSlice(flowGraphs.slice(graphId, undefined, { mode: "summary", limit: 5 })));
		} catch {
			return [];
		}
	}
	return slices.slice(0, MAX_FLOW_SLICES);
}

function safeLatestFlowGraphId(flowGraphs: FlowGraphStore): string | undefined {
	try {
		return flowGraphs.latestGraphId();
	} catch {
		return undefined;
	}
}

function compactFlowSlice(slice: FlowGraphSliceResult): AxiomTaskPrimerFlowSlice {
	return {
		graphId: slice.graph.id,
		mode: slice.mode,
		focus: slice.focus?.label,
		sections: slice.sections.slice(0, 4).map((section) => ({
			title: section.title,
			nodes: section.nodes.slice(0, 6).map((node) => compactNodeLabel(node.label, node.kind, node.path, node.line)),
			edges: section.edges
				.slice(0, 8)
				.map((edge) => `${edge.kind}${edge.label ? `:${edge.label}` : ""}@${edge.line ?? "?"}`),
		})),
		expansionHints: slice.expansionHints.slice(0, 5).map((hint) => hint.node.label),
	};
}

function compactNodeLabel(label: string, kind: string, path?: string, line?: number): string {
	const location = path ? ` ${path}${line ? `:${line}` : ""}` : "";
	return `${label} [${kind}]${location}`.slice(0, 160);
}

function safeSearch<T extends { nodes: Array<{ label?: string }> }>(
	store: { search: (query: string, opts?: { limit?: number }) => T[] },
	query: string,
): T[] {
	try {
		return store.search(query, { limit: 3 });
	} catch {
		return [];
	}
}

function uniqueLabels<T extends { nodes: Array<{ label?: string }> }>(hits: T[]): string[] {
	const out = new Set<string>();
	for (const hit of hits) {
		for (const node of hit.nodes) {
			if (node.label && node.label.length < 80) out.add(node.label);
		}
	}
	return [...out];
}

function uniqueLowercased(terms: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const t of terms) {
		const key = t.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
	}
	return out;
}

function estimatePrimerTokens(
	bugLens: AxiomTaskPrimerBugLensCandidate[],
	fileHits: AxiomTaskPrimerFileHit[],
	symbolWalks: AxiomTaskPrimerSymbolWalk[],
	extractedSymbols: string[],
	fileStructures: AxiomTaskPrimerFileStructure[],
	flowSlices: AxiomTaskPrimerFlowSlice[],
	documentHits: AxiomSparseTreeGrepHit[],
): number {
	// Loose char/4 estimator, matches the actual emitter in renderTaskPrimerBrief.
	let chars = extractedSymbols.join(", ").length;
	for (const candidate of bugLens) {
		chars += candidate.file.length + candidate.reasons.join(", ").length + 32;
		for (const line of candidate.sampleLines) chars += line.text.length + 8;
	}
	for (const hit of fileHits) {
		chars += hit.file.length + 16;
		for (const ln of hit.sampleLines) chars += ln.text.length + 8;
	}
	for (const structure of fileStructures) {
		chars +=
			structure.file.length + structure.language.length + structure.symbols.map((s) => s.name).join(", ").length;
	}
	for (const walk of symbolWalks) {
		chars += walk.symbol.length;
		chars += walk.codeGraphNeighbors.join(", ").length;
		chars += walk.flowGraphNeighbors.join(", ").length;
	}
	for (const slice of flowSlices) {
		chars +=
			(slice.focus ?? slice.mode).length + slice.sections.flatMap((s) => [...s.nodes, ...s.edges]).join(", ").length;
	}
	for (const hit of documentHits) {
		chars += hit.documentName.length + hit.chunkSummary.length + 40;
	}
	return Math.ceil(chars / 4);
}

/**
 * Render the primer into the prose block that gets appended to the system
 * prompt. Hard-capped at ~500 tokens (~2000 chars) — sections are emitted in
 * order of estimated value and truncated when the budget runs out.
 */
export function renderTaskPrimerBrief(primer: AxiomTaskPrimer, maxTokens: number): string {
	if (
		primer.bugLens.length === 0 &&
		primer.fileHits.length === 0 &&
		primer.symbolWalks.length === 0 &&
		primer.extractedSymbols.length === 0 &&
		primer.fileStructures.length === 0 &&
		primer.flowSlices.length === 0 &&
		primer.documentHits.length === 0
	) {
		return "";
	}
	const maxChars = Math.max(400, maxTokens * 4);
	const lines: string[] = [];
	lines.push("# Evidence Pack (auto-retrieved)");
	lines.push("");
	lines.push(
		"AXIOM ran a pre-flight over repo text, code structure, code/flow graphs, and indexed documents. Use this to skip discovery and go straight to evidence. Do NOT cite this section back; verify with tools before editing.",
	);
	lines.push("");

	if (primer.bugLens.length > 0) {
		lines.push("**BugLens ranked suspects:**");
		for (const candidate of primer.bugLens) {
			lines.push(`- \`${candidate.file}\` (score ${candidate.score}): ${candidate.reasons.join("; ")}`);
			if (candidate.symbols.length > 0) {
				lines.push(
					`  - nearby symbols: ${candidate.symbols.map((s) => `${s.kind} ${s.name}@${s.line}`).join(", ")}`,
				);
			}
			for (const sample of candidate.sampleLines) {
				lines.push(`  - L${sample.line}: ${sample.text.trim()}`);
			}
		}
		lines.push("");
	}

	if (primer.fileHits.length > 0) {
		lines.push("**Likely-relevant files (rg + symbol index):**");
		for (const hit of primer.fileHits) {
			lines.push(`- \`${hit.file}\` (${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"})`);
			for (const sample of hit.sampleLines) {
				lines.push(`  - L${sample.line}: ${sample.text.trim()}`);
			}
		}
		lines.push("");
	}

	if (primer.fileStructures.length > 0) {
		lines.push("**File structure (understand_code preflight):**");
		for (const structure of primer.fileStructures) {
			const symbols = structure.symbols.map((s) => `${s.kind} ${s.name}@${s.line}`).join(", ");
			lines.push(`- \`${structure.file}\` (${structure.language}, ${structure.lineCount} lines)`);
			if (symbols) lines.push(`  - symbols: ${symbols}`);
			if (structure.imports.length > 0) lines.push(`  - imports: ${structure.imports.join(", ")}`);
		}
		lines.push("");
	}

	if (primer.symbolWalks.length > 0) {
		lines.push("**Symbol map (from CodeGraph/FlowGraph):**");
		for (const walk of primer.symbolWalks) {
			const calls = walk.codeGraphNeighbors.length > 0 ? walk.codeGraphNeighbors.join(", ") : "(none in graph)";
			const flows = walk.flowGraphNeighbors.length > 0 ? walk.flowGraphNeighbors.join(", ") : "(none in graph)";
			lines.push(`- \`${walk.symbol}\` → calls/callers: ${calls}; data: ${flows}`);
		}
		lines.push("");
	}

	if (primer.flowSlices.length > 0) {
		lines.push("**Flow slices (flow_graph summary/expanded):**");
		for (const slice of primer.flowSlices) {
			lines.push(`- graph ${slice.graphId}, ${slice.mode}${slice.focus ? `, focus ${slice.focus}` : ""}`);
			for (const section of slice.sections) {
				const nodeText = section.nodes.length > 0 ? ` nodes: ${section.nodes.join("; ")}` : "";
				const edgeText = section.edges.length > 0 ? ` edges: ${section.edges.join("; ")}` : "";
				lines.push(`  - ${section.title}:${nodeText}${edgeText}`);
			}
			if (slice.expansionHints.length > 0) {
				lines.push(`  - expand next: ${slice.expansionHints.join(", ")}`);
			}
		}
		lines.push("");
	}

	if (primer.documentHits.length > 0) {
		lines.push("**Document hits (SparseTreeGrep):**");
		for (const hit of primer.documentHits) {
			lines.push(
				`- \`${hit.documentName}\` ${hit.chunkId}${hit.nodeLabel ? ` (${hit.nodeLabel})` : ""}, page ${hit.page}, bytes ${hit.byteStart}-${hit.byteEnd}`,
			);
			lines.push(`  - ${truncate(hit.chunkSummary, 220)}`);
		}
		lines.push("");
	}

	const rendered = lines.join("\n");
	if (rendered.length <= maxChars) return rendered;
	// Hard-cap: drop sample lines first, then walk neighbors, before truncating raw.
	return `${rendered.slice(0, maxChars - 16)}\n... (truncated)`;
}

function truncate(text: string, maxChars: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}
