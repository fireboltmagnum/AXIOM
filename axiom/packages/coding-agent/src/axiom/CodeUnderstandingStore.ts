import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AxiomCodeUnderstanding, AxiomFileUnderstanding, AxiomUnderstandingRecallHit } from "./RuntimeTypes.ts";

/**
 * Disk-backed store for structured code understandings captured by the
 * `understand_code` tool.
 *
 * Layout:
 *   ~/.axiom/agent/understandings/
 *     index.jsonl
 *     <id>.md
 *
 * The index is intentionally small JSONL so the Context Agent can recall by
 * keyword/path/symbol without re-reading the markdown body on every task.
 */
export class CodeUnderstandingStore {
	private readonly baseDir: string;
	private readonly indexPath: string;
	private cachedIndex: AxiomCodeUnderstanding[] | null = null;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "understandings");
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

	private loadIndex(): AxiomCodeUnderstanding[] {
		if (this.cachedIndex) return this.cachedIndex;
		if (!existsSync(this.indexPath)) {
			this.cachedIndex = [];
			return this.cachedIndex;
		}
		try {
			const raw = readFileSync(this.indexPath, "utf-8");
			const entries: AxiomCodeUnderstanding[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					entries.push(JSON.parse(trimmed) as AxiomCodeUnderstanding);
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

	save(understanding: AxiomCodeUnderstanding): boolean {
		if (!this.ensureDir()) return false;
		try {
			writeFileSync(join(this.baseDir, `${understanding.id}.md`), renderMarkdown(understanding), "utf-8");
			const line = `${JSON.stringify(understanding)}\n`;
			if (existsSync(this.indexPath)) {
				const current = readFileSync(this.indexPath, "utf-8");
				writeFileSync(this.indexPath, current + line, "utf-8");
			} else {
				writeFileSync(this.indexPath, line, "utf-8");
			}
			if (this.cachedIndex) this.cachedIndex.push(understanding);
			return true;
		} catch {
			return false;
		}
	}

	recall(options: { keywords: string[]; limit: number }): AxiomUnderstandingRecallHit[] {
		const { keywords, limit } = options;
		if (limit <= 0) return [];
		const query = new Set(keywords.flatMap(tokenize).filter(Boolean));
		if (query.size === 0) return [];

		const now = Date.now();
		const hits: AxiomUnderstandingRecallHit[] = [];
		for (const understanding of this.loadIndex()) {
			const matched = understanding.keywords.map((k) => k.toLowerCase()).filter((k) => query.has(k));
			if (matched.length === 0) continue;

			let score = matched.length * 2;
			score += Math.min(understanding.fileCount, 20) / 20;
			const ageDays = (now - Date.parse(understanding.timestamp)) / (1000 * 60 * 60 * 24);
			if (Number.isFinite(ageDays)) {
				if (ageDays < 7) score += 0.75;
				else if (ageDays < 30) score += 0.35;
			}
			hits.push({ understanding, score, matchedKeywords: [...new Set(matched)] });
		}

		hits.sort((a, b) => b.score - a.score || b.understanding.timestamp.localeCompare(a.understanding.timestamp));
		return hits.slice(0, limit);
	}

	all(): AxiomCodeUnderstanding[] {
		return [...this.loadIndex()];
	}

	clearCache(): void {
		this.cachedIndex = null;
	}
}

export function buildUnderstandingKeywords(rootPath: string, files: AxiomFileUnderstanding[]): string[] {
	const words = new Set<string>();
	for (const token of tokenize(rootPath)) words.add(token);
	for (const token of tokenize(basename(rootPath))) words.add(token);
	for (const file of files) {
		for (const token of tokenize(file.path)) words.add(token);
		for (const token of tokenize(basename(file.path))) words.add(token);
		for (const symbol of file.symbols) {
			for (const token of tokenize(symbol.name)) words.add(token);
			words.add(symbol.kind);
		}
		for (const mod of file.imports) {
			for (const token of tokenize(mod)) words.add(token);
		}
		for (const name of file.exports) {
			for (const token of tokenize(name)) words.add(token);
		}
		if (file.language !== "unknown") words.add(file.language);
	}
	return [...words].filter((word) => word.length > 1).slice(0, 400);
}

function tokenize(text: string): string[] {
	const spacedCamel = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	return spacedCamel
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((s) => s.trim())
		.filter((s) => s.length > 1);
}

function renderMarkdown(u: AxiomCodeUnderstanding): string {
	const out: string[] = ["---"];
	out.push(`id: ${u.id}`);
	out.push(`timestamp: ${u.timestamp}`);
	out.push(`root_path: ${u.rootPath}`);
	out.push(`file_count: ${u.fileCount}`);
	out.push(`keywords: ${u.keywords.join(", ")}`);
	out.push("---");
	out.push("");
	out.push(`# Code understanding: ${u.rootPath}`);
	out.push("");
	out.push(`Captured ${u.fileCount} file(s).`);
	out.push("");
	for (const file of u.files) {
		out.push(`## ${file.path}`);
		out.push("");
		out.push(`- Language: ${file.language}`);
		out.push(`- Lines: ${file.lineCount}`);
		if (file.imports.length > 0) out.push(`- Imports: ${file.imports.slice(0, 20).join(", ")}`);
		if (file.exports.length > 0) out.push(`- Exports: ${file.exports.slice(0, 20).join(", ")}`);
		if (file.symbols.length > 0) {
			out.push("");
			out.push("| Kind | Name | Line | Exported | Signature |");
			out.push("| --- | --- | ---: | --- | --- |");
			for (const symbol of file.symbols.slice(0, 80)) {
				out.push(
					`| ${symbol.kind} | ${escapeCell(symbol.name)} | ${symbol.line} | ${symbol.exported ? "yes" : "no"} | ${escapeCell(symbol.signature ?? "")} |`,
				);
			}
		}
		out.push("");
	}
	return out.join("\n");
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
