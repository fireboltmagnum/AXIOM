import { describe, expect, it } from "vitest";
import {
	formatHermesToolResponse,
	formatHermesToolsBlock,
	type HermesToolDef,
	parseHermesToolCalls,
	stripHermesToolCalls,
} from "../src/axiom/HermesToolFormat.ts";

describe("HermesToolFormat", () => {
	const tools: HermesToolDef[] = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
		{ name: "ls", description: "List a dir" },
	];

	it("formats a <tools> block with function schemas", () => {
		const block = formatHermesToolsBlock(tools);
		expect(block).toContain("<tools>");
		expect(block).toContain("</tools>");
		expect(block).toContain('"name": "read"');
		expect(block).toContain('"type": "function"');
		expect(block).toContain("<tool_call>");
	});

	it("parses a single tool_call", () => {
		const { calls, errors } = parseHermesToolCalls(
			'<tool_call>{"name": "read", "arguments": {"path": "a.ts"}}</tool_call>',
		);
		expect(errors).toEqual([]);
		expect(calls).toEqual([{ name: "read", arguments: { path: "a.ts" } }]);
	});

	it("parses multiple tool_calls in order", () => {
		const text = [
			'<tool_call>{"name": "ls", "arguments": {}}</tool_call>',
			"some prose",
			'<tool_call>{"name": "read", "arguments": {"path": "b.ts"}}</tool_call>',
		].join("\n");
		const { calls } = parseHermesToolCalls(text);
		expect(calls.map((c) => c.name)).toEqual(["ls", "read"]);
	});

	it("accepts arguments given as a JSON string", () => {
		const { calls } = parseHermesToolCalls(
			'<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"c.ts\\"}"}</tool_call>',
		);
		expect(calls[0]).toEqual({ name: "read", arguments: { path: "c.ts" } });
	});

	it("defaults missing arguments to {}", () => {
		const { calls } = parseHermesToolCalls('<tool_call>{"name": "ls"}</tool_call>');
		expect(calls[0]).toEqual({ name: "ls", arguments: {} });
	});

	it("records malformed blocks without throwing and keeps good ones", () => {
		const text = [
			"<tool_call>{not json}</tool_call>",
			'<tool_call>{"name": "ls", "arguments": {}}</tool_call>',
			'<tool_call>{"arguments": {}}</tool_call>',
		].join("\n");
		const { calls, errors } = parseHermesToolCalls(text);
		expect(calls).toEqual([{ name: "ls", arguments: {} }]);
		expect(errors.length).toBe(2);
	});

	it("renders a tool_response block", () => {
		const rendered = formatHermesToolResponse("read", "file body");
		expect(rendered).toContain("<tool_response>");
		expect(rendered).toContain("</tool_response>");
		expect(rendered).toContain('"name":"read"');
		expect(rendered).toContain("file body");
	});

	it("strips tool_call blocks to recover prose", () => {
		const text = 'Here is the plan.\n<tool_call>{"name": "ls", "arguments": {}}</tool_call>\nDone.';
		expect(stripHermesToolCalls(text)).toBe("Here is the plan.\nDone.");
	});

	it("returns empty for text with no tool calls", () => {
		expect(parseHermesToolCalls("just prose").calls).toEqual([]);
	});
});
