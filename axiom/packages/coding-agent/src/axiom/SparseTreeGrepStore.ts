import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { getEmbedder } from "./embedder.ts";
import type {
	AxiomSparseTreeGrepChunk,
	AxiomSparseTreeGrepChunkDescription,
	AxiomSparseTreeGrepHit,
	AxiomSparseTreeGrepIndex,
	AxiomSparseTreeGrepNode,
} from "./RuntimeTypes.ts";

const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"and",
	"are",
	"as",
	"at",
	"because",
	"been",
	"before",
	"between",
	"but",
	"can",
	"could",
	"did",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"her",
	"him",
	"his",
	"in",
	"into",
	"is",
	"its",
	"not",
	"of",
	"on",
	"one",
	"or",
	"our",
	"she",
	"that",
	"the",
	"their",
	"then",
	"there",
	"they",
	"this",
	"through",
	"to",
	"was",
	"were",
	"with",
	"you",
]);

const ENTITY_STOPWORDS = new Set([
	"A",
	"An",
	"And",
	"As",
	"At",
	"But",
	"By",
	"For",
	"From",
	"He",
	"Her",
	"His",
	"I",
	"In",
	"It",
	"On",
	"Or",
	"She",
	"So",
	"That",
	"The",
	"They",
	"This",
	"To",
	"We",
	"With",
]);

const QUERY_EXPANSIONS: Record<string, string[]> = {
	argue: ["argument", "quarrel", "shout", "fight", "conflict"],
	argument: ["argue", "quarrel", "shout", "fight", "conflict"],
	battle: ["fight", "gunfight", "combat", "clash", "attack", "duel"],
	chase: ["pursuit", "run", "escape", "flee", "follow"],
	conflict: ["fight", "argument", "clash", "battle", "struggle"],
	death: ["dead", "dies", "killed", "murder", "corpse"],
	fight: ["battle", "brawl", "clash", "combat", "conflict", "duel", "gunfight", "punch", "shootout", "struggle"],
	fistfight: ["fight", "brawl", "punch", "struggle", "clash"],
	gunfight: ["fight", "battle", "shootout", "gun", "pistol", "rifle", "weapon"],
	love: ["romance", "kiss", "heart", "affection", "relationship"],
	murder: ["kill", "killed", "death", "dead", "blood"],
	scene: ["moment", "event", "sequence", "section", "passage"],
	shootout: ["gunfight", "fight", "gun", "pistol", "rifle", "weapon"],
};

const ACTION_SIGNAL_WORDS = new Set([
	"alarm",
	"ambush",
	"argue",
	"argument",
	"attack",
	"battle",
	"brawl",
	"catch",
	"chase",
	"clash",
	"combat",
	"conflict",
	"duel",
	"escape",
	"fight",
	"flee",
	"gunfight",
	"hit",
	"kill",
	"murder",
	"pistol",
	"punch",
	"rifle",
	"run",
	"shoot",
	"shootout",
	"shout",
	"stab",
	"struggle",
	"weapon",
]);

interface LoadedText {
	text: string;
	sourceKind: AxiomSparseTreeGrepIndex["sourceKind"];
	totalBytes: number;
}

interface CandidateChunk {
	text: string;
	charStart: number;
	charEnd: number;
	byteStart: number;
	byteEnd: number;
	lineStart: number;
	lineEnd: number;
	page: number;
}

interface SparseTreeGrepCandidate {
	index: AxiomSparseTreeGrepIndex;
	chunk: AxiomSparseTreeGrepChunk;
	node?: AxiomSparseTreeGrepNode;
	matchedKeywords: string[];
	lexicalScore: number;
	semanticScore?: number;
}

export interface SparseTreeGrepIndexOptions {
	path: string;
	title?: string;
	maxBytes?: number;
	maxChunks?: number;
}

export interface SparseTreeGrepExtractResult {
	hit: AxiomSparseTreeGrepHit;
	text: string;
}

export interface SparseTreeGrepDescribeOptions {
	documentId: string;
	query?: string;
	nodeId?: string;
	chunkIds?: string[];
	limit?: number;
	around?: number;
	force?: boolean;
}

export interface SparseTreeGrepDescription {
	hit: AxiomSparseTreeGrepHit;
	description: AxiomSparseTreeGrepChunkDescription;
}

