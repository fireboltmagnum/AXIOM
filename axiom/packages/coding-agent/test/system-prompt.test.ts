import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve AXIOM docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading AXIOM docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});

		test("includes tool snippets and guidelines when using a custom system prompt", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "CUSTOM AXIOM PROMPT",
				selectedTools: ["read", "rg", "understand_code", "code_graph", "flow_graph", "todo_list"],
				toolSnippets: {
					rg: "Search file contents with ripgrep",
					understand_code: "Analyze code structure",
					code_graph: "Build/query code graph",
					flow_graph: "Analyze execution/data/effect flow",
					todo_list: "Track multi-step work",
				},
				promptGuidelines: [
					"Use understand_code before modifying unfamiliar code.",
					"Use flow_graph when behavior or debugging flow matters.",
				],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("CUSTOM AXIOM PROMPT");
			expect(prompt).toContain("Available tools:");
			expect(prompt).toContain("- rg: Search file contents with ripgrep");
			expect(prompt).toContain("- understand_code: Analyze code structure");
			expect(prompt).toContain("- code_graph: Build/query code graph");
			expect(prompt).toContain("- flow_graph: Analyze execution/data/effect flow");
			expect(prompt).toContain("- todo_list: Track multi-step work");
			expect(prompt).toContain("- Use understand_code before modifying unfamiliar code.");
			expect(prompt).toContain("- Use flow_graph when behavior or debugging flow matters.");
			expect(prompt).toContain("AXIOM tool workflow:");
			expect(prompt).toContain("Use todo_list at the start of work with 3+ steps");
			expect(prompt).toContain("Use rg for exact text or regex search");
			expect(prompt).toContain("Use understand_code for unfamiliar files or folders before broad edits");
			expect(prompt).toContain("Use code_graph for cross-file relationships");
			expect(prompt).toContain("Use flow_graph when behavior matters");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
