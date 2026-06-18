import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecuteCodeToolDefinition } from "../src/core/tools/execute-code.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("execute_code tool", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `axiom-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "AAA\n");
		writeFileSync(join(dir, "src", "b.ts"), "BBB\n");
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("orchestrates read across multiple files in one call", async () => {
		const tool = createExecuteCodeToolDefinition(dir);
		const code = `
			const entries = await ls({ path: "src" });
			const bodies = [];
			for (const name of entries.sort()) bodies.push(await read({ path: "src/" + name }));
			return bodies.join("");
		`;
		const result = await tool.execute("c1", { code }, undefined, undefined, {} as never);

		const text = textOf(result);
		expect(text).toContain("AAA");
		expect(text).toContain("BBB");
		expect(result.details?.ok).toBe(true);
		expect(result.details?.toolCalls).toBe(3); // ls + 2 reads
	});

	it("can write a file via the exposed write()", async () => {
		const tool = createExecuteCodeToolDefinition(dir);
		const result = await tool.execute(
			"c2",
			{ code: 'await write({ path: "out.txt", content: "hello" }); return "wrote";' },
			undefined,
			undefined,
			{} as never,
		);

		expect(textOf(result)).toContain("wrote");
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("hello");
	});

	it("reports a runtime error without throwing", async () => {
		const tool = createExecuteCodeToolDefinition(dir);
		const result = await tool.execute(
			"c3",
			{ code: 'await read({ path: "does-not-exist.ts" });' },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details?.ok).toBe(false);
		expect(textOf(result)).toContain("error");
	});

	it("rejects an empty code string", async () => {
		const tool = createExecuteCodeToolDefinition(dir);
		await expect(tool.execute("c4", { code: "  " }, undefined, undefined, {} as never)).rejects.toThrow(/non-empty/);
	});

	it("runs bash through the exposed bash()", async () => {
		const tool = createExecuteCodeToolDefinition(dir);
		const result = await tool.execute(
			"c5",
			{ code: 'const r = await bash({ command: "echo hi" }); return r.stdout.trim();' },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain("hi");
	});
});
