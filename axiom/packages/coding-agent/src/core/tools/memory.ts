import { join } from "node:path";
import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { MemoryStore, type MemoryType } from "../../axiom/MemoryStore.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const memorySchema = Type.Object({
	action: Type.Union(
		[Type.Literal("remember"), Type.Literal("recall"), Type.Literal("forget"), Type.Literal("list")],
		{ description: "remember a new memory, recall relevant ones, forget one by id, or list everything." },
	),
	text: Type.Optional(
		Type.String({ description: "remember: the durable fact to store. recall: the query to search for." }),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("project"), Type.Literal("user")], {
			description: "remember only: kind of memory. 'user'/'preference' build the user model.",
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), { description: "remember only: optional keywords to aid later recall." }),
	),
	id: Type.Optional(Type.String({ description: "forget only: the id of the memory to drop." })),
	limit: Type.Optional(Type.Number({ description: "recall only: max results (default 5)." })),
});

export type MemoryToolInput = Static<typeof memorySchema>;

export interface MemoryToolDetails {
	action: string;
	count: number;
}

const TOOL_DOC = [
	"Agent-curated long-term memory that persists across sessions. Use it to remember durable facts so you don't re-derive them every session.",
	"Actions:",
	"  remember { text, type, tags? } — store a fact. type: 'user' (who they are) | 'preference' (how they like things) | 'project' (constraints/goals) | 'fact'.",
	"  recall { text, limit? } — retrieve the memories most relevant to a query (call this early when starting work).",
	"  list — show all stored memories with their ids.",
	"  forget { id } — drop a memory that is wrong or obsolete.",
	"Remember sparingly and concretely: stable preferences, project constraints, who the user is — not transient task state.",
].join("\n");

function storeFor(cwd: string): MemoryStore {
	return new MemoryStore(join(cwd, ".axiom", "memory"));
}

function renderEntries(entries: { id: string; type: string; text: string; tags: string[] }[]): string {
	if (entries.length === 0) return "(none)";
	return entries
		.map((e) => `[${e.type}] ${e.text}${e.tags.length ? ` (${e.tags.join(", ")})` : ""}  — id:${e.id}`)
		.join("\n");
}

export function createMemoryToolDefinition(
	cwd: string,
): ToolDefinition<typeof memorySchema, MemoryToolDetails | undefined> {
	return {
		name: "memory",
		label: "memory",
		description: TOOL_DOC,
		promptSnippet: "Remember/recall durable facts, preferences, and a user model across sessions",
		promptGuidelines: [
			"Call memory.recall when you start a task to load relevant context the user told you in past sessions.",
			"Call memory.remember when you learn something durable (a stable preference, a project constraint, who the user is). Keep entries short and concrete.",
		],
		parameters: memorySchema,
		executionMode: "sequential",
		async execute(_toolCallId, args: MemoryToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const store = storeFor(cwd);
			switch (args.action) {
				case "remember": {
					const text = args.text?.trim();
					if (!text) throw new Error("memory.remember requires `text`.");
					const entry = store.remember({ type: (args.type ?? "fact") as MemoryType, text, tags: args.tags });
					if (!entry) throw new Error("memory.remember failed to persist.");
					return {
						content: [{ type: "text", text: `Remembered [${entry.type}]: ${entry.text}  — id:${entry.id}` }],
						details: { action: "remember", count: 1 },
					};
				}
				case "recall": {
					const hits = store.recall(args.text ?? "", args.limit ?? 5);
					const body = hits.length
						? hits
								.map(
									(h) => `[${h.entry.type}] ${h.entry.text} (score ${h.score.toFixed(1)})  — id:${h.entry.id}`,
								)
								.join("\n")
						: "(no relevant memories)";
					return {
						content: [{ type: "text", text: body }],
						details: { action: "recall", count: hits.length },
					};
				}
				case "forget": {
					if (!args.id) throw new Error("memory.forget requires `id`.");
					const ok = store.forget(args.id);
					return {
						content: [{ type: "text", text: ok ? `Forgot id:${args.id}` : `No memory with id:${args.id}` }],
						details: { action: "forget", count: ok ? 1 : 0 },
					};
				}
				case "list": {
					const all = store.all();
					return {
						content: [{ type: "text", text: renderEntries(all) }],
						details: { action: "list", count: all.length },
					};
				}
				default:
					throw new Error(`Unknown memory action: ${String((args as { action?: unknown }).action)}`);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const action = typeof args?.action === "string" ? args.action : null;
			const detail = args?.text ? `: ${String(args.text).slice(0, 50)}` : args?.id ? `: ${args.id}` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("memory"))} ${
					action === null ? invalidArgText(theme) : theme.fg("toolOutput", action + detail)
				}`,
			);
			return text;
		},
		renderResult(result, options: ToolRenderResultOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as never, context.showImages).trim();
			if (!output) {
				text.setText("");
				return text;
			}
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 12;
			const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			if (lines.length > maxLines) {
				display.push(
					theme.fg("muted", `... (${lines.length - maxLines} more, ${keyHint("app.tools.expand", "to expand")})`),
				);
			}
			text.setText(`\n${display.join("\n")}`);
			return text;
		},
	};
}

export function createMemoryTool(cwd: string): AgentTool<typeof memorySchema> {
	return wrapToolDefinition(createMemoryToolDefinition(cwd));
}
