import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolated working copies for parallel rollouts.
 *
 * True repeated-sampling (see {@link RolloutCoordinator}) needs each rollout to
 * edit its OWN copy of the repo so attempts don't clobber each other. Git
 * worktrees are the right primitive: they share the object store (cheap, no
 * re-clone) but give each rollout an independent working directory checked out
 * at the same baseline commit. The agent edits files there, the verifier runs
 * there, and the winning rollout's diff is captured and applied back to the
 * real working tree.
 *
 * This manager is the missing INFRASTRUCTURE for live parallel rollouts; it is
 * deliberately decoupled from AgentSession so it can be tested against a real
 * temp git repo without spinning up a model. Falls open everywhere (no git, not
 * a repo): {@link create} returns [] and the caller runs a single in-place
 * attempt as before.
 */

export interface RolloutWorkspace {
	index: number;
	/** Absolute path to this rollout's isolated working directory. */
	dir: string;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export class RolloutWorkspaceManager {
	private readonly cwd: string;
	private readonly workspaces: RolloutWorkspace[] = [];
	private root: string | undefined;

	constructor(options: { cwd: string }) {
		this.cwd = options.cwd;
	}

	get activeCount(): number {
		return this.workspaces.length;
	}

	/**
	 * Create `count` isolated worktrees checked out at the current HEAD, each
	 * seeded with the working tree's current uncommitted changes so every
	 * rollout starts from the SAME state the agent is in now. Returns the
	 * created workspaces (possibly fewer than `count`, or [] if git/worktrees
	 * are unavailable — the caller should then fall back to a single in-place run).
	 */
	async create(count: number): Promise<RolloutWorkspace[]> {
		const n = Math.max(0, Math.floor(count));
		if (n === 0) return [];
		const head = (await this.git(["rev-parse", "HEAD"], this.cwd)).stdout.trim();
		if (!head) return []; // not a repo / no commits — fall open

		// Capture current uncommitted state once so each worktree can replay it.
		const seedPatch = await this.captureWorkingTreePatch(this.cwd);

		this.root = mkdtempSync(join(tmpdir(), "axiom-rollouts-"));
		for (let index = 0; index < n; index++) {
			const dir = join(this.root, `r${index}`);
			const add = await this.git(["worktree", "add", "--detach", dir, head], this.cwd);
			if (add.code !== 0 || !existsSync(dir)) continue;
			if (seedPatch) await this.applyPatchIn(dir, seedPatch);
			this.workspaces.push({ index, dir });
		}
		return [...this.workspaces];
	}

	/**
	 * Capture a workspace's changes (tracked + untracked) as a single patch
	 * relative to its baseline, suitable for {@link promote}. Empty string when
	 * the rollout made no changes.
	 */
	async captureDiff(workspace: RolloutWorkspace): Promise<string> {
		return this.captureWorkingTreePatch(workspace.dir);
	}

	/**
	 * Apply a captured rollout patch to the real working tree. Returns true on
	 * success. Use with {@link captureDiff} on the winning rollout to land its
	 * edits in the user's checkout.
	 */
	async promote(patch: string): Promise<boolean> {
		if (!patch.trim()) return true; // nothing to apply = trivially promoted
		return this.applyPatchIn(this.cwd, patch);
	}

	/** Remove all created worktrees and the temp root. Safe to call multiple times. */
	async cleanup(): Promise<void> {
		for (const workspace of this.workspaces) {
			await this.git(["worktree", "remove", "--force", workspace.dir], this.cwd);
		}
		this.workspaces.length = 0;
		if (this.root && existsSync(this.root)) {
			try {
				rmSync(this.root, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
		// Prune any dangling worktree administrative entries.
		await this.git(["worktree", "prune"], this.cwd);
		this.root = undefined;
	}

	/** Stage everything and emit a binary-safe patch vs HEAD; "" when clean. */
	private async captureWorkingTreePatch(dir: string): Promise<string> {
		const add = await this.git(["add", "-A"], dir);
		if (add.code !== 0) return "";
		const diff = await this.git(["diff", "--cached", "--binary"], dir);
		// Leave the index staged: worktrees are throwaway, and the real cwd's
		// staging is restored by the caller's own flow. We only read the patch.
		return diff.code === 0 ? diff.stdout : "";
	}

	private async applyPatchIn(dir: string, patch: string): Promise<boolean> {
		const patchFile = join(this.root ?? tmpdir(), `seed-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
		try {
			writeFileSync(patchFile, patch);
			const applied = await this.git(["apply", "--whitespace=nowarn", patchFile], dir);
			return applied.code === 0;
		} catch {
			return false;
		} finally {
			try {
				rmSync(patchFile, { force: true });
			} catch {
				// ignore
			}
		}
	}

	private git(args: string[], cwd: string, timeoutMs = 10000): Promise<GitResult> {
		return new Promise<GitResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			const finish = (result: GitResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					child.kill("SIGKILL");
				} catch {
					// already dead
				}
				resolve(result);
			};
			const timer = setTimeout(() => finish({ code: 124, stdout, stderr }), Math.max(50, timeoutMs));
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf-8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			child.on("error", () => finish({ code: 127, stdout, stderr }));
			child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
		});
	}
}
