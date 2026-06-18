import type { AgentTool } from "@axiom/agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const optionSchema = Type.Object({
	label: Type.String({ description: "Short option label." }),
	description: Type.String({ description: "One sentence explaining the option's impact or tradeoff." }),
});

const questionSchema = Type.Object({
	header: Type.String({ description: "Short heading, ideally 12 characters or fewer." }),
	question: Type.String({ description: "The concrete question to show the user." }),
	options: Type.Optional(
		Type.Array(optionSchema, {
			minItems: 2,
			maxItems: 6,
			description: "Two to six choices. Put the recommended option first when there is a recommended choice.",
		}),
	),
	selectionMode: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("multi")], {
			description: "Use single for mutually exclusive choices, or multi when more than one option can be selected.",
		}),
	),
	allowCustom: Type.Optional(
		Type.Boolean({ description: "Allow a free-form answer in addition to the listed choices. Defaults to true." }),
	),
});

const askUserQuestionSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		minItems: 1,
		maxItems: 3,
		description: "One to three short questions. Prefer one question whenever possible.",
	}),
});

export type AskUserQuestionToolInput = Static<typeof askUserQuestionSchema>;

export interface AskUserQuestionToolDetails {
	answers: Array<{ header: string; answer: string }>;
}

export function createAskUserQuestionToolDefinition(): ToolDefinition<
	typeof askUserQuestionSchema,
	AskUserQuestionToolDetails
> {
	return {
		name: "ask_user_question",
		label: "ask user",
		description:
			"Pause and ask the user one to three concise questions when a decision, missing requirement, permission-sensitive choice, or mutually exclusive tradeoff materially affects the result. Do not use it for facts you can discover with tools, low-impact preferences, or to avoid making a reasonable reversible decision.",
		promptSnippet: "Ask the user a bounded question when a consequential decision cannot be inferred safely",
		promptGuidelines: [
			"Use ask_user_question only when the answer materially changes implementation, scope, cost, safety, or an irreversible action.",
			"Do not ask for information that can be discovered with read, rg, code_graph, flow_graph, web_research, or other available tools.",
			"Prefer one question. Offer 2-3 mutually exclusive options, put the recommended option first, and explain the tradeoff briefly.",
		],
		parameters: askUserQuestionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx?.hasUI) {
				throw new Error("ask_user_question requires an interactive host.");
			}
			const answers: AskUserQuestionToolDetails["answers"] = [];
			for (const question of params.questions) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const allowCustom = question.allowCustom !== false;
				const multi = question.selectionMode === "multi";
				let answer: string | undefined;
				if (question.options?.length) {
					const rendered = question.options.map((option) => `${option.label} — ${option.description}`);
					if (allowCustom) rendered.push("Other — Enter a different answer");
					if (multi) {
						const selected = ctx.ui.multiSelect
							? await ctx.ui.multiSelect(question.question, rendered, { signal })
							: await fallbackMultiSelect(ctx.ui.select.bind(ctx.ui), question.question, rendered, signal);
						if (!selected?.length) throw new Error("User cancelled the question.");
						const nonCustom = selected
							.filter((item) => !item.startsWith("Other —"))
							.map((item) => item.split(" — ", 1)[0]);
						const custom = selected.some((item) => item.startsWith("Other —"))
							? await ctx.ui.input(question.question, "Type your additional answer", { signal })
							: undefined;
						answer = [...nonCustom, ...(custom?.trim() ? [custom.trim()] : [])].join(", ");
					} else {
						const selected = await ctx.ui.select(question.question, rendered, { signal });
						if (!selected) throw new Error("User cancelled the question.");
						if (selected.startsWith("Other —")) {
							answer = await ctx.ui.input(question.question, "Type your answer", { signal });
						} else {
							answer = selected.split(" — ", 1)[0];
						}
					}
				} else {
					answer = await ctx.ui.input(question.question, "Type your answer", { signal });
				}
				if (!answer?.trim()) throw new Error("User cancelled the question.");
				answers.push({ header: question.header, answer: answer.trim() });
			}
			return {
				content: [{ type: "text", text: answers.map((item) => `${item.header}: ${item.answer}`).join("\n") }],
				details: { answers },
			};
		},
	};
}

export function createAskUserQuestionTool(): AgentTool<any> {
	return wrapToolDefinition(createAskUserQuestionToolDefinition());
}

async function fallbackMultiSelect(
	select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>,
	title: string,
	options: string[],
	signal?: AbortSignal,
): Promise<string[] | undefined> {
	const selected = await select(title, options, { signal });
	return selected ? [selected] : undefined;
}
