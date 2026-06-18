import type { AgentTool } from "@axiom/agent-core";
import { type Static, Type } from "typebox";
import { GatherPhase, type GatherTarget, renderGatherPack } from "../../axiom/GatherPhase.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * `gather_context` — the synthesis-time half of the gather phase.
 *
 * AXIOM keeps retrieval lean (SparseTreeGrep returns summaries, the Evidence
 * Pack is a 500-token brief). That starves the final answer: the model writes
 * from a sketch. This tool lets the agent load the FULL current content of every
 * file its answer depends on, together, in one bounded block immediately before
 * synthesis — so completeness is paid for exactly where it matters, while
 * everything upstream stays frugal.
 *
 * Thin wrapper over the deterministic, budgeted {@link GatherPhase}; files are
 * prioritised in the order listed (first = most important under budget pressure).
 */

const gatherContextSchema = Type.Object({
	files: Type.Array(Type.String(), {
		description:
			"Files (cwd-relative or absolute) whose FULL content to load for the final answer. List the most important first.",
	}),
	maxBytes: Type.Optional(
		Type.Number({ description: "Total byte budget across all files. Default 200000 (~50k tokens)." }),
	),
	maxBytesPerFile: Type.Optional(
		Type.Number({ description: "Per-file byte cap before head/tail truncation. Default 60000." }),
	),
});

export type GatherContextToolInput = Static<typeof gatherContextSchema>;

export interface GatherContextToolDetails {
	fileCount: number;
	totalBytes: number;
	omitted: string[];
	missing: string[];
}

export function createGatherContextToolDefinition(
	cwd: string,
): ToolDefinition<typeof gatherContextSchema, GatherContextToolDetails> {
	const phase = new GatherPhase();
	return {
		name: "gather_context",
		label: "GatherContext",
		description:
			"Load the FULL content of the files your answer depends on, together, right before writing the final answer. Returns complete file bodies (bounded and prioritised) so you synthesize from full material instead of summaries or memory.",
		promptSnippet: "Load full content of every file the final answer depends on before synthesizing",
		promptGuidelines: [
			"Call gather_context immediately before writing your final answer or artifact, listing EVERY file the answer depends on (most important first).",
			"It returns the full, current content of those files in one block — write the complete answer from that material, not from earlier summaries, snippets, or memory.",
			"Prefer gather_context over re-reading files one-by-one when finalizing; it is bounded so it cannot overflow the context window, and it reports any files omitted for budget so you can read them explicitly if needed.",
		],
		parameters: gatherContextSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: GatherContextToolInput) {
			const targets: GatherTarget[] = params.files.map((file, index) => ({
				file,
				// Earlier-listed files are more important; they survive budget pressure.
				priority: params.files.length - index,
			}));
			const pack = phase.build(targets, {
				cwd,
				maxBytes: params.maxBytes,
				maxBytesPerFile: params.maxBytesPerFile,
			});
			const rendered = renderGatherPack(pack);
			const text =
				rendered ||
				`gather_context: none of the ${params.files.length} requested file(s) were readable${
					pack.missing.length ? ` (missing: ${pack.missing.join(", ")})` : ""
				}.`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					fileCount: pack.files.length,
					totalBytes: pack.totalBytes,
					omitted: pack.omitted,
					missing: pack.missing,
				},
			};
		},
	};
}

export function createGatherContextTool(cwd: string): AgentTool<typeof gatherContextSchema, GatherContextToolDetails> {
	return wrapToolDefinition(createGatherContextToolDefinition(cwd));
}
