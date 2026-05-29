/**
 * Best-of-N candidate selection across repair-loop attempts.
 *
 * Premise: the repair loop already runs up to N attempts per task. Today it
 * keeps the LAST attempt's state whether or not it was the best one. If the
 * agent oscillates (attempt 1 fixes two bugs, attempt 2 introduces a third
 * while keeping the first fix, attempt 3 makes things worse), we lose
 * progress. This coordinator records every attempt as a {@link BestOfNCandidate}
 * and at task end (or on exhaustion) picks the one that converged best.
 *
 * Selection criterion (in order):
 *   1. Passed verifier  (binary)
 *   2. Fewer parsed issues
 *   3. Smaller changed-file count (proxy for surgical fix)
 *   4. Higher recalled-skill confidence
 *   5. Earlier rollout index (stable tiebreak, prefer original attempt)
 *
 * Today the candidates come from sequential repair attempts on a single
 * AgentSession. The same shape generalizes to parallel rollouts (each worktree
 * fork records candidates with its own rollout id) — the selector code does
 * not care where candidates came from.
 */

export interface BestOfNCandidate {
	/** Stable id (typically `${traceId}#${rolloutIndex}#${attemptIndex}`). */
	id: string;
	/** Which parallel rollout this came from. Zero for sequential / single-rollout mode. */
	rolloutIndex: number;
	/** Which repair-attempt within the rollout. Starts at 1. */
	attemptIndex: number;
	/** True iff the verifier exited 0 for this candidate. */
	passed: boolean;
	/** Number of parsed verifier failures (0 when passed). */
	issueCount: number;
	/** Number of files this attempt mutated. Smaller is better when passed is equal. */
	changedFileCount: number;
	/** Stable signature from RepairLoop — used to detect identical-failure twins. */
	signature: string;
	/** Verifier command (informational, surfaced in the winner event). */
	verifierCommand: string;
	/** Mean confidence of skills recalled for this attempt, in [0, 1]. Undefined when no skills recalled. */
	skillConfidence?: number;
	/** Wall-clock duration of the verifier run, in milliseconds. */
	durationMs: number;
	/** Timestamp the candidate was recorded. */
	recordedAt: string;
	/** First parsed failure (short string), for surfacing in selection summaries. */
	firstFailure?: string;
}

export interface BestOfNSelection {
	winner: BestOfNCandidate;
	/** Total candidates considered. */
	totalCandidates: number;
	/** True iff the winner is NOT the last-recorded candidate. Indicates oscillation. */
	regressionDetected: boolean;
	/** Human-readable rationale ("passed verifier", "fewer issues than last attempt", etc.). */
	reason: string;
}

export class BestOfNCoordinator {
	private candidates: BestOfNCandidate[] = [];

	reset(): void {
		this.candidates = [];
	}

	recordCandidate(candidate: BestOfNCandidate): void {
		this.candidates.push(candidate);
	}

	get candidateCount(): number {
		return this.candidates.length;
	}

	snapshot(): readonly BestOfNCandidate[] {
		return this.candidates;
	}

	/**
	 * Pick the best candidate per the documented criterion. Returns undefined
	 * when there are zero candidates. Always returns a winner when at least
	 * one candidate is recorded — even a single failed candidate "wins" by
	 * default (it just means there was nothing else to compare against).
	 */
	selectWinner(): BestOfNSelection | undefined {
		if (this.candidates.length === 0) return undefined;
		const sorted = [...this.candidates].sort(compareCandidates);
		const winner = sorted[0];
		const last = this.candidates[this.candidates.length - 1];
		const regressionDetected = winner.id !== last.id;
		return {
			winner,
			totalCandidates: this.candidates.length,
			regressionDetected,
			reason: explainSelection(winner, last, regressionDetected),
		};
	}
}

/**
 * Lower is better. Returns negative when a should sort before b.
 *
 * Exported so parallel-rollout selection (RolloutCoordinator) ranks candidates
 * with the EXACT same criterion as sequential repair-attempt selection — there
 * must be one source of truth for "which candidate is best".
 */
export function compareCandidates(a: BestOfNCandidate, b: BestOfNCandidate): number {
	// 1. Passed > failed.
	if (a.passed !== b.passed) return a.passed ? -1 : 1;
	// 2. Fewer parsed issues.
	if (a.issueCount !== b.issueCount) return a.issueCount - b.issueCount;
	// 3. Smaller changed-file count (more surgical).
	if (a.changedFileCount !== b.changedFileCount) return a.changedFileCount - b.changedFileCount;
	// 4. Higher skill confidence (undefined treated as 0).
	const skillA = a.skillConfidence ?? 0;
	const skillB = b.skillConfidence ?? 0;
	if (skillA !== skillB) return skillB - skillA;
	// 5. Earlier rollout / attempt (stable preference for original attempt).
	if (a.rolloutIndex !== b.rolloutIndex) return a.rolloutIndex - b.rolloutIndex;
	return a.attemptIndex - b.attemptIndex;
}

/**
 * Pure selection over an unordered candidate set (e.g. parallel rollouts where
 * there is no meaningful "last" attempt). Returns the strongest candidate by
 * {@link compareCandidates}, or undefined when the set is empty. Order-independent:
 * the comparator is a total order, so recording/arrival order never changes the
 * winner.
 */
export function selectBestCandidate(candidates: readonly BestOfNCandidate[]): BestOfNCandidate | undefined {
	if (candidates.length === 0) return undefined;
	return [...candidates].sort(compareCandidates)[0];
}

function explainSelection(winner: BestOfNCandidate, last: BestOfNCandidate, regressionDetected: boolean): string {
	if (!regressionDetected) {
		return winner.passed
			? "last attempt passed verifier"
			: `last attempt was best (${winner.issueCount} issue${winner.issueCount === 1 ? "" : "s"})`;
	}
	if (winner.passed && !last.passed) {
		return `earlier attempt #${winner.attemptIndex} passed; last attempt regressed`;
	}
	if (winner.issueCount < last.issueCount) {
		return `attempt #${winner.attemptIndex} had ${winner.issueCount} issue(s); last attempt had ${last.issueCount}`;
	}
	if (winner.changedFileCount < last.changedFileCount) {
		return `attempt #${winner.attemptIndex} was more surgical (${winner.changedFileCount} files vs ${last.changedFileCount})`;
	}
	return `attempt #${winner.attemptIndex} ranked higher than the last attempt`;
}
