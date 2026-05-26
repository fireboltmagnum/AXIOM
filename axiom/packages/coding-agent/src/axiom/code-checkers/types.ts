/**
 * Result of running a single language-specific syntax check over a fenced
 * code block. Checkers MUST return within their declared timeout; on timeout
 * the runner converts the result to `{ ok: true }` (assume innocent) so a
 * slow checker can never block the agent.
 */
export interface CodeCheckResult {
	ok: boolean;
	line?: number;
	column?: number;
	message?: string;
	/** Brief one-line repair hint surfaced in the agent feedback. */
	fixHint?: string;
}

/** A single fenced code block extracted from the streaming text. */
export interface FencedCodeBlock {
	/** Lowercased language tag from ```lang. Empty string if unset. */
	language: string;
	/** Raw code between the fences (no surrounding ``` lines). */
	code: string;
	/** Character offset of the opening fence inside the full assistant text. */
	startOffset: number;
	/** Character offset right after the closing fence (exclusive). */
	endOffset: number;
}

/**
 * Synchronous or async checker. Async checkers spawn a subprocess; sync
 * checkers do an in-process parse. The runner wraps both in a timeout.
 */
export type CodeChecker = (code: string, timeoutMs: number) => Promise<CodeCheckResult>;
