/**
 * Execution-level test-time scaling: repeated INDEPENDENT sampling + verifier
 * selection.
 *
 * This is the lever that lifts a small model toward large-model agentic scores.
 * The literature (repeated-sampling / "Large Language Monkeys") is consistent:
 * for code tasks, pass@k climbs steeply with the number of independent attempts
 * — the model's *coverage* of correct solutions is far higher than its
 * single-shot accuracy. The bottleneck is not generation but SELECTION: you
 * need a verifier to pick the one good sample out of N. AXIOM already owns a
 * verifier ladder (tests → IP validation → subgoal checks) and a candidate
 * comparator (BestOfNCoordinator.compareCandidates). The only missing piece is
 * the orchestration that fans out N independent attempts, verifies each, and
 * selects — which is exactly this module.
 *
 * Design constraints that make it safe to land now:
 *   - PURE CORE. The coordinator knows nothing about sessions, worktrees, or
 *     LLMs. The caller injects `sample(index, signal)` (produce one attempt,
 *     e.g. by running a forked AgentSession in its own worktree) and
 *     `verify(sample, index, signal)` (run the verifier ladder). This keeps the
 *     coordination logic fully unit-testable with synchronous fakes and defers
 *     the heavy/integration-risky worktree-forking to the call site.
 *   - DETERMINISTIC SELECTION. Winner is chosen by the shared comparator, a
 *     total order, so arrival/completion order never changes the result.
 *   - BOUNDED CONCURRENCY. Runs at most `concurrency` samples in flight; weak
 *     local models are resource-bound, so unbounded fan-out would thrash.
 *   - EARLY STOP. Once a candidate passes the verifier, remaining not-yet-started
 *     samples are skipped and in-flight ones are signalled to abort — there is
 *     no value in more samples once one verifiably works. Disable via
 *     `earlyStopOnPass: false` (e.g. to gather full coverage statistics).
 *   - FAULT ISOLATION. A `sample`/`verify` that throws does not abort the run;
 *     that rollout is recorded as a failed candidate so the others can still win.
 */

import { type BestOfNCandidate, type BestOfNSelection, selectBestCandidate } from "./BestOfNCoordinator.ts";

/** What a verifier run reports back for one rollout. Mirrors the scored fields of {@link BestOfNCandidate}. */
export interface RolloutVerification {
	/** True iff the verifier ladder accepted this rollout. */
	passed: boolean;
	/** Parsed verifier-failure count (0 when passed). */
	issueCount: number;
	/** Files this rollout mutated. Smaller is better when `passed` ties. */
	changedFileCount: number;
	/** Stable failure signature (used for telemetry / twin detection). */
	signature: string;
	/** Verifier command, surfaced in the winner summary. */
	verifierCommand: string;
	/** Verifier wall-clock duration in ms. */
	durationMs: number;
	/** Mean confidence of skills recalled for this rollout, in [0, 1]. */
	skillConfidence?: number;
	/** First parsed failure (short), for summaries. */
	firstFailure?: string;
}

export interface RolloutCoordinatorOptions {
	/** Number of independent rollouts to attempt. Clamped to >= 1. */
	n: number;
	/** Max rollouts in flight at once. Clamped to [1, n]. Defaults to n (full fan-out). */
	concurrency?: number;
	/** Stop launching/awaiting once a candidate passes the verifier. Defaults to true. */
	earlyStopOnPass?: boolean;
	/** Stable id prefix for candidate ids (typically the traceId). */
	idPrefix?: string;
}

/** Produce one independent attempt. `signal` fires when early-stop makes further work pointless. */
export type SampleFn<TSample> = (index: number, signal: AbortSignal) => Promise<TSample>;
/** Verify one attempt. `signal` fires when early-stop makes further work pointless. */
export type VerifyFn<TSample> = (sample: TSample, index: number, signal: AbortSignal) => Promise<RolloutVerification>;

export interface RolloutOutcome<TSample> {
	index: number;
	candidate: BestOfNCandidate;
	/** The raw sample, when sampling succeeded. Undefined if `sample()` threw. */
	sample?: TSample;
	/** Set when `sample()` or `verify()` threw — the rollout was scored as a failure. */
	error?: Error;
	/** True if this rollout was skipped before it started (early-stop after a pass). */
	skipped: boolean;
}

export interface RolloutRunResult<TSample> {
	/** Every rollout that actually ran (excludes skipped), in index order. */
	outcomes: RolloutOutcome<TSample>[];
	/** Recorded candidates for the rollouts that ran, in index order. */
	candidates: BestOfNCandidate[];
	/** Best candidate + rationale, or undefined if nothing ran. */
	selection?: BestOfNSelection;
	/** The winning outcome (so the caller can recover its sample / worktree). */
	winner?: RolloutOutcome<TSample>;
	/** How many rollouts actually executed (n minus skipped). */
	samplesRun: number;
	/** True iff the run stopped early because a candidate passed. */
	earlyStopped: boolean;
}

