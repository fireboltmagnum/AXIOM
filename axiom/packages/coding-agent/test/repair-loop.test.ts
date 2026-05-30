import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphStore } from "../src/axiom/CodeGraphStore.ts";
import { FailureFingerprintStore } from "../src/axiom/FailureFingerprintStore.ts";
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

	it("prefers targeted Vitest checks for changed unit specs", () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({
				scripts: { test: "vitest run", typecheck: "tsc" },
				devDependencies: { vitest: "1.0.0" },
			}),
		);
		writeFileSync(join(testDir, "src", "math.test.ts"), "import { test } from 'vitest';\n");

		const loop = new RepairLoop({ cwd: testDir });
		const verifier = loop.detectVerifier([join(testDir, "src", "math.test.ts")]);

		expect(verifier?.kind).toBe("javascript-test");
		expect(verifier?.command).toContain("vitest run");
		expect(verifier?.command).toContain("src/math.test.ts");
	});

	it("finds a nearby targeted unit spec for changed source files", () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({
				scripts: { test: "jest", typecheck: "tsc" },
				devDependencies: { jest: "29.0.0" },
			}),
		);
		writeFileSync(join(testDir, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
		writeFileSync(join(testDir, "src", "math.test.ts"), "test('add', () => {});\n");

		const loop = new RepairLoop({ cwd: testDir });
		const verifier = loop.detectVerifier([join(testDir, "src", "math.ts")]);

		expect(verifier?.kind).toBe("javascript-test");
		expect(verifier?.command).toContain("jest");
		expect(verifier?.command).toContain("src/math.test.ts");
	});

	it("builds a benchmark verifier ladder from targeted to broader checks", () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({
				scripts: { typecheck: "tsc", test: "vitest run" },
				devDependencies: { vitest: "1.0.0" },
			}),
		);
		writeFileSync(join(testDir, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
		writeFileSync(join(testDir, "src", "math.test.ts"), "import { test } from 'vitest';\n");

		const loop = new RepairLoop({ cwd: testDir });
		const verifiers = loop.detectVerifierSequence([join(testDir, "src", "math.ts")]);

		expect(verifiers.map((verifier) => verifier.command)).toEqual([
			expect.stringContaining("vitest run"),
			"npm run typecheck",
			"npm run test",
		]);
	});

	it("runs the verifier ladder until a broader verifier fails", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node typecheck.js", test: "node test.js" } }, null, 2),
		);
		writeFileSync(join(testDir, "typecheck.js"), "process.exit(0);\n");
		writeFileSync(
			join(testDir, "test.js"),
			"console.error(\"src/a.ts(2,10): error TS2304: Cannot find name 'missing'.\"); process.exit(2);\n",
		);
		writeFileSync(join(testDir, "src", "a.ts"), "export function run() {\n  return missing;\n}\n");

		const loop = new RepairLoop({ cwd: testDir });
		const result = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
			verifierLadder: true,
		});

		expect(result?.passed).toBe(false);
		expect(result?.verifier.command).toBe("npm run test");
		expect(result?.passedVerifiers.map((verifier) => verifier.command)).toEqual(["npm run typecheck"]);
		expect(result?.packet).toContain("Verifier ladder:");
		expect(result?.packet).toContain("Passed before failure: npm run typecheck");
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
		expect(result?.packet).toContain("Failure Source Pack:");
		expect(result?.packet).toContain("nearby symbols: function run@1");
		expect(result?.packet).toContain("> 2 |   return missing;");
	});

	it("adds a fused localization section that surfaces a call-graph neighbour", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node verify.js" } }, null, 2),
		);
		// The error is in api.ts, but api.ts imports helper.ts — the neighbour
		// should be surfaced as a candidate edit target.
		writeFileSync(
			join(testDir, "verify.js"),
			"console.error(\"src/api.ts(3,10): error TS2304: Cannot find name 'missing'.\"); process.exit(2);\n",
		);
		writeFileSync(
			join(testDir, "src", "api.ts"),
			['import { helper } from "./helper";', "export function run() {", "  return missing;", "}"].join("\n"),
		);
		writeFileSync(join(testDir, "src", "helper.ts"), ["export function helper(): number {", "  return 1;", "}"].join("\n"));

		const codeGraphStore = new CodeGraphStore(join(testDir, ".stores", "code"));
		codeGraphStore.index({ path: testDir });

		const loop = new RepairLoop({
			cwd: testDir,
			codeGraphStore,
			flowGraphStore: new FlowGraphStore(join(testDir, ".stores", "flow")),
		});
		const result = await loop.run({
			changedFiles: [join(testDir, "src", "api.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});

		expect(result?.passed).toBe(false);
		expect(result?.packet).toContain("Most likely edit targets (localization):");
		expect(result?.packet).toContain("src/api.ts:3");
		expect(result?.packet).toContain("call-graph neighbour of src/api.ts");
	});

	it("ranks likely root-cause failures above earlier symptom locations", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node verify.js" } }, null, 2),
		);
		writeFileSync(
			join(testDir, "verify.js"),
			[
				"console.error(\"src/unrelated.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.\");",
				"console.error(\"src/a.ts(2,10): error TS2304: Cannot find name 'missing'.\");",
				"process.exit(2);",
			].join("\n"),
		);
		writeFileSync(join(testDir, "src", "unrelated.ts"), `${"\n".repeat(9)}export const unrelated = 1;\n`);
		writeFileSync(join(testDir, "src", "a.ts"), "export function run() {\n  return missing;\n}\n");

		const loop = new RepairLoop({ cwd: testDir });
		const result = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});

		expect(result?.issues[0]).toMatchObject({
			file: "src/a.ts",
			line: 2,
			rankReasons: expect.arrayContaining(["changed file", "missing symbol/import"]),
		});
		expect(result?.packet).toContain("Root-cause priority:");
		expect(result?.packet).toContain("src/a.ts:2:10: score");
		expect(result?.packet).toContain("changed file");
	});

	it("blocks risky test weakening even when the verifier exits zero", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ scripts: { typecheck: "node verify.js" } }, null, 2),
		);
		writeFileSync(join(testDir, "verify.js"), "process.exit(0);\n");
		const testFile = join(testDir, "src", "a.test.ts");
		const before = "it('works', () => {\n  expect(1).toBe(1);\n});\n";
		writeFileSync(testFile, "it.skip('works', () => {\n  expect(1).toBe(1);\n});\n");

		const loop = new RepairLoop({ cwd: testDir });
		const result = await loop.run({
			changedFiles: [testFile],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
			preEditSnapshots: new Map([[testFile, { existed: true, content: before }]]),
		});

		expect(result?.exitCode).toBe(0);
		expect(result?.passed).toBe(false);
		expect(result?.patchRisk.shouldBlock).toBe(true);
		expect(result?.packet).toContain("AXIOM Patch Risk Gate blocked a risky code edit");
		expect(result?.packet).toContain("Introduced skipped or exclusive tests");
	});

	it("builds a verification evidence gate packet when code changed but no verifier exists", async () => {
		mkdirSync(join(testDir, "src"), { recursive: true });
		const changedFile = join(testDir, "src", "lonely.ts");
		writeFileSync(changedFile, "export const value = 1;\n");

		const loop = new RepairLoop({ cwd: testDir });
		const result = await loop.run({
			changedFiles: [changedFile],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});
		const noVerifier = loop.buildNoVerifierPacket({
			changedFiles: [changedFile],
			attempt: 1,
			maxAttempts: 2,
		});

		expect(result).toBeUndefined();
		expect(noVerifier?.signature).toContain("no-verifier:src/lonely.ts");
		expect(noVerifier?.packet).toContain("AXIOM Verification Evidence Gate");
		expect(noVerifier?.packet).toContain("Do not claim the task is done yet");
	});

	it("recalls repeated verifier failures through FailureFingerprintIndex", async () => {
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
		const failureStore = new FailureFingerprintStore(join(testDir, ".stores", "failures"));
		const loop = new RepairLoop({
			cwd: testDir,
			failureFingerprintStore: failureStore,
		});

		const first = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});
		const second = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 2,
			maxAttempts: 2,
		});

		expect(first?.memoryHints).toHaveLength(0);
		expect(second?.memoryHints[0]?.entry.occurrences).toBe(2);
		expect(second?.packet).toContain("FailureFingerprintIndex recalls");
		expect(second?.packet).toContain("typescript failure at src/a.ts:2:10");
	});

	it("marks a previous failure fingerprint as resolved after a later passing verifier", async () => {
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
		const failureStore = new FailureFingerprintStore(join(testDir, ".stores", "failures"));
		const loop = new RepairLoop({
			cwd: testDir,
			failureFingerprintStore: failureStore,
		});

		const failed = await loop.run({
			changedFiles: [join(testDir, "src", "a.ts")],
			timeoutMs: 3000,
			attempt: 1,
			maxAttempts: 2,
		});
		expect(failed?.signature).toBeTruthy();
		loop.recordSuccessfulRepair(failed?.signature ?? "", [join(testDir, "src", "a.ts")]);

		const entry = failureStore.all()[0];
		expect(entry?.resolvedCount).toBe(1);
		expect(entry?.repairHints[0]).toContain("resolved this fingerprint");
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
