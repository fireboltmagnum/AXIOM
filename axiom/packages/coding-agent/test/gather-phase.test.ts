import { describe, expect, it } from "vitest";
import { GatherPhase, type GatherTarget, renderGatherPack } from "../src/axiom/GatherPhase.ts";

/** In-memory file system for deterministic, fs-free tests. */
function fakeFs(files: Record<string, string>) {
	return {
		cwd: "/repo",
		fileExists: (abs: string) => abs.replace("/repo/", "") in files || abs in files,
		readFile: (abs: string) => files[abs.replace("/repo/", "")] ?? files[abs],
	};
}

describe("GatherPhase", () => {
	const phase = new GatherPhase();

	it("loads full content of the requested files", () => {
		const fs = fakeFs({ "src/a.ts": "AAA\n", "src/b.ts": "BBB\n" });
		const pack = phase.build([{ file: "src/a.ts" }, { file: "src/b.ts" }], fs);

		expect(pack.files.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(pack.files[0].content).toBe("AAA\n");
		expect(pack.files.every((f) => !f.truncated)).toBe(true);
	});

	it("orders by priority desc then path asc (deterministic, order-independent)", () => {
		const fs = fakeFs({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
		const targets: GatherTarget[] = [
			{ file: "c.ts", priority: 1 },
			{ file: "a.ts", priority: 5 },
			{ file: "b.ts", priority: 5 },
		];
		const pack = phase.build(targets, fs);
		// priority 5 first (a before b by name), then priority 1.
		expect(pack.files.map((f) => f.file)).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("dedupes a file and keeps its highest priority", () => {
		const fs = fakeFs({ "x.ts": "x", "y.ts": "y" });
		const pack = phase.build(
			[
				{ file: "x.ts", priority: 0 },
				{ file: "y.ts", priority: 1 },
				{ file: "x.ts", priority: 9 },
			],
			fs,
		);
		expect(pack.files.map((f) => f.file)).toEqual(["x.ts", "y.ts"]);
	});

	it("respects the global byte budget and omits lower-priority files", () => {
		const fs = fakeFs({ "big.ts": "X".repeat(100), "small.ts": "Y".repeat(100) });
		const pack = phase.build(
			[
				{ file: "big.ts", priority: 10 },
				{ file: "small.ts", priority: 1 },
			],
			{ ...fs, maxBytes: 120, maxBytesPerFile: 100 },
		);
		// big.ts (100) fits; small.ts would exceed 120 → omitted.
		expect(pack.files.map((f) => f.file)).toEqual(["big.ts"]);
		expect(pack.omitted).toEqual(["small.ts"]);
	});

	it("truncates a file over the per-file cap, keeping head and tail", () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const fs = fakeFs({ "huge.ts": body });
		const pack = phase.build([{ file: "huge.ts" }], { ...fs, maxBytesPerFile: 400 });

		expect(pack.files[0].truncated).toBe(true);
		expect(pack.files[0].content).toContain("line 0"); // head
		expect(pack.files[0].content).toContain("line 199"); // tail
		expect(pack.files[0].content).toContain("bytes omitted by gather budget");
		expect(pack.files[0].bytes).toBeLessThanOrEqual(420);
	});

	it("records missing files without throwing", () => {
		const fs = fakeFs({ "real.ts": "ok" });
		const pack = phase.build([{ file: "real.ts" }, { file: "ghost.ts" }], fs);
		expect(pack.files.map((f) => f.file)).toEqual(["real.ts"]);
		expect(pack.missing).toEqual(["ghost.ts"]);
	});

	it("renders a synthesis block that demands writing from full content", () => {
		const fs = fakeFs({ "src/a.ts": "export const a = 1;" });
		const rendered = renderGatherPack(phase.build([{ file: "src/a.ts" }], fs));
		expect(rendered).toContain("GATHER PHASE");
		expect(rendered).toContain("COMPLETE content");
		expect(rendered).toContain("--- src/a.ts (19 bytes) ---");
		expect(rendered).toContain("export const a = 1;");
	});

	it("renders an empty string for an empty pack", () => {
		const fs = fakeFs({});
		expect(renderGatherPack(phase.build([], fs))).toBe("");
	});

	it("notes omitted files in the rendered block", () => {
		const fs = fakeFs({ "big.ts": "X".repeat(100), "small.ts": "Y".repeat(100) });
		const rendered = renderGatherPack(
			phase.build(
				[
					{ file: "big.ts", priority: 10 },
					{ file: "small.ts", priority: 1 },
				],
				{ ...fs, maxBytes: 120, maxBytesPerFile: 100 },
			),
		);
		expect(rendered).toContain("omitted 1 lower-priority file");
		expect(rendered).toContain("small.ts");
	});
});
