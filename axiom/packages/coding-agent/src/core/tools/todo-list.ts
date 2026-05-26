import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import { type AxiomTodoItem, type AxiomTodoList, TodoListStore } from "../../axiom/TodoListStore.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * `todo_list` — agent-facing task tracking tool.
 *
 * The agent is expected to call this at the top of any multi-step task so the
 * user has a visible plan, then call it again to tick items off, mark a
 * current item, or fail/skip steps as work progresses. The state is per-session
 * and persisted to disk so a single chronological "list" survives across the
 * many tool turns of one task.
 *
 * Design choice: ONE tool with an `action` discriminator instead of N separate
 * tools. Fewer registrations, smaller tool catalog seen by the model, and the
 * actions all share the same state surface. The trade-off is a more complex
 * input schema, which we keep declarative via TypeBox so the model can read it.
 */

const todoListSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("read"),
			Type.Literal("add"),
			Type.Literal("set_current"),
			Type.Literal("check"),
			Type.Literal("uncheck"),
			Type.Literal("fail"),
			Type.Literal("skip"),
			Type.Literal("clear"),
		],
		{ description: "Operation to perform on the per-session todo list." },
	),
	items: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task descriptions. Required for 'create' (replaces list) and 'add' (appends).",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Existing item id. Required for set_current / check / uncheck / fail / skip.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Optional title for the list. Only honored on 'create'." })),
	note: Type.Optional(
		Type.String({
			description: "Short note attached to a status change (e.g. why a step failed). Honored on check/fail/skip.",
		}),
	),
});

export type TodoListToolInput = Static<typeof todoListSchema>;

export interface TodoListToolDetails {
	action: TodoListToolInput["action"];
	list?: AxiomTodoList;
}

export interface TodoListToolOptions {
	store?: TodoListStore;
}

const STATUS_GLYPH: Record<AxiomTodoItem["status"], string> = {
	pending: "☐",
	in_progress: "▶",
	complete: "☑",
	failed: "✗",
	skipped: "⊘",
};

/**
 * Render a list as the chat block the model + user both see. Plain UTF-8 box
 * glyphs so it shows correctly in any terminal without bringing in the TUI
 * Component machinery for tool results.
 */
function renderListToText(list: AxiomTodoList): string {
	const lines: string[] = [];
	const titleLine = list.title?.trim() || "Todo list";
	const done = list.items.filter((i) => i.status === "complete").length;
	lines.push(`${titleLine} — ${done}/${list.items.length} done`);
	if (list.items.length === 0) {
		lines.push("  (no items)");
		return lines.join("\n");
	}
	const maxIdWidth = String(list.items[list.items.length - 1].id).length;
	for (const item of list.items) {
		const id = String(item.id).padStart(maxIdWidth, " ");
		const glyph = STATUS_GLYPH[item.status];
		const note = item.note ? `  — ${item.note}` : "";
		lines.push(`  ${glyph} #${id}  ${item.text}${note}`);
	}
	return lines.join("\n");
}

function applyAction(list: AxiomTodoList | undefined, input: TodoListToolInput, sessionId: string): AxiomTodoList {
	const now = new Date().toISOString();
	if (input.action === "create") {
		return {
			sessionId,
			title: input.title,
			items: (input.items ?? []).map((text, idx) => ({ id: idx + 1, text: text.trim(), status: "pending" })),
			createdAt: now,
			updatedAt: now,
		};
	}
	if (input.action === "clear") {
		return {
			sessionId,
			title: list?.title,
			items: [],
			createdAt: list?.createdAt ?? now,
			updatedAt: now,
		};
	}
	if (!list) {
		throw new Error(`No todo list exists for this session. Call 'create' first.`);
	}

	if (input.action === "read") {
		return list;
	}

	if (input.action === "add") {
		if (!input.items || input.items.length === 0) {
			throw new Error(`'add' requires a non-empty items array.`);
		}
		const nextId = list.items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
		const additions: AxiomTodoItem[] = input.items.map((text, idx) => ({
			id: nextId + idx,
			text: text.trim(),
			status: "pending",
		}));
		return { ...list, items: [...list.items, ...additions], updatedAt: now };
	}

	if (input.id === undefined) {
		throw new Error(`Action '${input.action}' requires an 'id'.`);
	}

	const targetIndex = list.items.findIndex((i) => i.id === input.id);
	if (targetIndex === -1) {
		throw new Error(`No item with id=${input.id} in this list.`);
	}

	const nextItems = list.items.map((item, idx) => {
		if (idx !== targetIndex) {
			// Side effect of "set_current": clear in_progress from any sibling so
			// only one item is highlighted at a time.
			if (input.action === "set_current" && item.status === "in_progress") {
				return { ...item, status: "pending" as const };
			}
			return item;
		}
		switch (input.action) {
			case "set_current":
				return { ...item, status: "in_progress" as const, note: input.note ?? item.note };
			case "check":
				return { ...item, status: "complete" as const, note: input.note ?? item.note };
			case "uncheck":
				return { ...item, status: "pending" as const, note: input.note };
			case "fail":
				return { ...item, status: "failed" as const, note: input.note ?? item.note };
			case "skip":
				return { ...item, status: "skipped" as const, note: input.note ?? item.note };
			default:
				return item;
		}
	});

	return { ...list, items: nextItems, updatedAt: now };
}