export class SparseTreeGrepStore {
	private readonly baseDir: string;
	private readonly docsDir: string;
	/**
	 * Parsed-index cache. `listIndexes()` and `load()` are called on the hot
	 * path of TaskPrimer; without this cache every search re-reads every JSON
	 * blob from disk (~16ms with 2k chunks, ~3-5ms with a few smaller docs).
	 * Keyed by documentId; invalidated by file mtimeMs so a separate process
	 * rewriting the index transparently busts the cache without us having to
	 * parse the JSON to check the `updatedAt` field.
	 */
	private readonly cache = new Map<string, { mtimeMs: number; index: AxiomSparseTreeGrepIndex }>();
	/** Set of documentIds known to exist on disk after the most recent
	 * `listIndexes()` scan. Used by `listIndexes()` to avoid re-reading every
	 * file when the directory listing hasn't changed. */
	private listScanDirSig: string | undefined;
	private listScanResult: AxiomSparseTreeGrepIndex[] = [];

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "sparse-tree-grep");
		this.docsDir = join(this.baseDir, "docs");
	}

	async indexDocument(options: SparseTreeGrepIndexOptions): Promise<AxiomSparseTreeGrepIndex> {
		const sourcePath = resolve(options.path);
		if (!existsSync(sourcePath)) throw new Error(`Document not found: ${sourcePath}`);
		const maxBytes = Math.max(10_000, options.maxBytes ?? 8_000_000);
		const loaded = loadText(sourcePath, maxBytes);
		const maxChunks = Math.max(1, Math.min(10_000, options.maxChunks ?? 2_000));
		const rawChunks = splitIntoChunks(loaded.text).slice(0, maxChunks);
		const documentId = `doc_${hash(`${sourcePath}:${loaded.totalBytes}:${loaded.text.slice(0, 400)}`, 18)}`;
		const chunks: AxiomSparseTreeGrepChunk[] = rawChunks.map((chunk, index) => {
			const entities = extractEntities(chunk.text);
			const tokens = tokenize(chunk.text);
			const phrases = topPhrases(tokens, 10);
			const entityTerms = entities.flatMap((entity) => tokenize(entity));
			return {
				id: `chk_${index + 1}`,
				chunkIndex: index + 1,
				byteStart: chunk.byteStart,
				byteEnd: chunk.byteEnd,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				page: chunk.page,
				summary: summarizeChunk(chunk.text),
				keywords: topTerms([...tokens, ...entityTerms, ...flattenPhraseTerms(phrases)], 18),
				entities,
				phrases,
			};
		});

		// Optional embedding step. Only fires when @xenova/transformers is
		// installed and a model loads successfully. We embed the chunk SUMMARY
		// (already compressed prose), not the raw text — keeps the bytes-to-
		// signal ratio high and batches stay cheap. Quietly skips on tiny docs
		// where TF-IDF is already sufficient (under 6 chunks).
		let embedderModel: string | undefined;
		let embeddingDim: number | undefined;
		if (chunks.length >= 6) {
			try {
				const embedder = await getEmbedder();
				if (embedder) {
					const summaries = chunks.map((c) => embeddingTextForChunk(c));
					const vectors = await embedder.embed(summaries);
					for (let i = 0; i < chunks.length; i++) {
						const vec = vectors[i];
						if (vec) chunks[i].embedding = Array.from(vec);
					}
					embedderModel = embedder.modelId;
					embeddingDim = embedder.dim;
				}
			} catch {
				// Embedder threw mid-batch — leave the chunks without
				// embeddings; TF-IDF still works.
			}
		}

		const nodes = buildTreeNodes(chunks);
		const now = new Date().toISOString();
		const index: AxiomSparseTreeGrepIndex = {
			version: 1,
			documentId,
			documentName: options.title?.trim() || basename(sourcePath),
			sourcePath,
			textPath: loaded.sourceKind === "pdf_text" ? join(this.docsDir, `${documentId}.txt`) : undefined,
			sourceKind: loaded.sourceKind,
			totalBytes: loaded.totalBytes,
			generatedAt: now,
			updatedAt: now,
			chunkCount: chunks.length,
			pageCount: Math.max(1, ...chunks.map((chunk) => chunk.page)),
			chunks,
			nodes,
			embedderModel,
			embeddingDim,
		};
		this.save(index);
		if (index.textPath) {
			writeFileSync(index.textPath, loaded.text, "utf-8");
		}
		return index;
	}

	/**
	 * Compute the query-side embedding. Async so the caller can await once,
	 * then run the synchronous `search()` with `queryEmbedding` set. Returns
	 * undefined when the embedder is unavailable (missing dep, model load
	 * failure) — callers should treat that as "fall back to TF-IDF only."
	 */
	async embedQuery(query: string): Promise<Float32Array | undefined> {
		try {
			const embedder = await getEmbedder();
			if (!embedder) return undefined;
			const trimmed = query.trim();
			if (!trimmed) return undefined;
			const [vec] = await embedder.embed([trimmed]);
			return vec;
		} catch {
			return undefined;
		}
	}

	/**
	 * Async convenience for the tool/runtime path: compute the query embedding
	 * once, then run the global reranker. If embeddings are unavailable, this
	 * silently falls back to lexical SparseTreeGrep search.
	 */
	async searchReranked(
		query: string,
		options?: { documentId?: string; limit?: number },
	): Promise<AxiomSparseTreeGrepHit[]> {
		const queryEmbedding = await this.embedQuery(query);
		return this.search(query, { ...options, queryEmbedding });
	}

	search(
		query: string,
		options?: { documentId?: string; limit?: number; queryEmbedding?: Float32Array },
	): AxiomSparseTreeGrepHit[] {
		const queryTokens = expandQueryTokens(tokenize(query));
		const queryEmbedding = options?.queryEmbedding;
		if (queryTokens.length === 0 && !queryEmbedding) return [];
		const limit = Math.max(1, Math.min(50, options?.limit ?? 8));
		const indexes = options?.documentId ? [this.load(options.documentId)].filter(Boolean) : this.listIndexes();
		const candidates = new Map<string, SparseTreeGrepCandidate>();
		for (const index of indexes) {
			if (!index) continue;
			const nodeScores = scoreNodes(index, queryTokens);
			const chunkScores = scoreChunks(index, queryTokens);
			const useSemantic = !!queryEmbedding && !!index.embeddingDim && queryEmbedding.length === index.embeddingDim;
			for (const chunkScore of chunkScores.slice(0, Math.max(limit * 4, 24))) {
				const nodeScore = nodeScores.find((node) => node.node.chunkIds.includes(chunkScore.chunk.id));
				upsertCandidate(candidates, {
					index,
					chunk: chunkScore.chunk,
					node: nodeScore?.node,
					matchedKeywords: [...new Set([...chunkScore.matchedKeywords, ...(nodeScore?.matchedKeywords ?? [])])],
					lexicalScore: chunkScore.score + (nodeScore?.score ?? 0) * 0.2,
					semanticScore: useSemantic ? cosineForChunk(queryEmbedding, chunkScore.chunk) : undefined,
				});
			}
			if (useSemantic) {
				// Semantic-only top-up: surface chunks with high cosine
				// similarity that TF-IDF didn't catch (the paraphrase case).
				const semantic: Array<{ chunk: AxiomSparseTreeGrepChunk; cosineScore: number }> = [];
				for (const chunk of index.chunks) {
					const c = cosineForChunk(queryEmbedding, chunk);
					if (c === undefined) continue;
					if (c < 0.35) continue; // floor: skip noise
					semantic.push({ chunk, cosineScore: c });
				}
				semantic.sort((a, b) => b.cosineScore - a.cosineScore);
				for (const { chunk, cosineScore } of semantic.slice(0, Math.max(limit * 2, 12))) {
					const nodeScore = nodeScores.find((node) => node.node.chunkIds.includes(chunk.id));
					upsertCandidate(candidates, {
						index,
						chunk,
						node: nodeScore?.node,
						matchedKeywords: nodeScore?.matchedKeywords ?? [],
						lexicalScore: (nodeScore?.score ?? 0) * 0.2,
						semanticScore: cosineScore,
					});
				}
			}
		}
		return rerankCandidates([...candidates.values()], !!queryEmbedding)
			.map(({ candidate, score }) =>
				toHit(candidate.index, candidate.chunk, score, {
					node: candidate.node,
					matchedKeywords: candidate.matchedKeywords,
				}),
			)
			.slice(0, limit);
	}

	expand(
		documentId: string,
		nodeId?: string,
		limit = 20,
	): {
		index: AxiomSparseTreeGrepIndex;
		nodes: AxiomSparseTreeGrepNode[];
		occurrences: AxiomSparseTreeGrepHit[];
	} {
		const index = this.require(documentId);
		const rootNodes = index.nodes.filter((node) => (nodeId ? node.parentId === nodeId : node.level === 0));
		const node = nodeId ? index.nodes.find((candidate) => candidate.id === nodeId) : undefined;
		const chunkIds = node?.chunkIds ?? rootNodes.flatMap((candidate) => candidate.chunkIds);
		const occurrences = [...new Set(chunkIds)]
			.map((chunkId) => index.chunks.find((chunk) => chunk.id === chunkId))
			.filter((chunk): chunk is AxiomSparseTreeGrepChunk => chunk !== undefined)
			.slice(0, Math.max(1, limit))
			.map((chunk) => toHit(index, chunk, 1, { node, matchedKeywords: node?.keywords ?? [] }));
		return { index, nodes: rootNodes.slice(0, Math.max(1, limit)), occurrences };
	}

	describe(options: SparseTreeGrepDescribeOptions): {
		index: AxiomSparseTreeGrepIndex;
		descriptions: SparseTreeGrepDescription[];
	} {
		const index = this.require(options.documentId);
		const limit = Math.max(1, Math.min(24, options.limit ?? 4));
		const around = Math.max(0, Math.min(3, options.around ?? 0));
		const selected = selectChunksForDescription(index, options, limit);
		const descriptions: SparseTreeGrepDescription[] = [];
		let changed = false;
		for (const chunk of selected) {
			if (!chunk.description || options.force) {
				const contextText = readChunkWindow(index, chunk, around);
				chunk.description = buildChunkDescription(index, chunk, contextText, options.query, around);
				changed = true;
			}
			descriptions.push({
				hit: toHit(index, chunk, 1, { matchedKeywords: chunk.keywords }),
				description: chunk.description,
			});
		}
		if (changed) {
			index.updatedAt = new Date().toISOString();
			this.save(index);
		}
		return { index, descriptions };
	}

	extract(documentId: string, chunkId: string, around = 0): SparseTreeGrepExtractResult {
		const index = this.require(documentId);
		const chunk = index.chunks.find((candidate) => candidate.id === chunkId);
		if (!chunk) throw new Error(`Chunk not found: ${chunkId}`);
		const startIndex = Math.max(0, chunk.chunkIndex - 1 - Math.max(0, around));
		const endIndex = Math.min(index.chunks.length - 1, chunk.chunkIndex - 1 + Math.max(0, around));
		const start = index.chunks[startIndex]?.byteStart ?? chunk.byteStart;
		const end = index.chunks[endIndex]?.byteEnd ?? chunk.byteEnd;
		return {
			hit: toHit(index, chunk, 1, { matchedKeywords: chunk.keywords }),
			text: readByteRange(index.textPath ?? index.sourcePath, start, end),
		};
	}

	listIndexes(): AxiomSparseTreeGrepIndex[] {
		if (!existsSync(this.docsDir)) return [];
		// Cache the directory listing under a signature of "filename:mtime"
		// across all .json blobs. If nothing has changed since the last scan,
		// reuse the previously-parsed result and skip every JSON.parse.
		const files = readdirSync(this.docsDir).filter((f) => f.endsWith(".json"));
		const sig = files
			.map((f) => {
				try {
					return `${f}:${statSync(join(this.docsDir, f)).mtimeMs}`;
				} catch {
					return `${f}:0`;
				}
			})
			.sort()
			.join("|");
		if (this.listScanDirSig === sig) {
			return this.listScanResult;
		}
		const indexes: AxiomSparseTreeGrepIndex[] = [];
		for (const file of files) {
			const fullPath = join(this.docsDir, file);
			try {
				const mtimeMs = statSync(fullPath).mtimeMs;
				const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as AxiomSparseTreeGrepIndex;
				if (parsed.version === 1) {
					indexes.push(parsed);
					this.cache.set(parsed.documentId, { mtimeMs, index: parsed });
				}
			} catch {
				// skip malformed index
			}
		}
		indexes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		this.listScanDirSig = sig;
		this.listScanResult = indexes;
		return indexes;
	}

	load(documentId: string): AxiomSparseTreeGrepIndex | undefined {
		const path = join(this.docsDir, `${documentId}.json`);
		if (!existsSync(path)) {
			this.cache.delete(documentId);
			return undefined;
		}
		// Cache hit when on-disk mtime matches. `statSync` is much cheaper than
		// re-parsing the JSON blob.
		const cached = this.cache.get(documentId);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached.index;
		}
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as AxiomSparseTreeGrepIndex;
			this.cache.set(documentId, { mtimeMs, index: parsed });
			return parsed;
		} catch {
			return undefined;
		}
	}

	require(documentId: string): AxiomSparseTreeGrepIndex {
		const index = this.load(documentId);
		if (!index) throw new Error(`SparseTreeGrep document not found: ${documentId}`);
		return index;
	}

	stats(): { documentCount: number; chunkCount: number; nodeCount: number } {
		const indexes = this.listIndexes();
		return {
			documentCount: indexes.length,
			chunkCount: indexes.reduce((sum, index) => sum + index.chunkCount, 0),
			nodeCount: indexes.reduce((sum, index) => sum + index.nodes.length, 0),
		};
	}

	clearCache(): void {
		this.cache.clear();
		this.listScanDirSig = undefined;
		this.listScanResult = [];
	}

	private save(index: AxiomSparseTreeGrepIndex): void {
		if (!existsSync(this.docsDir)) mkdirSync(this.docsDir, { recursive: true });
		const path = join(this.docsDir, `${index.documentId}.json`);
		writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
		try {
			this.cache.set(index.documentId, { mtimeMs: statSync(path).mtimeMs, index });
		} catch {
			this.cache.delete(index.documentId);
		}
		this.listScanDirSig = undefined;
		writeFileSync(join(this.baseDir, "INDEX_REPORT.md"), renderReport(this.listIndexes()), "utf-8");
	}
}

