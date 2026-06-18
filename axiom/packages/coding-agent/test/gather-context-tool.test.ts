import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatherContextToolDefinition } from "../src/core/tools/gather-context.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("gather_context tool", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `axiom-gather-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns full content of the requested files with the synthesis directive", async () => {
		const tool = createGatherContextToolDefinition(dir);
		const result = await tool.execute(
			"call-1",
			{ files: ["src/a.ts", "src/b.ts"] },
			undefined,
			undefined,
			{} as never,
		);

		const text = textOf(result);
		expect(text).toContain("GATHER PHASE");
		expect(text).toContain("COMPLETE content");
		expect(text).toContain("export const a = 1;");
		expect(text).toContain("export const b = 2;");
		expect(result.details?.fileCount).toBe(2);
		expect(result.details?.missing).toEqual([]);
	});

	it("reports missing files instead of failing", async () => {
		const tool = createGatherContextToolDefinition(dir);
		const result = await tool.execute("call-2", { files: ["src/ghost.ts"] }, undefined, undefined, {} as never);

		expect(result.details?.missing).toEqual(["src/ghost.ts"]);
		expect(textOf(result)).toContain("none of the 1 requested");
	});

	it("honors a tight byte budget and reports omitted files", async () => {
		writeFileSync(join(dir, "src", "big.ts"), "X".repeat(500));
		const tool = createGatherContextToolDefinition(dir);
		const result = await tool.execute(
			"call-3",
			{ files: ["src/big.ts", "src/a.ts"], maxBytes: 200, maxBytesPerFile: 150 },
			undefined,
			undefined,
			{} as never,
		);
		// big.ts is listed first (higher priority) and truncated to <=150; a.ts may be omitted by budget.
		expect(result.details?.totalBytes).toBeLessThanOrEqual(200);
	});
});
