import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceVerifier } from "../src/axiom/RolloutVerifier.ts";

function git(cwd: string, args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

describe("createWorkspaceVerifier", () => {
	let repo: string;

	beforeEach(() => {
		repo = join(tmpdir(), `axiom-rv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(repo, "src"), { recursive: true });
		git(repo, ["init", "-q"]);
		git(repo, ["config", "user.email", "t@t.t"]);
		git(repo, ["config", "user.name", "t"]);
		git(repo, ["config", "commit.gpgsign", "false"]);
		writeFileSync(join(repo, "src", "a.ts"), "export const value = 1;\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "init"]);
	});

	afterEach(() => {
		if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
	});

	it("reports passed=true when the verifier passes on the changed files", async () => {
		writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "node verify.js" } }));
		writeFileSync(join(repo, "verify.js"), "process.exit(0);\n");
		writeFileSync(join(repo, "src", "a.ts"), "export const value = 2;\n");

		const verify = createWorkspaceVerifier({ verifierLadder: false });
		const result = await verify({ index: 0, dir: repo }, new AbortController().signal);

		expect(result.passed).toBe(true);
		expect(result.issueCount).toBe(0);
		expect(result.changedFileCount).toBeGreaterThanOrEqual(1);
	});

	it("reports passed=false with parsed issues when the verifier fails", async () => {
		writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "node verify.js" } }));
		writeFileSync(
			join(repo, "verify.js"),
			"console.error(\"src/a.ts(1,10): error TS2304: Cannot find name 'oops'.\"); process.exit(2);\n",
		);
		writeFileSync(join(repo, "src", "a.ts"), "export const value = oops;\n");

		const verify = createWorkspaceVerifier({ verifierLadder: false });
		const result = await verify({ index: 0, dir: repo }, new AbortController().signal);

		expect(result.passed).toBe(false);
		expect(result.issueCount).toBeGreaterThan(0);
		expect(result.firstFailure).toContain("src/a.ts");
	});

	it("picks up untracked new files as changed", async () => {
		writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "node verify.js" } }));
		writeFileSync(join(repo, "verify.js"), "process.exit(0);\n");
		writeFileSync(join(repo, "src", "brand-new.ts"), "export const fresh = true;\n");

		const verify = createWorkspaceVerifier({ verifierLadder: false });
		const result = await verify({ index: 0, dir: repo }, new AbortController().signal);

		expect(result.changedFileCount).toBeGreaterThanOrEqual(1);
	});

	it("returns a max-bad no-verifier sentinel when no verifier applies", async () => {
		// Change only a non-code file → no verifier detected.
		writeFileSync(join(repo, "README.md"), "# hello\n");

		const verify = createWorkspaceVerifier();
		const result = await verify({ index: 0, dir: repo }, new AbortController().signal);

		expect(result.passed).toBe(false);
		expect(result.signature).toBe("no-verifier");
		expect(result.issueCount).toBe(Number.MAX_SAFE_INTEGER);
	});
});
