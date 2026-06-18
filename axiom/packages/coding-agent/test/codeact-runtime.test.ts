import { describe, expect, it } from "vitest";
import { CodeActRuntime, type CodeActTool } from "../src/axiom/CodeActRuntime.ts";

const runtime = new CodeActRuntime();

describe("CodeActRuntime", () => {
	it("runs a snippet that calls a tool and returns a value", async () => {
		const tools: Record<string, CodeActTool> = {
			add: (args) => {
				const { a, b } = args as { a: number; b: number };
				return a + b;
			},
		};
		const result = await runtime.run("const s = await tools.add({ a: 2, b: 3 }); return s * 10;", tools);

		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe(50);
		expect(result.toolCalls).toEqual([{ name: "add", args: { a: 2, b: 3 } }]);
		expect(result.output).toContain("=> 50");
	});

	it("collapses a multi-step pipeline into one run, recording calls in order", async () => {
		const files = ["a.ts", "b.ts"];
		const tools: Record<string, CodeActTool> = {
			grep: () => files,
			read: (args) => `content of ${(args as { path: string }).path}`,
		};
		const code = `
			const hits = await tools.grep({ pattern: "x" });
			const bodies = [];
			for (const f of hits) bodies.push(await tools.read({ path: f }));
			return bodies.length;
		`;
		const result = await runtime.run(code, tools);

		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe(2);
		expect(result.toolCalls.map((c) => c.name)).toEqual(["grep", "read", "read"]);
		expect(result.toolCalls[1].args).toEqual({ path: "a.ts" });
		expect(result.toolCalls[2].args).toEqual({ path: "b.ts" });
	});

	it("captures console output", async () => {
		const result = await runtime.run("console.log('hello', 42); console.log({ a: 1 });", {});
		expect(result.ok).toBe(true);
		expect(result.output).toContain("hello 42");
		expect(result.output).toContain('"a": 1');
	});

	it("reports a thrown tool error and marks the call failed", async () => {
		const tools: Record<string, CodeActTool> = {
			boom: () => {
				throw new Error("kaboom");
			},
		};
		const result = await runtime.run("await tools.boom();", tools);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("kaboom");
		expect(result.toolCalls).toEqual([{ name: "boom", args: undefined, failed: true }]);
	});

	it("reports a syntax error without running", async () => {
		const result = await runtime.run("this is not valid js (((", {});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Syntax error");
		expect(result.toolCalls).toEqual([]);
	});

	it("enforces the timeout on awaited work", async () => {
		const tools: Record<string, CodeActTool> = {
			slow: () => new Promise((r) => setTimeout(r, 1000)),
		};
		const result = await runtime.run("await tools.slow(); return 'done';", tools, { timeoutMs: 80 });

		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.error).toContain("exceeded");
	});

	it("bounds output to maxOutputBytes", async () => {
		const result = await runtime.run(
			"for (let i = 0; i < 100000; i++) console.log('x');",
			{},
			{ maxOutputBytes: 1000 },
		);
		expect(result.output.length).toBeLessThanOrEqual(1000);
	});

	it("returns undefined returnValue cleanly when the snippet returns nothing", async () => {
		const result = await runtime.run("const x = 1;", {});
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBeUndefined();
	});
});
