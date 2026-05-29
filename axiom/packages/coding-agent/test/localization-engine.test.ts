import { describe, expect, it } from "vitest";
import { extractLocationHints, LocalizationEngine, type LocationHint } from "../src/axiom/LocalizationEngine.ts";

describe("extractLocationHints", () => {
	it("parses a Python traceback file+line", () => {
		const hints = extractLocationHints('Traceback:\n  File "app/models/user.py", line 42, in save\n    raise Boom');
		expect(hints).toContainEqual(
			expect.objectContaining({ file: "app/models/user.py", line: 42, kind: "traceback" }),
		);
	});

	it("parses a JS/TS stack frame path:line:col", () => {
		const hints = extractLocationHints("    at save (src/core/agent-session.ts:812:14)");
		expect(hints).toContainEqual(expect.objectContaining({ file: "src/core/agent-session.ts", line: 812 }));
	});

	it("parses a backticked path as a file-only hint", () => {
		const hints = extractLocationHints("The bug is somewhere in `src/utils/paths.ts` I think.");
		expect(hints).toContainEqual(expect.objectContaining({ file: "src/utils/paths.ts", kind: "path" }));
		expect(hints[0].line).toBeUndefined();
	});

	it("drops the bare-path hint when a path:line hint exists for the same file", () => {
		const hints = extractLocationHints("see `src/a.ts` — specifically src/a.ts:10 fails");
		const forA = hints.filter((h) => h.file === "src/a.ts");
		expect(forA).toHaveLength(1);
		expect(forA[0].line).toBe(10);
	});

	it("normalises ./ prefixes and backslashes", () => {
		const hints = extractLocationHints('File ".\\pkg\\mod.py", line 3');
		expect(hints[0].file).toBe("pkg/mod.py");
	});

	it("returns nothing for text with no locations", () => {
		expect(extractLocationHints("just a vague description with no paths")).toEqual([]);
	});
});

describe("LocalizationEngine", () => {
	const engine = new LocalizationEngine();

	it("ranks an explicit traceback file above a merely lexical match", () => {
		const result = engine.localize({
			hints: [{ file: "src/buggy.ts", line: 20, kind: "traceback", confidence: 0.95 }],
			lexical: [
				{ file: "src/buggy.ts", score: 1 },
				{ file: "src/unrelated.ts", score: 8 }, // high lexical, but not referenced
			],
		});

		expect(result.targets[0].file).toBe("src/buggy.ts");
		expect(result.targets[0].sources).toContain("explicit-line");
		expect(result.targets[0].line).toBe(20);
		expect(result.targets[0].confidence).toBe(1);
	});

	it("boosts a call-graph neighbour of a seed above a low-lexical file", () => {
		const result = engine.localize({
			hints: [{ file: "src/api.ts", line: 5, kind: "traceback", confidence: 0.9 }],
			lexical: [{ file: "src/loner.ts", score: 2 }],
			neighboursOf: (file) => (file === "src/api.ts" ? ["src/handler.ts"] : []),
		});

		const handler = result.targets.find((t) => t.file === "src/handler.ts");
		const loner = result.targets.find((t) => t.file === "src/loner.ts");
		expect(handler).toBeDefined();
		expect(handler!.sources).toContain("graph-neighbour");
		expect(handler!.score).toBeGreaterThan(loner!.score);
		expect(result.seeds).toEqual(["src/api.ts"]);
	});

	it("folds in failure-fingerprint recurrence", () => {
		const result = engine.localize({
			lexical: [{ file: "src/x.ts", score: 1 }],
			fingerprints: [{ file: "src/x.ts", recurrence: 2 }],
		});
		const x = result.targets.find((t) => t.file === "src/x.ts")!;
		expect(x.sources).toEqual(expect.arrayContaining(["lexical", "fingerprint"]));
	});

	it("filters out targets that do not exist on disk", () => {
		const result = engine.localize({
			hints: [
				{ file: "src/real.ts", line: 1, kind: "traceback", confidence: 0.9 },
				{ file: "src/ghost.ts", line: 2, kind: "traceback", confidence: 0.9 },
			],
			neighboursOf: () => ["src/ghost-neighbour.ts"],
			fileExists: (f) => f === "src/real.ts",
		});
		expect(result.targets.map((t) => t.file)).toEqual(["src/real.ts"]);
	});

	it("caps lexical score so it cannot outrank an explicit hint", () => {
		const result = engine.localize({
			hints: [{ file: "src/explicit.ts", kind: "path", confidence: 0.6 }], // file-only = 24
			lexical: [{ file: "src/huge.ts", score: 1000 }], // capped at 16
		});
		expect(result.targets[0].file).toBe("src/explicit.ts");
	});

	it("is deterministic and order-independent for tied scores", () => {
		const a = engine.localize({
			lexical: [
				{ file: "b.ts", score: 5 },
				{ file: "a.ts", score: 5 },
			],
		});
		const b = engine.localize({
			lexical: [
				{ file: "a.ts", score: 5 },
				{ file: "b.ts", score: 5 },
			],
		});
		expect(a.targets.map((t) => t.file)).toEqual(b.targets.map((t) => t.file));
		// Tie broken by file name ascending.
		expect(a.targets.map((t) => t.file)).toEqual(["a.ts", "b.ts"]);
	});

	it("respects maxTargets", () => {
		const lexical = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}.ts`, score: 20 - i }));
		const result = engine.localize({ lexical, maxTargets: 3 });
		expect(result.targets).toHaveLength(3);
	});

	it("parses taskText directly when hints are not supplied", () => {
		const result = engine.localize({
			taskText: 'Error\n  File "lib/calc.py", line 7, in add',
			fileExists: () => true,
		});
		expect(result.targets[0].file).toBe("lib/calc.py");
		expect(result.targets[0].line).toBe(7);
	});

	it("returns an empty result for no signals", () => {
		const result = engine.localize({});
		expect(result.targets).toEqual([]);
		expect(result.seeds).toEqual([]);
	});

	it("accumulates multiple sources on one file with combined score", () => {
		const hints: LocationHint[] = [{ file: "src/hot.ts", line: 3, kind: "traceback", confidence: 0.95 }];
		const result = engine.localize({
			hints,
			lexical: [{ file: "src/hot.ts", score: 4 }],
			fingerprints: [{ file: "src/hot.ts", recurrence: 1 }],
		});
		const hot = result.targets[0];
		expect(hot.file).toBe("src/hot.ts");
		expect(hot.sources).toEqual(expect.arrayContaining(["explicit-line", "lexical", "fingerprint"]));
		// 30 (line) + min(16, 4*2=8) + min(16, 1*8=8) = 46
		expect(hot.score).toBe(46);
	});
});
