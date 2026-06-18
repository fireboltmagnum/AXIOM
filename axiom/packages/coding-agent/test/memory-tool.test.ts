import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryToolDefinition } from "../src/core/tools/memory.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("memory tool", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `axiom-memtool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("remembers then recalls a fact across fresh tool instances", async () => {
		const remember = createMemoryToolDefinition(dir);
		await remember.execute(
			"m1",
			{ action: "remember", type: "project", text: "The agent targets SWE-Bench Pro with Gemma" },
			undefined,
			undefined,
			{} as never,
		);

		// A brand new tool instance (new session) must still recall it from disk.
		const recall = createMemoryToolDefinition(dir);
		const result = await recall.execute(
			"m2",
			{ action: "recall", text: "Gemma SWE-Bench target" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain("SWE-Bench Pro");
		expect(result.details?.action).toBe("recall");
		expect(result.details?.count).toBeGreaterThan(0);
	});

	it("lists and forgets by id", async () => {
		const tool = createMemoryToolDefinition(dir);
		const remembered = await tool.execute(
			"m1",
			{ action: "remember", type: "fact", text: "obsolete note" },
			undefined,
			undefined,
			{} as never,
		);
		const id = /id:(\S+)/.exec(textOf(remembered))?.[1];
		expect(id).toBeTruthy();

		const list = await tool.execute("m2", { action: "list" }, undefined, undefined, {} as never);
		expect(textOf(list)).toContain("obsolete note");

		const forgot = await tool.execute("m3", { action: "forget", id: id! }, undefined, undefined, {} as never);
		expect(textOf(forgot)).toContain("Forgot");

		const after = await tool.execute("m4", { action: "list" }, undefined, undefined, {} as never);
		expect(textOf(after)).toBe("(none)");
	});

	it("rejects remember without text and forget without id", async () => {
		const tool = createMemoryToolDefinition(dir);
		await expect(
			tool.execute("m1", { action: "remember", type: "fact" }, undefined, undefined, {} as never),
		).rejects.toThrow(/requires `text`/);
		await expect(tool.execute("m2", { action: "forget" }, undefined, undefined, {} as never)).rejects.toThrow(
			/requires `id`/,
		);
	});

	it("recall with no relevant memories reports none", async () => {
		const tool = createMemoryToolDefinition(dir);
		const result = await tool.execute(
			"m1",
			{ action: "recall", text: "anything at all" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain("no relevant memories");
		expect(result.details?.count).toBe(0);
	});
});
