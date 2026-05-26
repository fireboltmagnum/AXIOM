import { pickCheckerForLanguage, runChecker } from "./code-checkers/index.ts";
import type { FencedCodeBlock } from "./code-checkers/types.ts";

/**
 * Result reported to the runtime when a code chunk finishes streaming and is
 * checked. `chunk` carries the original block so the runtime can build a
 * precise feedback message that points the model at exactly the broken code.
 */
export interface StreamingChunkCheckResult {
	chunk: FencedCodeBlock;
	resolvedLanguage: string;
	ok: boolean;
	line?: number;
	column?: number;
	message?: string;
	fixHint?: string;
	latencyMs: number;
}

export interface StreamingValidatorOptions {
	/** Hard per-chunk timeout. The user's stated budget is 1000ms total. */
	timeoutMs: number;
	/** Called every time a closed code block is checked, ok or not. */
	onChunkChecked: (result: StreamingChunkCheckResult) => void;
}

/**
 * Watches assistant text as it streams in and validates each fenced code
 * block the moment it closes. Replaces "validate the whole message at the
 * end" with "validate each chunk live so failures are caught in <1s."
 *
 * Design constraints:
 *   1. `observe()` is called once per `text_delta` with the FULL accumulated
 *      assistant text so far. We extract every closed fence from scratch
 *      each call but skip blocks we've already validated (via startOffset key).
 *      This avoids state corruption across reorderings.
 *   2. Checker invocations are async and may overlap. To keep ordering sane
 *      we serialize them in a FIFO queue, but multiple deltas can arrive
 *      while one is in flight — they queue up.
 *   3. The validator NEVER blocks observe(); checks run in the background.
 *      The runtime decides what to do with results (typically: abort + retry
 *      on the first failure, suppress further checks).
 *
 * Reset between assistant messages via `reset()` or by constructing a new
 * instance.
 */
export class StreamingIPValidator {
	private readonly options: StreamingValidatorOptions;
	private readonly seenStartOffsets = new Set<number>();
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(options: StreamingValidatorOptions) {
		this.options = options;
	}

	/** Stop emitting further results. Pending checks finish but their results are dropped. */
	stop(): void {
		this.stopped = true;
	}

	reset(): void {
		this.seenStartOffsets.clear();
		this.queue = Promise.resolve();
		this.stopped = false;
	}

	/**
	 * Feed in the latest cumulative assistant text. Synchronous; check work
	 * happens in the background. Returns the number of NEW blocks just queued
	 * (useful for telemetry, optional).
	 */
	observe(fullText: string): number {
		if (this.stopped) return 0;
		const blocks = extractClosedFencedBlocks(fullText);
		let queued = 0;
		for (const block of blocks) {
			if (this.seenStartOffsets.has(block.startOffset)) continue;
			this.seenStartOffsets.add(block.startOffset);
			this.enqueueCheck(block);
			queued++;
		}
		return queued;
	}

	private enqueueCheck(block: FencedCodeBlock): void {
		this.queue = this.queue
			.then(async () => {
				if (this.stopped) return;
				const { checker, resolvedLang } = pickCheckerForLanguage(block.language);
				const startedAt = Date.now();
				const result = await runChecker(checker, block.code, this.options.timeoutMs);
				if (this.stopped) return;
				this.options.onChunkChecked({
					chunk: block,
					resolvedLanguage: resolvedLang,
					ok: result.ok,
					line: result.line,
					column: result.column,
					message: result.message,
					fixHint: result.fixHint,
					latencyMs: Date.now() - startedAt,
				});
			})
			.catch(() => {
				// runChecker swallows its own errors; this catch exists only so a
				// rogue rejection doesn't kill the FIFO chain.
			});
	}

	/** Awaitable handle for tests / shutdown. Resolves when the queue is drained. */
	async drain(): Promise<void> {
		await this.queue;
	}
}

/**
 * Walk the accumulated text and extract every fenced code block that has
 * already closed. A block is considered closed only when we have seen its
 * terminating ``` line — partial / mid-stream blocks are ignored.
 *
 * Recognized open fence patterns:
 *   ```lang\n   (preferred)
 *   ```         (no language, falls back to balanced-delimiter check)
 *   ~~~lang\n   (CommonMark alternative)
 *
 * The matcher is intentionally simple: it does not handle nested fences,
 * indented code fences, or fences inside other fences. The model writes
 * standard markdown ~99% of the time and we accept the occasional miss in
 * exchange for predictable extraction.
 */
export function extractClosedFencedBlocks(text: string): FencedCodeBlock[] {
	const blocks: FencedCodeBlock[] = [];
	// Match an opening fence and capture: marker (```/~~~), language, body, closing marker.
	// Body is non-greedy and stops at the FIRST matching closing fence on its own line.
	const fenceRe = /(^|\n)(```|~~~)([^\n`~]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
	let match: RegExpExecArray | null = fenceRe.exec(text);
	while (match) {
		const [, leadingNewline, , languageTag, body] = match;
		const openOffset = match.index + leadingNewline.length;
		const fullMatchLen = match[0].length - leadingNewline.length;
		blocks.push({
			language: languageTag.trim().toLowerCase(),
			code: body,
			startOffset: openOffset,
			endOffset: openOffset + fullMatchLen,
		});
		match = fenceRe.exec(text);
	}
	return blocks;
}
