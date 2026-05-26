import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphStore } from "../src/axiom/CodeGraphStore.ts";
import { FlowGraphStore } from "../src/axiom/FlowGraphStore.ts";
import { AXIOM_REPAIR_LOOP_TAG, parseRepairIssues, RepairLoop } from "../src/axiom/RepairLoop.ts";

describe("RepairLoop", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `axiom-repair-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("detects the cheapest available package verifier", () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { test: "node test.js", typecheck: "tsc" } }),
		);
		writeFileSync(join(testDir, "src", "a.ts"), "export const value = 1;\n");

		const loop = new RepairLoop({ cwd: testDir });
		const verifier = loop.detectVerifier([join(testDir, "src", "a.ts")]);

		expect(verifier?.command).toBe("npm run typecheck");
		expect(verifier?.kind).toBe("package-script");
		expect(verifier?.cwd).toBe(testDir);
	});

	it("prefers targeted Playwright checks for changed browser specs", () => {
		mkdirSync(join(testDir, "tests"), { recursive: true });
		writeFileSync(join(testDir, "playwright.config.ts"), "export default {};\n");
		writeFileSync(join(testDir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
		writeFileSync(join(testDir, "tests", "login.spec.ts"), "import { test } from '@playwright/test';\n");

		const loop = new RepairLoop({ cwd: testDir });
		const verifier = loop.detectVerifier([join(testDir, "tests", "login.spec.ts")]);

		expect(verifier?.kind).toBe("playwright");
		expect(verifier?.command).toContain("playwright test");
		expect(verifier?.command).toContain("tests/login.spec.ts");
	});

	it("parses TypeScript verifier failures with exact locations", () => {
		const issues = parseRepairIssues("src/a.ts(3,5): error TS2304: Cannot find name 'x'.", testDir);

		expect(issues).toEqual([
			{
				file: "src/a.ts",
				line: 3,
				column: 5,
				message: "error TS2304: Cannot find name 'x'.",
				kind: "typescript",
			},
		]);
	});

	it("runs a failing verifier and builds a focused repair packet", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node verify.js" } }, null, 2),
		);
		writeFileSync(
			join(testDir, "verify.js"),
			"console.error(\"src/a.ts(2,10): error TS2304: Cannot find name 'missing'.\"); process.exit(2);\n",
		);
		writeFileSync(join(testDir, "src", "a.ts"), "export function run() {\n  return missing;\n}\n");

		const loop = new RepairLoop({
			cwd: testDir,
			codeGraphStore: new CodeGraphStore(join(testDir, ".stores", "code")),
			flowGraphStore: new FlowGraphStore(join(testDir, ".stores", "flow")),
		});
		const result = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});

		expect(result?.passed).toBe(false);
		expect(result?.issues[0]).toMatchObject({
			file: "src/a.ts",
			line: 2,
			column: 10,
			kind: "typescript",
			owner: "function run",
		});
		expect(result?.packet).toContain(AXIOM_REPAIR_LOOP_TAG);
		expect(result?.packet).toContain("AXIOM RepairLoop verifier failed after a code edit.");
		expect(result?.packet).toContain("src/a.ts:2:10 in function run");
	});

	it("reports a passing verifier", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node verify.js" } }, null, 2),
		);
		writeFileSync(join(testDir, "verify.js"), "process.exit(0);\n");
		writeFileSync(join(testDir, "src", "a.ts"), "export const ok = true;\n");

		const loop = new RepairLoop({
			cwd: testDir,
			codeGraphStore: new CodeGraphStore(join(testDir, ".stores", "code")),
			flowGraphStore: new FlowGraphStore(join(testDir, ".stores", "flow")),
		});
		const result = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});

		expect(result?.passed).toBe(true);
		expect(result?.packet).toContain("RepairLoop verifier passed");
	});
});
