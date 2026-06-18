import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { CodeActRuntime, type CodeActTool } from "../../axiom/CodeActRuntime.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const executeCodeSchema = Type.Object({
	code: Type.String({
		description:
			"A single JavaScript snippet (async; you may use await and return). Call the provided async functions to orchestrate a multi-step task in ONE call.",
	}),
	timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock budget in ms (default 30000)." })),
});

export type ExecuteCodeToolInput = Static<typeof executeCodeSchema>;

export interface ExecuteCodeToolDetails {
	toolCalls: number;
	timedOut: boolean;
	ok: boolean;
}

const TOOL_DOC = [
	"Programmatic tool calling: write ONE async JS snippet that orchestrates a multi-step task, instead of many separate tool calls.",
	"Available async functions (always `await` them):",
	"  read({ path }) -> file contents as string",
	"  write({ path, content }) -> 'ok'",
	"  ls({ path }) -> string[] of entries",
	"  grep({ pattern, path }) -> matching lines as string (ripgrep; path optional)",
	"  bash({ command }) -> { stdout, stderr, code }",
	"Loop, branch, and combine results in code; `return` a final value. Captured console output and the return value come back to you.",
].join("\n");

function buildTools(cwd: string, signal?: AbortSignal): Record<string, CodeActTool> {
	const ensure = () => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};
	return {
		read: (args) => {
			ensure();
			const { path } = (args ?? {}) as { path?: string };
			if (!path) throw new Error("read requires { path }");
			return readFileSync(resolveToCwd(path, cwd), "utf-8");
		},
		write: (args) => {
			ensure();
			const { path, content } = (args ?? {}) as { path?: string; content?: string };
			if (!path) throw new Error("write requires { path }");
			writeFileSync(resolveToCwd(path, cwd), content ?? "");
			return "ok";
		},
		ls: (args) => {
			ensure();
			const { path } = (args ?? {}) as { path?: string };
			return readdirSync(resolveToCwd(path ?? ".", cwd));
		},
		grep: (args) => {
			ensure();
			const { pattern, path } = (args ?? {}) as { pattern?: string; path?: string };
			if (!pattern) throw new Error("grep requires { pattern }");
			return runShell("rg", ["--no-heading", "-n", pattern, path ? resolveToCwd(path, cwd) : "."], cwd, signal).then(
				(r) => r.stdout,
			);
		},
		bash: (args) => {
			ensure();
			const { command } = (args ?? {}) as { command?: string };
			if (!command) throw new Error("bash requires { command }");
			return runShell("bash", ["-lc", command], cwd, signal);
		},
	};
}

function formatExecuteCodeCall(
	args: ExecuteCodeToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const code = typeof args?.code === "string" ? args.code : null;
	const firstLine = code?.split("\n").find((line) => line.trim()) ?? "";
	return `${theme.fg("toolTitle", theme.bold("execute_code"))} ${
		code === null ? invalidArg : theme.fg("toolOutput", firstLine.slice(0, 60))
	}`;
}

function formatExecuteCodeResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExecuteCodeToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 16;
	const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	if (lines.length > maxLines) {
		display.push(
			theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`),
		);
	}
	return `\n${display.join("\n")}`;
}

export function createExecuteCodeToolDefinition(
	cwd: string,
): ToolDefinition<typeof executeCodeSchema, ExecuteCodeToolDetails | undefined> {
	const runtime = new CodeActRuntime();
	return {
		name: "execute_code",
		label: "execute_code",
		description: TOOL_DOC,
		promptSnippet:
			"Run one JS snippet that calls read/write/ls/grep/bash to collapse a multi-step task into one call",
		promptGuidelines: [
			"Use execute_code when a task needs several dependent tool calls (loop over files, filter results, combine outputs) — write it once as code instead of many round-trips.",
			"Always await the provided functions; `return` the final value you need. Treat it with the same caution as bash.",
		],
		parameters: executeCodeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { code, timeoutMs }: ExecuteCodeToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (typeof code !== "string" || !code.trim()) {
				throw new Error("execute_code requires a non-empty `code` string.");
			}
			const tools = buildTools(cwd, signal);
			// Expose the tools as bare async functions (read/write/ls/grep/bash) in
			// addition to the `tools` object, so snippets can call them directly.
			const prelude = `const { ${Object.keys(tools).join(", ")} } = tools;\n`;
			const result = await runtime.run(prelude + code, tools, { timeoutMs });
			const parts: string[] = [];
			if (result.output.trim()) parts.push(result.output.trim());
			if (!result.ok)
				parts.push(`\n[execute_code ${result.timedOut ? "timed out" : "error"}]: ${result.error ?? ""}`);
			parts.push(`\n[${result.toolCalls.length} tool call(s)]`);
			return {
				content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
				details: { toolCalls: result.toolCalls.length, timedOut: result.timedOut, ok: result.ok },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatExecuteCodeCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatExecuteCodeResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createExecuteCodeTool(cwd: string): AgentTool<typeof executeCodeSchema> {
	return wrapToolDefinition(createExecuteCodeToolDefinition(cwd));
}

function runShell(
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (result: { stdout: string; stderr: string; code: number }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// already dead
			}
			finish({ stdout, stderr, code: 130 });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (err) => finish({ stdout, stderr: stderr + String(err), code: 127 }));
		child.on("close", (code) => finish({ stdout, stderr, code: code ?? 1 }));
	});
}