export class RolloutCoordinator {
	private readonly n: number;
	private readonly concurrency: number;
	private readonly earlyStopOnPass: boolean;
	private readonly idPrefix: string;

	constructor(options: RolloutCoordinatorOptions) {
		this.n = Math.max(1, Math.floor(options.n));
		const requested = options.concurrency ?? this.n;
		this.concurrency = Math.max(1, Math.min(this.n, Math.floor(requested)));
		this.earlyStopOnPass = options.earlyStopOnPass ?? true;
		this.idPrefix = options.idPrefix ?? "no-trace";
	}

	/**
	 * Fan out up to `n` independent rollouts, verify each, and select the best.
	 * Resolves once every launched rollout settles (or early-stop fires). Never
	 * rejects: sample/verify failures become failed candidates.
	 */
	async run<TSample>(fns: {
		sample: SampleFn<TSample>;
		verify: VerifyFn<TSample>;
	}): Promise<RolloutRunResult<TSample>> {
		const controller = new AbortController();
		const outcomes: Array<RolloutOutcome<TSample>> = [];
		let earlyStopped = false;
		let nextIndex = 0;

		const launchNext = async (): Promise<void> => {
			// A single worker: keep pulling indices until exhausted or early-stop.
			while (true) {
				if (controller.signal.aborted) return;
				const index = nextIndex;
				if (index >= this.n) return;
				nextIndex++;

				const outcome = await this.runOne(index, controller.signal, fns);
				outcomes.push(outcome);

				if (this.earlyStopOnPass && outcome.candidate.passed && !outcome.skipped) {
					earlyStopped = true;
					controller.abort();
					return;
				}
			}
		};

		const workers = Array.from({ length: this.concurrency }, () => launchNext());
		await Promise.all(workers);

		outcomes.sort((a, b) => a.index - b.index);
		const ranThatRan = outcomes.filter((o) => !o.skipped);
		const candidates = ranThatRan.map((o) => o.candidate);
		const best = selectBestCandidate(candidates);
		const winner = best ? ranThatRan.find((o) => o.candidate.id === best.id) : undefined;
		const selection = best ? this.buildSelection(best, candidates) : undefined;

		return {
			outcomes: ranThatRan,
			candidates,
			selection,
			winner,
			samplesRun: ranThatRan.length,
			earlyStopped,
		};
	}

	private async runOne<TSample>(
		index: number,
		signal: AbortSignal,
		fns: { sample: SampleFn<TSample>; verify: VerifyFn<TSample> },
	): Promise<RolloutOutcome<TSample>> {
		try {
			const sample = await fns.sample(index, signal);
			const verification = await fns.verify(sample, index, signal);
			return { index, sample, candidate: this.toCandidate(index, verification), skipped: false };
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			// A thrown sample/verify is scored as a maximally-bad candidate so the
			// run keeps going and a healthy rollout can still win.
			return {
				index,
				error,
				skipped: false,
				candidate: this.toCandidate(index, {
					passed: false,
					issueCount: Number.MAX_SAFE_INTEGER,
					changedFileCount: Number.MAX_SAFE_INTEGER,
					signature: `rollout-error:${error.message}`,
					verifierCommand: "(rollout threw)",
					durationMs: 0,
					firstFailure: error.message,
				}),
			};
		}
	}

	private toCandidate(index: number, v: RolloutVerification): BestOfNCandidate {
		return {
			id: `${this.idPrefix}#${index}#1`,
			rolloutIndex: index,
			attemptIndex: 1,
			passed: v.passed,
			issueCount: v.issueCount,
			changedFileCount: v.changedFileCount,
			signature: v.signature,
			verifierCommand: v.verifierCommand,
			skillConfidence: v.skillConfidence,
			durationMs: v.durationMs,
			recordedAt: new Date().toISOString(),
			firstFailure: v.firstFailure,
		};
	}

	private buildSelection(winner: BestOfNCandidate, candidates: readonly BestOfNCandidate[]): BestOfNSelection {
		const passing = candidates.filter((c) => c.passed).length;
		let reason: string;
		if (winner.passed) {
			reason =
				passing > 1
					? `rollout #${winner.rolloutIndex} selected from ${passing} passing of ${candidates.length} rollouts`
					: `rollout #${winner.rolloutIndex} was the only passing of ${candidates.length} rollouts`;
		} else {
			reason = `no rollout passed; rollout #${winner.rolloutIndex} was closest (${winner.issueCount} issue${
				winner.issueCount === 1 ? "" : "s"
			})`;
		}
		return {
			winner,
			totalCandidates: candidates.length,
			// "regression" has no meaning for an unordered rollout set; report false.
			regressionDetected: false,
			reason,
		};
	}
}
