import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Gather phase: load the FULL content of the pieces a task depends on, together,
 * right before synthesis.
 *
 * The rest of AXIOM is deliberately token-frugal — SparseTreeGrep returns chunk
 * summaries, the Evidence Pack is a 500-token brief, ContextAgent returns concept
 * summaries. That frugality is correct for FINDING things, but it starves the
 * final synthesis: a model can only write a complete artifact from complete
 * material. By the time the agent answers, the relevant full content may never
 * have been loaded (search returned summaries) or may have been compacted away
 * (compaction replaces read file bodies with a filename list).
 *
 * This module compiles the identified pieces' full, current content into one
 * bounded block to inject immediately before the synthesis call. It is a PURE,
 * deterministic, injectable compiler (file reads go through `readFile`, so it is
 * fully unit-testable) and it is BUDGETED so it can never blow the context
 * window: a global byte cap, a per-file cap, and priority-ordered inclusion so
 * the most relevant pieces survive when the budget is tight.
 *
 * It does NOT change how things are found — SparseTreeGrep/Evidence Pack stay
 * exactly as they are. It only concentrates the expensive token spend on the one
 * call where completeness is paid for.
 */

export interface GatherTarget {
	/** File path (cwd-relative or absolute). */
	file: string;
	/** Higher = more important; survives budget pressure. Default 0. (e.g. a LocalizationEngine score.) */
	priority?: number;
}

export interface GatherOptions {
	cwd: string;
	/** Total byte budget across all files. Default 200_000 (~50k tokens). */
	maxBytes?: number;
	/** Per-file byte cap before head/tail truncation. Default 60_000. */
	maxBytesPerFile?: number;
	/** Injectable reader (absolute path → content | undefined). Defaults to fs. */
	readFile?: (absPath: string) => string | undefined;
	/** Injectable existence check. Defaults to fs. */
	fileExists?: (absPath: string) => boolean;
}

export interface GatheredFile {
	file: string;
	bytes: number;
	truncated: boolean;
	content: string;
}

export interface GatherPack {
	files: GatheredFile[];
	totalBytes: number;
	/** Files dropped because the global budget was exhausted. */
	omitted: string[];
	/** Files requested but missing/unreadable. */
	missing: string[];
}

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_BYTES_PER_FILE = 60_000;

export class GatherPhase {
	/**
	 * Compile the full content of `targets` into a budgeted pack. Deterministic:
	 * targets are ordered by priority desc then path asc, so the result never
	 * depends on call order.
	 */
	build(targets: readonly GatherTarget[], options: GatherOptions): GatherPack {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
		const readFile = options.readFile ?? defaultReadFile;
		const fileExists = options.fileExists ?? ((p: string) => existsSync(p));

		// Dedupe by file, keeping the highest priority seen.
		const byFile = new Map<string, number>();
		for (const target of targets) {
			if (!target.file) continue;
			const prev = byFile.get(target.file);
			byFile.set(target.file, Math.max(prev ?? Number.NEGATIVE_INFINITY, target.priority ?? 0));
		}

		const ordered = [...byFile.entries()]
			.map(([file, priority]) => ({ file, priority }))
			.sort((a, b) => b.priority - a.priority || a.file.localeCompare(b.file));

		const files: GatheredFile[] = [];
		const omitted: string[] = [];
		const missing: string[] = [];
		let totalBytes = 0;

		// Per-file cap can never exceed the global budget (so a lone file still fits).
		const perFileCap = Math.min(maxBytesPerFile, maxBytes);
		for (const { file } of ordered) {
			const abs = isAbsolute(file) ? file : join(options.cwd, file);
			if (!fileExists(abs)) {
				missing.push(file);
				continue;
			}
			const raw = readFile(abs);
			if (raw === undefined) {
				missing.push(file);
				continue;
			}

			// Clamp to the per-file cap first, then decide if the clamped block fits
			// the remaining global budget. We do NOT shrink further just to squeeze a
			// sliver into a near-full budget — a 20-byte fragment helps no one; omit
			// instead so the model knows to read it explicitly if needed.
			const { content, truncated, bytes } = clampContent(raw, perFileCap);
			if (bytes > maxBytes - totalBytes) {
				omitted.push(file);
				continue;
			}
			files.push({ file, bytes, truncated, content });
			totalBytes += bytes;
		}

		return { files, totalBytes, omitted, missing };
	}
}

/**
 * Render a {@link GatherPack} as the context block to inject before synthesis.
 * The header explicitly instructs the model to write from the complete content.
 */
export function renderGatherPack(pack: GatherPack): string {
	if (pack.files.length === 0) return "";
	const out: string[] = [];
	out.push("=== GATHER PHASE: full content of the pieces this task depends on ===");
	out.push(
		"Write the final artifact from the COMPLETE content below — not from summaries, snippets, or memory. " +
			"Use every relevant detail present here.",
	);
	out.push("");
	for (const file of pack.files) {
		const note = file.truncated ? ` (TRUNCATED to ${file.bytes} bytes)` : ` (${file.bytes} bytes)`;
		out.push(`--- ${file.file}${note} ---`);
		out.push(file.content);
		out.push("");
	}
	if (pack.omitted.length > 0) {
		out.push(
			`[gather budget reached; omitted ${pack.omitted.length} lower-priority file(s): ${pack.omitted.join(", ")}]`,
		);
		out.push("If you need an omitted file, read it explicitly before finalizing.");
	}
	return out.join("\n").trimEnd();
}

// Reserve room for the truncation marker so the rendered `bytes` never exceeds
// the caller's budget.
const MARKER_RESERVE = 64;

/** Keep head + tail around a truncation marker so both the signature and the end survive. */
function clampContent(raw: string, budget: number): { content: string; truncated: boolean; bytes: number } {
	if (budget <= 0) return { content: "", truncated: true, bytes: 0 };
	const rawBytes = Buffer.byteLength(raw, "utf-8");
	if (rawBytes <= budget) {
		return { content: raw, truncated: false, bytes: rawBytes };
	}
	const contentBudget = budget - MARKER_RESERVE;
	if (contentBudget <= 0) {
		// Budget too small to split head/tail with a marker — emit a head slice
		// that still fits within `budget`.
		const head = sliceBytes(raw, budget, "head");
		return { content: head, truncated: true, bytes: Buffer.byteLength(head, "utf-8") };
	}
	// Keep ~70% head, ~30% tail; both ends matter for code (imports/signatures + exports/returns).
	const headBudget = Math.floor(contentBudget * 0.7);
	const tailBudget = contentBudget - headBudget;
	const head = sliceBytes(raw, headBudget, "head");
	const tail = sliceBytes(raw, tailBudget, "tail");
	const omittedBytes = rawBytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8");
	const content = `${head}\n... [${omittedBytes} bytes omitted by gather budget] ...\n${tail}`;
	return { content, truncated: true, bytes: Buffer.byteLength(content, "utf-8") };
}

function sliceBytes(text: string, byteBudget: number, end: "head" | "tail"): string {
	if (byteBudget <= 0) return "";
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= byteBudget) return text;
	const slice = end === "head" ? buf.subarray(0, byteBudget) : buf.subarray(buf.length - byteBudget);
	// Decode tolerantly; trim a possibly-broken partial line at the cut boundary.
	const decoded = slice.toString("utf-8");
	return end === "head"
		? decoded.slice(0, decoded.lastIndexOf("\n") + 1 || undefined)
		: decoded.slice(decoded.indexOf("\n") + 1);
}

function defaultReadFile(absPath: string): string | undefined {
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return undefined;
	}
}
