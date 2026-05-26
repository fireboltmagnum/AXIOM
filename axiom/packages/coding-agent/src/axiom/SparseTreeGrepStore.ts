import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type {
	AxiomSparseTreeGrepChunk,
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

export class SparseTreeGrepStore {
	private readonly baseDir: string;
	private readonly docsDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "sparse-tree-grep");
		this.docsDir = join(this.baseDir, "docs");
	}

	indexDocument(options: SparseTreeGrepIndexOptions): AxiomSparseTreeGrepIndex {
		const sourcePath = resolve(options.path);
		if (!existsSync(sourcePath)) throw new Error(`Document not found: ${sourcePath}`);
		const maxBytes = Math.max(10_000, options.maxBytes ?? 8_000_000);
		const loaded = loadText(sourcePath, maxBytes);
		const maxChunks = Math.max(1, Math.min(10_000, options.maxChunks ?? 2_000));
		const rawChunks = splitIntoChunks(loaded.text).slice(0, maxChunks);
		const documentId = `doc_${hash(`${sourcePath}:${loaded.totalBytes}:${loaded.text.slice(0, 400)}`, 18)}`;
		const chunks: AxiomSparseTreeGrepChunk[] = rawChunks.map((chunk, index) => ({
			id: `chk_${index + 1}`,
			chunkIndex: index + 1,
			byteStart: chunk.byteStart,
			byteEnd: chunk.byteEnd,
			lineStart: chunk.lineStart,
			lineEnd: chunk.lineEnd,
			page: chunk.page,
			summary: summarizeChunk(chunk.text),
			keywords: topTerms(tokenize(chunk.text), 12),
		}));
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
		};
		this.save(index);
		if (index.textPath) {
			writeFileSync(index.textPath, loaded.text, "utf-8");
		}
		return index;
	}

	search(query: string, options?: { documentId?: string; limit?: number }): AxiomSparseTreeGrepHit[] {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return [];
		const limit = Math.max(1, Math.min(50, options?.limit ?? 8));
		const indexes = options?.documentId ? [this.load(options.documentId)].filter(Boolean) : this.listIndexes();
		const hits: AxiomSparseTreeGrepHit[] = [];
		for (const index of indexes) {
			if (!index) continue;
			const nodeScores = scoreNodes(index, queryTokens);
			const chunkScores = scoreChunks(index, queryTokens);
			for (const chunkScore of chunkScores.slice(0, Math.max(limit * 3, 12))) {
				const nodeScore = nodeScores.find((node) => node.node.chunkIds.includes(chunkScore.chunk.id));
				hits.push(
					toHit(index, chunkScore.chunk, chunkScore.score + (nodeScore?.score ?? 0) * 0.2, {
						node: nodeScore?.node,
						matchedKeywords: [...new Set([...chunkScore.matchedKeywords, ...(nodeScore?.matchedKeywords ?? [])])],
					}),
				);
			}
		}
		hits.sort((a, b) => b.score - a.score || a.byteStart - b.byteStart);
		return hits.slice(0, limit);
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
		const indexes: AxiomSparseTreeGrepIndex[] = [];
		for (const file of readdirSync(this.docsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(readFileSync(join(this.docsDir, file), "utf-8")) as AxiomSparseTreeGrepIndex;
				if (parsed.version === 1) indexes.push(parsed);
			} catch {
				// skip malformed index
			}
		}
		indexes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return indexes;
	}

	load(documentId: string): AxiomSparseTreeGrepIndex | undefined {
		const path = join(this.docsDir, `${documentId}.json`);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as AxiomSparseTreeGrepIndex;
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
		// File-backed store has no long-lived cache yet.
	}

	private save(index: AxiomSparseTreeGrepIndex): void {
		if (!existsSync(this.docsDir)) mkdirSync(this.docsDir, { recursive: true });
		writeFileSync(join(this.docsDir, `${index.documentId}.json`), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
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
		for (const term of chunk.keywords.slice(0, 10)) {
			let set = termToChunks.get(term);
			if (!set) {
				set = new Set();
				termToChunks.set(term, set);
			}
			set.add(chunk.id);
		}
	}
	const rootTerms = [...termToChunks.entries()]
		.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
		.slice(0, 80);
	const nodes: AxiomSparseTreeGrepNode[] = [];
	for (const [term, ids] of rootTerms) {
		const chunkIds = [...ids].sort(
			(a, b) => (chunkById.get(a)?.chunkIndex ?? 0) - (chunkById.get(b)?.chunkIndex ?? 0),
		);
		const nodeId = `node_${hash(term, 12)}`;
		const children = coTermsFor(term, chunkIds, chunkById).slice(0, 8);
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
	return index.chunks
		.map((chunk) => {
			const terms = new Set([...chunk.keywords, ...tokenize(chunk.summary)]);
			const matched = queryTokens.filter((token) => terms.has(token));
			const phraseBonus =
				queryTokens.length > 1 && chunk.summary.toLowerCase().includes(queryTokens.join(" ")) ? 4 : 0;
			return {
				chunk,
				score: matched.length * 6 + phraseBonus + Math.min(chunk.keywords.length, 8) / 10,
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

function topTerms(tokens: string[], limit: number): string[] {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([term]) => term);
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
