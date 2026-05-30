import { spawnSync } from "node:child_process";
import { RepairLoop } from "./RepairLoop.ts";
import type { RolloutVerification } from "./RolloutCoordinator.ts";
import type { RolloutWorkspace } from "./RolloutWorkspaceManager.ts";
import type { VerifyWorkspaceFn } from "./ParallelRolloutOrchestrator.ts";

/**
 * The verifier half of the live parallel-rollout adapter.
 *
 * Given a rollout's isolated workspace, this runs AXIOM's existing repair-loop
 * verifier ladder (typecheck → targeted test → broader test) inside that
 * workspace and maps the result onto the {@link RolloutVerification} shape the
 * {@link RolloutCoordinator} ranks on. It is the deterministic, model-free
 * counterpart to the (model-dependent) `runAgent` half, so it can be tested
 * directly against a real temp git repo.
 *
 * The set of files a rollout changed is derived from `git diff --name-only HEAD`
 * inside the workspace, so the right verifier is auto-detected from exactly what
 * the agent touched.
 */

export interface WorkspaceVerifierOptions {
	/** Verifier run timeout per workspace, ms. Default 120_000. */
	timeoutMs?: number;
	/** Run the full verifier ladder (typecheck → test) rather than a single check. Default true. */
	verifierLadder?: boolean;
}

export function createWorkspaceVerifier(options: WorkspaceVerifierOptions = {}): VerifyWorkspaceFn {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const verifierLadder = options.verifierLadder ?? true;

	return async (workspace: RolloutWorkspace): Promise<RolloutVerification> => {
		const changedFiles = gitChangedFiles(workspace.dir);
		const loop = new RepairLoop({ cwd: workspace.dir });
		const result = await loop.run({
			changedFiles,
			timeoutMs,
			attempt: 1,
			maxAttempts: 1,
			verifierLadder,
		});

		// No applicable verifier: we cannot confirm this rollout. Rank it below
		// any rollout we COULD verify (max-bad issue count) but keep it as a
		// last-resort candidate so a run with no verifier anywhere still returns one.
		if (!result) {
			return {
				passed: false,
				issueCount: Number.MAX_SAFE_INTEGER,
				changedFileCount: changedFiles.length,
				signature: "no-verifier",
				verifierCommand: "(no verifier detected)",
				durationMs: 0,
				firstFailure: "no verifier could be detected for the changed files",
			};
		}

		const firstIssue = result.issues[0];
		return {
			passed: result.passed,
			issueCount: result.issues.length,
			changedFileCount: changedFiles.length,
			signature: result.signature,
			verifierCommand: result.verifier.command,
			durationMs: result.durationMs,
			firstFailure: firstIssue
				? `${firstIssue.file ?? "(unknown)"}${firstIssue.line ? `:${firstIssue.line}` : ""}: ${firstIssue.message}`
				: undefined,
		};
	};
}

/** Absolute paths of files changed vs HEAD in `dir` (tracked + untracked). [] outside a repo. */
function gitChangedFiles(dir: string): string[] {
	const tracked = runGit(dir, ["diff", "--name-only", "HEAD"]);
	const untracked = runGit(dir, ["ls-files", "--others", "--exclude-standard"]);
	const names = new Set<string>();
	for (const line of `${tracked}\n${untracked}`.split("\n")) {
		const name = line.trim();
		if (name) names.add(name);
	}
	return [...names].map((name) => `${dir}/${name}`);
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return result.status === 0 ? result.stdout : "";
}