function loadText(sourcePath: string, maxBytes: number): LoadedText {
	const stat = statSync(sourcePath);
	if (stat.size > maxBytes) {
		throw new Error(`Document is ${stat.size} bytes, over SparseTreeGrep maxBytes ${maxBytes}.`);
	}
	const ext = extname(sourcePath).toLowerCase();
	if (ext === ".pdf") {
		const result = spawnSync("pdftotext", ["-layout", sourcePath, "-"], {
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: maxBytes * 2,
		});
		if (result.status === 0 && result.stdout.trim()) {
			return {
				text: result.stdout,
				sourceKind: "pdf_text",
				totalBytes: Buffer.byteLength(result.stdout, "utf-8"),
			};
		}
		throw new Error("PDF indexing needs `pdftotext` on PATH, or convert the PDF to .txt first.");
	}
	const buffer = readFileSync(sourcePath);
	if (buffer.includes(0)) throw new Error("SparseTreeGrep only indexes text-like documents.");
	return { text: buffer.toString("utf-8"), sourceKind: "text", totalBytes: buffer.length };
}

function splitIntoChunks(text: string): CandidateChunk[] {
	const chunks: CandidateChunk[] = [];
	const paragraphRe = /\S[\s\S]*?(?=\n\s*\n|$)/g;
	let match: RegExpExecArray | null = paragraphRe.exec(text);
	while (match) {
		const raw = match[0];
		const leading = raw.search(/\S/);
		const trailing = raw.search(/\s*$/);
		const start = match.index + Math.max(0, leading);
		const end = trailing >= 0 ? match.index + trailing : match.index + raw.length;
		if (end > start) {
			for (const part of splitLargeRange(text, start, end, 2600)) {
				chunks.push(toCandidateChunk(text, part.start, part.end));
			}
		}
		match = paragraphRe.exec(text);
	}
	if (chunks.length === 0 && text.trim()) chunks.push(toCandidateChunk(text, 0, text.length));
	return chunks;
}

