import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphStore } from "../src/axiom/CodeGraphStore.ts";

describe("CodeGraphStore.neighborFiles", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `cg-nbr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(testDir, "src"), { recursive: true });
		// api.ts imports helper.ts -> a file→file import edge.
		writeFileSync(
			join(testDir, "src", "api.ts"),
			['import { helper } from "./helper";', "export function run() {", "  return helper();", "}"].join("\n"),
		);
		writeFileSync(
			join(testDir, "src", "helper.ts"),
			["export function helper(): number {", "  return 1;", "}"].join("\n"),
		);
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("returns [] when no graph is indexed (safe no-op)", () => {
		const store = new CodeGraphStore(join(testDir, ".cg-empty"));
		expect(store.neighborFiles("src/api.ts")).toEqual([]);
	});

	it("finds the import neighbour when indexed at cwd", () => {
		const store = new CodeGraphStore(join(testDir, ".cg-cwd"));
		store.index({ path: testDir });
		expect(store.neighborFiles("src/api.ts")).toContain("src/helper.ts");
	});

	it("reconciles paths when the graph was indexed at a subdirectory", () => {
		const store = new CodeGraphStore(join(testDir, ".cg-sub"));
		// Indexed at src/ -> node paths are "api.ts"/"helper.ts" (subdir-relative).
		store.index({ path: join(testDir, "src") });
		// Caller still uses cwd-relative seed; neighbour must come back cwd-relative.
		expect(store.neighborFiles("src/api.ts")).toContain("src/helper.ts");
	});

	it("does not return the seed file itself", () => {
		const store = new CodeGraphStore(join(testDir, ".cg-self"));
		store.index({ path: testDir });
		expect(store.neighborFiles("src/api.ts")).not.toContain("src/api.ts");
	});

	it("returns [] for an unknown file", () => {
		const store = new CodeGraphStore(join(testDir, ".cg-unknown"));
		store.index({ path: testDir });
		expect(store.neighborFiles("src/does-not-exist.ts")).toEqual([]);
	});
});