export function createTodoListToolDefinition(
	options?: TodoListToolOptions,
): ToolDefinition<typeof todoListSchema, TodoListToolDetails> {
	const store = options?.store ?? new TodoListStore();
	return {
		name: "todo_list",
		label: "todo",
		description:
			"Maintain a per-task checklist visible to the user. ALWAYS create a list at the start of multi-step work and update statuses (set_current, check, fail, skip) as you progress. Actions: create (replaces list), read, add (append), set_current, check, uncheck, fail, skip, clear. The list is per-session and persisted to disk.",
		promptSnippet: "Track multi-step work via a persistent todo list",
		promptGuidelines: [
			"Use todo_list with action=create at the start of any task with 3+ discrete steps.",
			"Mark the active step with action=set_current before working on it.",
			"Use action=check (or fail/skip) the moment a step ends — don't batch.",
		],
		parameters: todoListSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const sessionId = ctx?.sessionManager?.getSessionId?.();
			if (!sessionId) {
				throw new Error("todo_list requires an active session.");
			}
			const existing = store.load(sessionId);
			const next = applyAction(existing, params, sessionId);
			const saved = store.save(next) ?? next;
			const text = renderListToText(saved);
			return {
				content: [{ type: "text", text }],
				details: { action: params.action, list: saved },
			};
		},
		renderCall(args, _theme, context: ToolRenderContext<any, TodoListToolInput>) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const summary = formatCall(args);
			text.setText(summary);
			return text;
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, TodoListToolInput>) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as TodoListToolDetails | undefined;
			text.setText(formatResult(details, theme));
			return text;
		},
	};
}

function formatCall(args: TodoListToolInput | undefined): string {
	if (!args) return "todo_list";
	const action = args.action;
	if (action === "create" || action === "add") {
		const n = args.items?.length ?? 0;
		return `todo_list ${action} (${n} item${n === 1 ? "" : "s"})`;
	}
	if (args.id !== undefined) {
		return `todo_list ${action} #${args.id}`;
	}
	return `todo_list ${action}`;
}

function formatResult(details: TodoListToolDetails | undefined, theme: Theme): string {
	const list = details?.list;
	if (!list) return "(no todo list)";
	const lines: string[] = [];
	const done = list.items.filter((i) => i.status === "complete").length;
	const title = list.title?.trim() || "Todo list";
	lines.push(theme.bold(`${title}`) + theme.fg("muted", `  ${done}/${list.items.length} done`));
	if (list.items.length === 0) {
		lines.push(theme.fg("muted", "  (no items)"));
		return lines.join("\n");
	}
	const maxIdWidth = String(list.items[list.items.length - 1].id).length;
	for (const item of list.items) {
		const id = String(item.id).padStart(maxIdWidth, " ");
		const glyph = STATUS_GLYPH[item.status];
		const colorize = colorForStatus(item.status, theme);
		const line = `  ${colorize(glyph)} ${theme.fg("dim", `#${id}`)}  ${colorize(item.text)}`;
		const noteSuffix = item.note ? theme.fg("muted", `    ${item.note}`) : "";
		lines.push(line);
		if (noteSuffix) lines.push(noteSuffix);
	}
	return lines.join("\n");
}

function colorForStatus(status: AxiomTodoItem["status"], theme: Theme): (s: string) => string {
	switch (status) {
		case "complete":
			return (s) => theme.fg("success", s);
		case "in_progress":
			return (s) => theme.fg("accent", s);
		case "failed":
			return (s) => theme.fg("error", s);
		case "skipped":
			return (s) => theme.fg("muted", s);
		default:
			return (s) => s;
	}
}

export function createTodoListTool(options?: TodoListToolOptions): AgentTool<typeof todoListSchema> {
	return wrapToolDefinition(createTodoListToolDefinition(options));
}