function splitLargeRange(
	text: string,
	start: number,
	end: number,
	maxChars: number,
): Array<{ start: number; end: number }> {
	const out: Array<{ start: number; end: number }> = [];
	let cursor = start;
	while (cursor < end) {
		const hardEnd = Math.min(end, cursor + maxChars);
		if (hardEnd === end) {
			out.push({ start: cursor, end });
			break;
		}
		const window = text.slice(cursor, hardEnd);
		const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
		const nextEnd = sentenceBreak > maxChars * 0.45 ? cursor + sentenceBreak + 1 : hardEnd;
		out.push({ start: cursor, end: nextEnd });
		cursor = nextEnd;
		while (cursor < end && /\s/.test(text[cursor] ?? "")) cursor++;
	}
	return out;
}

function toCandidateChunk(text: string, charStart: number, charEnd: number): CandidateChunk {
	return {
		text: text.slice(charStart, charEnd),
		charStart,
		charEnd,
		byteStart: Buffer.byteLength(text.slice(0, charStart), "utf-8"),
		byteEnd: Buffer.byteLength(text.slice(0, charEnd), "utf-8"),
		lineStart: 1 + countMatches(text.slice(0, charStart), /\n/g),
		lineEnd: 1 + countMatches(text.slice(0, charEnd), /\n/g),
		page: pageForOffset(text, charStart),
	};
}

