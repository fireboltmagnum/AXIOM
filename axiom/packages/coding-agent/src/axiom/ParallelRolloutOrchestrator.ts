import { type BestOfNSelection } from "./BestOfNCoordinator.ts";
import { RolloutCoordinator, type RolloutVerification } from "./RolloutCoordinator.ts";
import { RolloutWorkspaceManager, type RolloutWorkspace } from "./RolloutWorkspaceManager.ts";

/**
 * Live parallel-rollout orchestration: the glue that turns the deterministic
 * {@link RolloutCoordinator} (selection) and {@link RolloutWorkspaceManager}
 * (isolation) into "run the agent N independent times, verify each, keep the
 * best" — the test-time-scaling lever for weak models.
 *
 * The two unknowns are injected so this whole flow stays unit-testable against a
 * real temp git repo without a model:
 *   - `runAgent(workspace, signal)`: drive the agent to completion inside
 *     `workspace.dir` (the live adapter constructs an AgentSession with
 *     `cwd: workspace.dir` and calls prompt()). Honours `signal` for early-stop.
 *   - `verify(workspace, signal)`: run the verifier ladder in `workspace.dir`.
 *
 * Falls open with zero behavioural change when isolation is unavailable (no git
 * repo): it runs exactly ONE in-place attempt in `cwd` and verifies it, so the
 * caller gets the same single-attempt result it would have had anyway.
 */

export interface ParallelRolloutOptions {
	cwd: string;
	/** Independent rollouts to attempt. Clamped to >= 1 by the coordinator. */
	n: number;
	/** Max rollouts in flight. Defaults to n. */
	concurrency?: number;
	/** Stop once a rollout passes the verifier. Default true. */
	earlyStopOnPass?: boolean;
	/** Candidate id prefix (typically the traceId). */
	idPrefix?: string;
}

export type RunAgentFn = (workspace: RolloutWorkspace, signal: AbortSignal) => Promise<void>;
export type VerifyWorkspaceFn = (workspace: RolloutWorkspace, signal: AbortSignal) => Promise<RolloutVerification>;

export interface ParallelRolloutResult {
	/** True when isolated worktrees were used; false when it fell open to a single in-place run. */
	usedWorkspaces: boolean;
	/** Number of rollouts actually executed. */
	samplesRun: number;
	/** True if it stopped early because a rollout passed. */
	earlyStopped: boolean;
	/** Winner selection + rationale (undefined only if nothing ran). */
	selection?: BestOfNSelection;
	/** Rollout index of the winner whose edits were landed. */
	winnerIndex?: number;
	/** True if the winning rollout's diff was applied to `cwd` (always true for the in-place path). */
	promoted: boolean;
}

export class ParallelRolloutOrchestrator {
	private readonly options: ParallelRolloutOptions;
	private readonly workspaceManager: RolloutWorkspaceManager;

	constructor(options: ParallelRolloutOptions, workspaceManager?: RolloutWorkspaceManager) {
		this.options = options;
		this.workspaceManager = workspaceManager ?? new RolloutWorkspaceManager({ cwd: options.cwd });
	}

	async run(fns: { runAgent: RunAgentFn; verify: VerifyWorkspaceFn }): Promise<ParallelRolloutResult> {
		const workspaces = await this.workspaceManager.create(this.options.n);
		const usedWorkspaces = workspaces.length > 0;
		// Fall open to a single in-place attempt when isolation isn't available.
		const effective: RolloutWorkspace[] = usedWorkspaces ? workspaces : [{ index: 0, dir: this.options.cwd }];

		const coordinator = new RolloutCoordinator({
			n: effective.length,
			concurrency: this.options.concurrency,
			earlyStopOnPass: this.options.earlyStopOnPass,
			idPrefix: this.options.idPrefix,
		});

		try {
			const result = await coordinator.run<RolloutWorkspace>({
				sample: async (index, signal) => {
					const workspace = effective[index];
					await fns.runAgent(workspace, signal);
					return workspace;
				},
				verify: async (workspace, _index, signal) => fns.verify(workspace, signal),
			});

			let promoted = !usedWorkspaces; // in-place run needs no promotion
			const winnerWorkspace = result.winner?.sample;
			if (usedWorkspaces && winnerWorkspace) {
				const patch = await this.workspaceManager.captureDiff(winnerWorkspace);
				promoted = await this.workspaceManager.promote(patch);
			}

			return {
				usedWorkspaces,
				samplesRun: result.samplesRun,
				earlyStopped: result.earlyStopped,
				selection: result.selection,
				winnerIndex: winnerWorkspace?.index,
				promoted,
			};
		} finally {
			if (usedWorkspaces) await this.workspaceManager.cleanup();
		}
	}
}
