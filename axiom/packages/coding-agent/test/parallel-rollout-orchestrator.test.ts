import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParallelRolloutOrchestrator } from "../src/axiom/ParallelRolloutOrchestrator.ts";
import type { RolloutVerification } from "../src/axiom/RolloutCoordinator.ts";

function git(cwd: string, args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

function verification(over: Partial<RolloutVerification>): RolloutVerification {
	return {
		passed: false,
		issueCount: 1,
		changedFileCount: 1,
		signature: "s",
		verifierCommand: "t",
		durationMs: 1,
		...over,
	};
}

describe("ParallelRolloutOrchestrator", () => {
	let repo: string;

	beforeEach(() => {
		repo = join(tmpdir(), `axiom-pro-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(repo, "src"), { recursive: true });
		git(repo, ["init", "-q"]);
		git(repo, ["config", "user.email", "t@t.t"]);
		git(repo, ["config", "user.name", "t"]);
		git(repo, ["config", "commit.gpgsign", "false"]);
		writeFileSync(join(repo, "src", "a.ts"), "export const value = 0;\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "init"]);
	});

	afterEach(() => {
		if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
	});

	it("runs N isolated rollouts and promotes the passing one's edits into cwd", async () => {
		const orch = new ParallelRolloutOrchestrator({ cwd: repo, n: 3, earlyStopOnPass: false });
		const result = await orch.run({
			// Each rollout writes a distinct value; only rollout 2 "passes".
			runAgent: async (ws) => {
				writeFileSync(join(ws.dir, "src", "a.ts"), `export const value = ${ws.index === 2 ? 42 : ws.index};\n`);
			},
			verify: async (ws) => verification({ passed: ws.index === 2, issueCount: ws.index === 2 ? 0 : 1 }),
		});

		expect(result.usedWorkspaces).toBe(true);
		expect(result.samplesRun).toBe(3);
		expect(result.winnerIndex).toBe(2);
		expect(result.promoted).toBe(true);
		// The winner's edit is now in the real working tree.
		expect(readFileSync(join(repo, "src", "a.ts"), "utf-8")).toContain("= 42");
	});

	it("does not leave worktrees behind", async () => {
		const orch = new ParallelRolloutOrchestrator({ cwd: repo, n: 2, earlyStopOnPass: false });
		await orch.run({
			runAgent: async (ws) => writeFileSync(join(ws.dir, "src", "a.ts"), `export const value = ${ws.index};\n`),
			verify: async () => verification({ passed: true, issueCount: 0 }),
		});
		expect(git(repo, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
	});

	it("falls open to a single in-place run outside a git repo", async () => {
		const notRepo = join(tmpdir(), `axiom-pro-nr-${Date.now()}`);
		mkdirSync(join(notRepo, "src"), { recursive: true });
		try {
			let ranIn = "";
			const orch = new ParallelRolloutOrchestrator({ cwd: notRepo, n: 4 });
			const result = await orch.run({
				runAgent: async (ws) => {
					ranIn = ws.dir;
				},
				verify: async () => verification({ passed: true, issueCount: 0 }),
			});
			expect(result.usedWorkspaces).toBe(false);
			expect(result.samplesRun).toBe(1);
			expect(result.promoted).toBe(true);
			expect(ranIn).toBe(notRepo); // ran directly in cwd, not a worktree
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});

	it("selects the most surgical fix when several rollouts pass", async () => {
		const orch = new ParallelRolloutOrchestrator({ cwd: repo, n: 3, earlyStopOnPass: false });
		const result = await orch.run({
			runAgent: async (ws) => writeFileSync(join(ws.dir, "src", "a.ts"), `export const value = ${ws.index};\n`),
			// All pass; rollout 1 changed the fewest files.
			verify: async (ws) => verification({ passed: true, issueCount: 0, changedFileCount: ws.index === 1 ? 1 : 5 }),
		});
		expect(result.winnerIndex).toBe(1);
		expect(readFileSync(join(repo, "src", "a.ts"), "utf-8")).toContain("= 1");
	});
});