function buildTreeNodes(chunks: AxiomSparseTreeGrepChunk[]): AxiomSparseTreeGrepNode[] {
	const termToChunks = new Map<string, Set<string>>();
	const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	for (const chunk of chunks) {
		const nodeTerms = [
			...chunk.keywords.slice(0, 12),
			...(chunk.entities ?? []).flatMap((entity) => tokenize(entity)),
			...(chunk.phrases ?? []).slice(0, 8),
		];
		for (const term of [...new Set(nodeTerms)]) {
			let set = termToChunks.get(term);
			if (!set) {
				set = new Set();
				termToChunks.set(term, set);
			}
			set.add(chunk.id);
		}
	}
	const caps = treeCaps(chunks.length);
	const sortedTerms = [...termToChunks.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
	let rootTerms = sortedTerms.filter(([, ids]) => ids.size >= caps.minRootOccurrence).slice(0, caps.rootLimit);
	if (rootTerms.length === 0) {
		rootTerms = sortedTerms.slice(0, Math.min(caps.rootLimit, 8));
	}
	const nodes: AxiomSparseTreeGrepNode[] = [];
	for (const [term, ids] of rootTerms) {
		const chunkIds = [...ids].sort(
			(a, b) => (chunkById.get(a)?.chunkIndex ?? 0) - (chunkById.get(b)?.chunkIndex ?? 0),
		);
		const nodeId = `node_${hash(term, 12)}`;
		const children = coTermsFor(term, chunkIds, chunkById)
			.filter((child) => child.chunkIds.length >= caps.minChildOccurrence)
			.slice(0, caps.childLimit);
		nodes.push({
			id: nodeId,
			label: term,
			level: 0,
			summary: summarizeNode(term, chunkIds, chunkById),
			keywords: [term],
			chunkIds,
			childIds: children.map((child) => `${nodeId}_${hash(child.term, 8)}`),
			occurrenceCount: chunkIds.length,
		});
		for (const child of children) {
			nodes.push({
				id: `${nodeId}_${hash(child.term, 8)}`,
				label: `${term} / ${child.term}`,
				level: 1,
				parentId: nodeId,
				summary: summarizeNode(child.term, child.chunkIds, chunkById),
				keywords: [term, child.term],
				chunkIds: child.chunkIds,
				childIds: [],
				occurrenceCount: child.chunkIds.length,
			});
		}
	}
	return nodes;
}

function treeCaps(chunkCount: number): {
	rootLimit: number;
	childLimit: number;
	minRootOccurrence: number;
	minChildOccurrence: number;
} {
	if (chunkCount <= 1) {
		return { rootLimit: 8, childLimit: 2, minRootOccurrence: 1, minChildOccurrence: 1 };
	}
	if (chunkCount <= 3) {
		return { rootLimit: 12, childLimit: 3, minRootOccurrence: 1, minChildOccurrence: 1 };
	}
	if (chunkCount <= 20) {
		return { rootLimit: Math.min(32, chunkCount * 4), childLimit: 4, minRootOccurrence: 2, minChildOccurrence: 1 };
	}
	return {
		rootLimit: Math.min(80, Math.max(32, Math.ceil(Math.sqrt(chunkCount) * 12))),
		childLimit: 8,
		minRootOccurrence: 2,
		minChildOccurrence: 2,
	};
}

function coTermsFor(
	term: string,
	chunkIds: string[],
	chunkById: Map<string, AxiomSparseTreeGrepChunk>,
): Array<{ term: string; chunkIds: string[] }> {
	const map = new Map<string, string[]>();
	for (const id of chunkIds) {
		const chunk = chunkById.get(id);
		if (!chunk) continue;
		for (const keyword of chunk.keywords) {
			if (keyword === term) continue;
			const ids = map.get(keyword) ?? [];
			ids.push(id);
			map.set(keyword, ids);
		}
	}
	return [...map.entries()]
		.map(([key, ids]) => ({ term: key, chunkIds: [...new Set(ids)] }))
		.sort((a, b) => b.chunkIds.length - a.chunkIds.length || a.term.localeCompare(b.term));
}

function scoreNodes(
	index: AxiomSparseTreeGrepIndex,
	queryTokens: string[],
): Array<{ node: AxiomSparseTreeGrepNode; score: number; matchedKeywords: string[] }> {
	return index.nodes
		.map((node) => {
			const nodeTerms = new Set([...node.keywords, ...tokenize(node.label), ...tokenize(node.summary)]);
			const matched = queryTokens.filter((token) => nodeTerms.has(token));
			return {
				node,
				score: matched.length * 4 + Math.log1p(node.occurrenceCount),
				matchedKeywords: [...new Set(matched)],
			};
		})
		.filter((hit) => hit.matchedKeywords.length > 0)
		.sort((a, b) => b.score - a.score);
}

function scoreChunks(
	index: AxiomSparseTreeGrepIndex,
	queryTokens: string[],
): Array<{ chunk: AxiomSparseTreeGrepChunk; score: number; matchedKeywords: string[] }> {
	const queryTokenSet = new Set(queryTokens);
	return index.chunks
		.map((chunk) => {
			const terms = new Set([
				...chunk.keywords,
				...tokenize(chunk.summary),
				...(chunk.entities ?? []).flatMap((entity) => tokenize(entity)),
				...(chunk.phrases ?? []),
				...(chunk.description ? tokenize(chunk.description.description) : []),
			]);
			const matched = queryTokens.filter((token) => terms.has(token));
			const entityBonus = coMentionBonus(queryTokenSet, chunk);
			const actionBonus = actionSignalBonus(queryTokenSet, chunk);
			const phraseBonus =
				queryTokens.length > 1 && chunk.summary.toLowerCase().includes(queryTokens.join(" ")) ? 4 : 0;
			return {
				chunk,
				score:
					matched.length * 6 + phraseBonus + entityBonus + actionBonus + Math.min(chunk.keywords.length, 8) / 10,
				matchedKeywords: [...new Set(matched)],
			};
		})
		.filter((hit) => hit.matchedKeywords.length > 0)
		.sort((a, b) => b.score - a.score);
}

function toHit(
	index: AxiomSparseTreeGrepIndex,
	chunk: AxiomSparseTreeGrepChunk,
	score: number,
	options: { node?: AxiomSparseTreeGrepNode; matchedKeywords: string[] },
): AxiomSparseTreeGrepHit {
	return {
		score,
		documentId: index.documentId,
		documentName: index.documentName,
		sourcePath: index.sourcePath,
		nodeId: options.node?.id,
		nodeLabel: options.node?.label,
		chunkId: chunk.id,
		chunkSummary: chunk.summary,
		page: chunk.page,
		byteStart: chunk.byteStart,
		byteEnd: chunk.byteEnd,
		lineStart: chunk.lineStart,
		lineEnd: chunk.lineEnd,
		matchedKeywords: options.matchedKeywords,
	};
}

function upsertCandidate(candidates: Map<string, SparseTreeGrepCandidate>, candidate: SparseTreeGrepCandidate): void {
	const key = `${candidate.index.documentId}:${candidate.chunk.id}`;
	const existing = candidates.get(key);
	if (!existing) {
		candidates.set(key, candidate);
		return;
	}
	existing.lexicalScore = Math.max(existing.lexicalScore, candidate.lexicalScore);
	existing.semanticScore =
		existing.semanticScore === undefined
			? candidate.semanticScore
			: candidate.semanticScore === undefined
				? existing.semanticScore
				: Math.max(existing.semanticScore, candidate.semanticScore);
	existing.node ??= candidate.node;
	existing.matchedKeywords = [...new Set([...existing.matchedKeywords, ...candidate.matchedKeywords])];
}

function rerankCandidates(
	candidates: SparseTreeGrepCandidate[],
	hasQueryEmbedding: boolean,
): Array<{ candidate: SparseTreeGrepCandidate; score: number }> {
	const maxLexical = Math.max(1, ...candidates.map((candidate) => candidate.lexicalScore));
	const maxSemantic = Math.max(0.001, ...candidates.map((candidate) => Math.max(0, candidate.semanticScore ?? 0)));
	return candidates
		.map((candidate) => {
			if (!hasQueryEmbedding || candidate.semanticScore === undefined) {
				return { candidate, score: candidate.lexicalScore };
			}
			const lexical = candidate.lexicalScore / maxLexical;
			const semantic = Math.max(0, candidate.semanticScore) / maxSemantic;
			const exactKeywordBonus = candidate.matchedKeywords.length > 0 ? 0.05 : 0;
			const nodeBonus = candidate.node ? Math.min(0.08, Math.log1p(candidate.node.occurrenceCount) / 40) : 0;
			return {
				candidate,
				score: (lexical * 0.42 + semantic * 0.53 + exactKeywordBonus + nodeBonus) * 100,
			};
		})
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (b.candidate.index.updatedAt !== a.candidate.index.updatedAt) {
				return b.candidate.index.updatedAt.localeCompare(a.candidate.index.updatedAt);
			}
			return a.candidate.chunk.byteStart - b.candidate.chunk.byteStart;
		});
}

