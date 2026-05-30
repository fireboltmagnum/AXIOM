import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RolloutWorkspaceManager } from "../src/axiom/RolloutWorkspaceManager.ts";

function git(cwd: string, args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

describe("RolloutWorkspaceManager", () => {
	let repo: string;

	beforeEach(() => {
		repo = join(tmpdir(), `axiom-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(repo, { recursive: true });
		git(repo, ["init", "-q"]);
		git(repo, ["config", "user.email", "t@t.t"]);
		git(repo, ["config", "user.name", "t"]);
		git(repo, ["config", "commit.gpgsign", "false"]);
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "a.ts"), "export const value = 1;\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "init"]);
	});

	afterEach(() => {
		if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
	});

	it("creates N isolated worktrees at HEAD", async () => {
		const mgr = new RolloutWorkspaceManager({ cwd: repo });
		const spaces = await mgr.create(3);
		try {
			expect(spaces).toHaveLength(3);
			for (const ws of spaces) {
				expect(existsSync(join(ws.dir, "src", "a.ts"))).toBe(true);
				expect(ws.dir).not.toBe(repo);
			}
			// Independent: editing one does not affect another or the main tree.
			writeFileSync(join(spaces[0].dir, "src", "a.ts"), "export const value = 999;\n");
			expect(readFileSync(join(spaces[1].dir, "src", "a.ts"), "utf-8")).toContain("= 1");
			expect(readFileSync(join(repo, "src", "a.ts"), "utf-8")).toContain("= 1");
		} finally {
			await mgr.cleanup();
		}
	});

	it("seeds each worktree with the current uncommitted changes", async () => {
		// Uncommitted edit in the main tree before forking.
		writeFileSync(join(repo, "src", "a.ts"), "export const value = 2;\n");
		writeFileSync(join(repo, "src", "new.ts"), "export const fresh = true;\n");

		const mgr = new RolloutWorkspaceManager({ cwd: repo });
		const spaces = await mgr.create(2);
		try {
			for (const ws of spaces) {
				expect(readFileSync(join(ws.dir, "src", "a.ts"), "utf-8")).toContain("= 2");
				expect(existsSync(join(ws.dir, "src", "new.ts"))).toBe(true);
			}
		} finally {
			await mgr.cleanup();
		}
	});

	it("captures a rollout diff and promotes it into the main tree", async () => {
		const mgr = new RolloutWorkspaceManager({ cwd: repo });
		const [ws] = await mgr.create(1);
		try {
			writeFileSync(join(ws.dir, "src", "a.ts"), "export const value = 42;\n");
			writeFileSync(join(ws.dir, "src", "b.ts"), "export const added = true;\n");
			const patch = await mgr.captureDiff(ws);
			expect(patch).toContain("src/a.ts");

			const promoted = await mgr.promote(patch);
			expect(promoted).toBe(true);
			expect(readFileSync(join(repo, "src", "a.ts"), "utf-8")).toContain("= 42");
			expect(existsSync(join(repo, "src", "b.ts"))).toBe(true);
		} finally {
			await mgr.cleanup();
		}
	});

	it("cleanup removes all worktrees", async () => {
		const mgr = new RolloutWorkspaceManager({ cwd: repo });
		const spaces = await mgr.create(2);
		const dirs = spaces.map((s) => s.dir);
		await mgr.cleanup();
		expect(mgr.activeCount).toBe(0);
		for (const dir of dirs) expect(existsSync(dir)).toBe(false);
		// Worktree registry pruned — git worktree list shows only the main tree.
		expect(git(repo, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
	});

	it("falls open (returns []) outside a git repo", async () => {
		const notRepo = join(tmpdir(), `axiom-notrepo-${Date.now()}`);
		mkdirSync(notRepo, { recursive: true });
		try {
			const mgr = new RolloutWorkspaceManager({ cwd: notRepo });
			expect(await mgr.create(2)).toEqual([]);
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});

	it("promote of an empty patch is a no-op success", async () => {
		const mgr = new RolloutWorkspaceManager({ cwd: repo });
		expect(await mgr.promote("")).toBe(true);
	});
});
