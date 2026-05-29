import { spawn } from "node:child_process";

/**
 * Auto-rollback on regression.
 *
 * Maintains a per-turn snapshot of the working tree (via `git stash create`,
 * which produces a stash object WITHOUT touching the index or working tree).
 * After each turn we have a baseline; if the next turn's verifier reports
 * STRICTLY MORE failures than the previous baseline did, we can restore
 * the tree from the snapshot via `git checkout-index` against the stash.
 *
 * Why `git stash create` instead of a plain commit:
 *   - Doesn't pollute HEAD with synthetic commits the user has to clean up.
 *   - Captures uncommitted changes (the agent's edits) too.
 *   - Cheap: ~1-5ms on small repos, never touches disk for working tree.
 *
 * Falls open everywhere: outside a git repo, missing `git`, dirty index, etc.
 * — snapshot returns undefined, restore is a no-op, the agent loop continues
 * as if rollback were disabled.
 */

export interface RollbackSnapshot {
	stashSha: string;
	issueCount: number;
	signature: string;
	takenAt: number;
}

export interface RollbackOutcome {
	restored: boolean;
	previousIssueCount: number;
	currentIssueCount: number;
	reason?: string;
}

export class AutoRollback {
	private readonly cwd: string;
	private snapshot: RollbackSnapshot | undefined;

	constructor(options: { cwd: string }) {
		this.cwd = options.cwd;
	}

	/** Number of in-flight snapshots (0 or 1). Mostly a debug surface. */
	get hasSnapshot(): boolean {
		return this.snapshot !== undefined;
	}

	/** Reset state between tasks. Called at task start. */
	reset(): void {
		this.snapshot = undefined;
	}

	/**
	 * Take a snapshot of the current working tree alongside the current
	 * verifier-issue baseline. Subsequent {@link checkRegression} calls will
	 * compare against this baseline. Returns undefined when snapshotting
	 * isn't possible (not a git repo, no `git`, empty tree).
	 */
	async snapshotAfterTurn(params: { issueCount: number; signature: string }): Promise<RollbackSnapshot | undefined> {
		const stashSha = await this.gitStashCreate();
		if (!stashSha) return undefined;
		this.snapshot = {
			stashSha,
			issueCount: params.issueCount,
			signature: params.signature,
			takenAt: Date.now(),
		};
		return this.snapshot;
	}

	/**
	 * Compare the NEW turn's issue count against the prior snapshot. If the
	 * new count is strictly worse (more failures), restore the tree from the
	 * snapshot. Returns `{ restored: true, ... }` on rollback. Caller is
	 * responsible for telling the agent what happened — typically by injecting
	 * a hidden retry message with the rollback context.
	 *
	 * Tolerance: we only rollback when STRICTLY worse. Same-count or better
	 * is left alone so a no-op turn doesn't undo progress.
	 */
	async checkRegression(params: { issueCount: number; signature: string }): Promise<RollbackOutcome> {
		const snap = this.snapshot;
		if (!snap) {
			return { restored: false, previousIssueCount: 0, currentIssueCount: params.issueCount };
		}
		// Same signature = same failure set; nothing actually changed in a
		// meaningful way. Don't rollback on no-op.
		if (snap.signature === params.signature) {
			return {
				restored: false,
				previousIssueCount: snap.issueCount,
				currentIssueCount: params.issueCount,
				reason: "no change vs snapshot",
			};
		}
		if (params.issueCount <= snap.issueCount) {
			// Same-or-better: advance the baseline. The new state is the
			// reference point going forward.
			this.snapshot = {
				stashSha: snap.stashSha,
				issueCount: params.issueCount,
				signature: params.signature,
				takenAt: Date.now(),
			};
			return {
				restored: false,
				previousIssueCount: snap.issueCount,
				currentIssueCount: params.issueCount,
				reason: params.issueCount < snap.issueCount ? "improved" : "no regression",
			};
		}
		// Strictly worse: roll back the working tree to the snapshot.
		const ok = await this.gitRestoreStash(snap.stashSha);
		if (!ok) {
			return {
				restored: false,
				previousIssueCount: snap.issueCount,
				currentIssueCount: params.issueCount,
				reason: "git restore failed",
			};
		}
		this.snapshot = undefined;
		return {
			restored: true,
			previousIssueCount: snap.issueCount,
			currentIssueCount: params.issueCount,
			reason: "regression",
		};
	}

	private async gitStashCreate(): Promise<string | undefined> {
		// `git stash create` builds a stash commit without changing the
		// working tree or running stash entries. Returns the SHA on stdout.
		// Empty stdout = nothing to stash (clean tree).
		const stdout = await this.runGit(["stash", "create"], 3000);
		const sha = stdout.trim();
		if (!sha) {
			// Edge case: nothing to stash. We still want to know "this is the
			// baseline state" — fall back to HEAD's tree.
			const head = (await this.runGit(["rev-parse", "HEAD"], 3000)).trim();
			return head || undefined;
		}
		return sha;
	}

	private async gitRestoreStash(stashSha: string): Promise<boolean> {
		// Two-step restore: read the stash's working tree into the index, then
		// check it out. This recreates exactly the state at snapshot time
		// across tracked files. Untracked files added by the agent during the
		// regressed turn remain — we do not delete them, only revert tracked
		// edits. That's deliberate: deleting untracked files is destructive
		// and a user could intervene to keep them.
		const readTree = await this.runGit(["read-tree", "--reset", "-u", stashSha], 5000);
		if (readTree === undefined) return false;
		return true;
	}

	private runGit(args: string[], timeoutMs: number): Promise<string> {
		return new Promise<string>((resolve) => {
			let stdout = "";
			let settled = false;
			const child = spawn("git", args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"] });
			const finish = (value: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					child.kill("SIGKILL");
				} catch {
					// already dead
				}
				resolve(value);
			};
			const timer = setTimeout(() => finish(""), Math.max(50, timeoutMs));
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});
			child.on("error", () => finish(""));
			child.on("close", (code) => finish(code === 0 ? stdout : ""));
		});
	}
}