/**
 * Cosine between a query vector and a chunk's stored embedding. Returns
 * undefined when the chunk has no embedding (older index, embedder was
 * unavailable at index time). Length mismatch is treated as no-embedding —
 * caller falls back to TF-IDF for that chunk.
 */
function cosineForChunk(queryEmbedding: Float32Array, chunk: AxiomSparseTreeGrepChunk): number | undefined {
	const e = chunk.embedding;
	if (!e || e.length !== queryEmbedding.length) return undefined;
	// Inlined cosine: chunk embeddings live as plain number[] in the JSON.
	// Convert lazily here rather than materialize Float32Array per chunk.
	let dot = 0;
	for (let i = 0; i < e.length; i++) dot += queryEmbedding[i] * e[i];
	return dot;
}

function readByteRange(sourcePath: string, byteStart: number, byteEnd: number): string {
	const buffer = readFileSync(sourcePath);
	return buffer.subarray(byteStart, byteEnd).toString("utf-8");
}

function summarizeChunk(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= 260) return compact;
	const firstSentence = compact.match(/^.{80,260}?[.!?](?=\s|$)/)?.[0];
	return (firstSentence ?? compact.slice(0, 257)).trim() + (firstSentence ? "" : "...");
}

function embeddingTextForChunk(chunk: AxiomSparseTreeGrepChunk): string {
	return [
		chunk.summary || "(empty chunk)",
		chunk.entities?.length ? `entities: ${chunk.entities.join(", ")}` : "",
		chunk.phrases?.length ? `phrases: ${chunk.phrases.join(", ")}` : "",
		chunk.keywords.length ? `keywords: ${chunk.keywords.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function summarizeNode(term: string, chunkIds: string[], chunkById: Map<string, AxiomSparseTreeGrepChunk>): string {
	const samples = chunkIds
		.slice(0, 3)
		.map((id) => chunkById.get(id)?.summary)
		.filter((s): s is string => !!s);
	return `${term}: ${chunkIds.length} occurrence(s). ${samples.join(" / ")}`.slice(0, 420);
}

export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function expandQueryTokens(tokens: string[]): string[] {
	const out = new Set<string>();
	for (const token of tokens) {
		out.add(token);
		for (const expanded of QUERY_EXPANSIONS[token] ?? []) out.add(expanded);
	}
	return [...out];
}

function topTerms(tokens: string[], limit: number): string[] {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([term]) => term);
}

function topPhrases(tokens: string[], limit: number): string[] {
	const counts = new Map<string, number>();
	for (let i = 0; i < tokens.length - 1; i++) {
		const a = tokens[i];
		const b = tokens[i + 1];
		if (!a || !b || a === b) continue;
		const phrase = `${a} ${b}`;
		counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([phrase]) => phrase);
}

function flattenPhraseTerms(phrases: string[]): string[] {
	return phrases.flatMap((phrase) => phrase.split(/\s+/g));
}

function extractEntities(text: string): string[] {
	const counts = new Map<string, number>();
	const re = /\b[A-Z][a-zA-Z0-9']*(?:\s+(?:[A-Z][a-zA-Z0-9']*|of|the|and|de|van|von))*\b/g;
	let match: RegExpExecArray | null = re.exec(text);
	while (match) {
		const entity = match[0].trim().replace(/\s+/g, " ");
		if (!entity || ENTITY_STOPWORDS.has(entity)) {
			match = re.exec(text);
			continue;
		}
		const first = entity.split(/\s+/)[0];
		if (first && ENTITY_STOPWORDS.has(first) && !entity.includes(" ")) {
			match = re.exec(text);
			continue;
		}
		counts.set(entity, (counts.get(entity) ?? 0) + 1);
		match = re.exec(text);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 18)
		.map(([entity]) => entity);
}

function coMentionBonus(queryTokens: Set<string>, chunk: AxiomSparseTreeGrepChunk): number {
	const entityTerms = new Set((chunk.entities ?? []).flatMap((entity) => tokenize(entity)));
	let mentioned = 0;
	for (const token of queryTokens) {
		if (entityTerms.has(token)) mentioned++;
	}
	if (mentioned <= 1) return 0;
	return Math.min(12, mentioned * 4);
}

function actionSignalBonus(queryTokens: Set<string>, chunk: AxiomSparseTreeGrepChunk): number {
	const wantsAction = [...queryTokens].some((token) => ACTION_SIGNAL_WORDS.has(token));
	if (!wantsAction) return 0;
	const chunkTerms = new Set([...chunk.keywords, ...(chunk.phrases ?? []).flatMap((phrase) => phrase.split(/\s+/g))]);
	const hasAction = [...ACTION_SIGNAL_WORDS].some((token) => chunkTerms.has(token));
	return hasAction ? 3 : 0;
}

function selectChunksForDescription(
	index: AxiomSparseTreeGrepIndex,
	options: SparseTreeGrepDescribeOptions,
	limit: number,
): AxiomSparseTreeGrepChunk[] {
	const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
	if (options.chunkIds?.length) {
		return options.chunkIds
			.map((id) => byId.get(id))
			.filter((chunk): chunk is AxiomSparseTreeGrepChunk => !!chunk)
			.slice(0, limit);
	}
	if (options.nodeId) {
		const node = index.nodes.find((candidate) => candidate.id === options.nodeId);
		if (node) {
			return node.chunkIds
				.map((id) => byId.get(id))
				.filter((chunk): chunk is AxiomSparseTreeGrepChunk => !!chunk)
				.slice(0, limit);
		}
	}
	if (options.query?.trim()) {
		const queryTokens = expandQueryTokens(tokenize(options.query));
		return scoreChunks(index, queryTokens)
			.slice(0, limit)
			.map((hit) => hit.chunk);
	}
	return index.chunks.slice(0, limit);
}

function readChunkWindow(index: AxiomSparseTreeGrepIndex, chunk: AxiomSparseTreeGrepChunk, around: number): string {
	const startIndex = Math.max(0, chunk.chunkIndex - 1 - around);
	const endIndex = Math.min(index.chunks.length - 1, chunk.chunkIndex - 1 + around);
	const start = index.chunks[startIndex]?.byteStart ?? chunk.byteStart;
	const end = index.chunks[endIndex]?.byteEnd ?? chunk.byteEnd;
	return readByteRange(index.textPath ?? index.sourcePath, start, end);
}

function buildChunkDescription(
	index: AxiomSparseTreeGrepIndex,
	chunk: AxiomSparseTreeGrepChunk,
	text: string,
	query: string | undefined,
	around: number,
): AxiomSparseTreeGrepChunkDescription {
	const entities = chunk.entities?.length ? chunk.entities : extractEntities(text);
	const tokens = tokenize(text);
	const actions = [...new Set(tokens.filter((token) => ACTION_SIGNAL_WORDS.has(token)))].slice(0, 12);
	const settings = extractSettingHints(text);
	const evidence = pickEvidenceSentences(text, query, entities, actions);
	const titleParts = [entities.slice(0, 2).join(" + "), actions.slice(0, 2).join(" / ")].filter(Boolean);
	const title = titleParts.length > 0 ? titleParts.join(" - ") : `${index.documentName} chunk ${chunk.chunkIndex}`;
	return {
		generatedAt: new Date().toISOString(),
		queryFocus: query?.trim() || undefined,
		title,
		description: describeInOneParagraph(text, entities, actions, settings),
		entities,
		actions,
		settings,
		evidence,
		neighborChunkIds: neighborChunkIds(index, chunk, around),
	};
}

function describeInOneParagraph(text: string, entities: string[], actions: string[], settings: string[]): string {
	const compact = text.replace(/\s+/g, " ").trim();
	const base = summarizeChunk(compact);
	const parts = [base];
	if (entities.length) parts.push(`Entities: ${entities.slice(0, 8).join(", ")}.`);
	if (actions.length) parts.push(`Action signals: ${actions.slice(0, 8).join(", ")}.`);
	if (settings.length) parts.push(`Setting hints: ${settings.slice(0, 5).join(", ")}.`);
	return parts.join(" ");
}

function pickEvidenceSentences(
	text: string,
	query: string | undefined,
	entities: string[],
	actions: string[],
): string[] {
	const sentences = splitSentences(text);
	const queryTokens = new Set(expandQueryTokens(tokenize(query ?? "")));
	const entityTokens = new Set(entities.flatMap((entity) => tokenize(entity)));
	const actionTokens = new Set(actions);
	return sentences
		.map((sentence, index) => {
			const tokens = new Set(tokenize(sentence));
			let score = 0;
			for (const token of queryTokens) if (tokens.has(token)) score += 4;
			for (const token of entityTokens) if (tokens.has(token)) score += 2;
			for (const token of actionTokens) if (tokens.has(token)) score += 3;
			return { sentence: sentence.trim(), score, index };
		})
		.filter((item) => item.sentence.length > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 4)
		.map((item) => (item.sentence.length <= 320 ? item.sentence : `${item.sentence.slice(0, 317)}...`));
}

function splitSentences(text: string): string[] {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return [];
	return compact.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()) ?? [compact];
}

function extractSettingHints(text: string): string[] {
	const hints = new Set<string>();
	const compact = text.replace(/\s+/g, " ");
	const re =
		/\b(?:in|inside|at|near|outside|under|over|through)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z0-9' -]{2,40})/gi;
	let match: RegExpExecArray | null = re.exec(compact);
	while (match) {
		const hint = match[1]?.trim().replace(/[,.!?;:].*$/, "");
		if (hint && tokenize(hint).length <= 5) hints.add(hint);
		if (hints.size >= 8) break;
		match = re.exec(compact);
	}
	return [...hints];
}

function neighborChunkIds(index: AxiomSparseTreeGrepIndex, chunk: AxiomSparseTreeGrepChunk, around: number): string[] {
	if (around <= 0) return [];
	const startIndex = Math.max(0, chunk.chunkIndex - 1 - around);
	const endIndex = Math.min(index.chunks.length - 1, chunk.chunkIndex - 1 + around);
	return index.chunks
		.slice(startIndex, endIndex + 1)
		.map((candidate) => candidate.id)
		.filter((id) => id !== chunk.id);
}

function pageForOffset(text: string, charStart: number): number {
	const before = text.slice(0, charStart);
	const formFeedCount = countMatches(before, /\f/g);
	if (formFeedCount > 0) return formFeedCount + 1;
	return Math.floor(Buffer.byteLength(before, "utf-8") / 3200) + 1;
}

function countMatches(text: string, re: RegExp): number {
	return text.match(re)?.length ?? 0;
}

function renderReport(indexes: AxiomSparseTreeGrepIndex[]): string {
	const out = ["# SparseTreeGrep Index Report", ""];
	out.push(`Documents: ${indexes.length}`);
	out.push("");
	for (const index of indexes) {
		out.push(`- ${index.documentName} (${index.documentId})`);
		out.push(`  - chunks: ${index.chunkCount}, pages: ${index.pageCount}, nodes: ${index.nodes.length}`);
		out.push(`  - source: ${index.sourcePath}`);
	}
	return `${out.join("\n")}\n`;
}

function hash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}
