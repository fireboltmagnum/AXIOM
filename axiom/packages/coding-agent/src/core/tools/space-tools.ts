/**
 * Space canvas tools.
 *
 * These let the REAL AXIOM agent operate the desktop "Space" whiteboard the
 * same way it operates the filesystem — as first-class LLM tools. Each tool
 * round-trips to the embedding desktop host via `ctx.ui.hostCall("space", …)`
 * (the RPC `host_call` channel), which performs the canvas mutation in the
 * Excalidraw surface and returns a JSON result.
 *
 * The tools are only useful when the agent runs under the desktop Space surface
 * (RPC mode with a host that answers `space` host-calls). They are injected as
 * `customTools` when `AXIOM_SPACE_TOOLS` is set, so the same agent binary keeps
 * its full toolset (SparseTreeGrep, DeepResearch, edit/bash, …) AND can draw.
 */

import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";

const HOST_CALL_TIMEOUT_MS = 30_000;

/** Shared result text helper. */
function ok(text: string): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Run a space host-call and return its JSON result as tool output. */
async function spaceCall(
	ui: {
		hostCall<T = unknown>(
			channel: string,
			op: string,
			payload?: unknown,
			opts?: { timeout?: number; signal?: AbortSignal },
		): Promise<T>;
	},
	op: string,
	payload: unknown,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	return ui.hostCall("space", op, payload, { timeout: HOST_CALL_TIMEOUT_MS, signal });
}

const DrawParams = Type.Object({
	shape: Type.Union(
		[
			Type.Literal("rectangle"),
			Type.Literal("ellipse"),
			Type.Literal("diamond"),
			Type.Literal("text"),
			Type.Literal("arrow"),
			Type.Literal("line"),
			Type.Literal("freedraw"),
			Type.Literal("frame"),
			Type.Literal("note"),
			Type.Literal("image"),
			Type.Literal("mermaid"),
			Type.Literal("node"),
		],
		{ description: "Kind of element to draw on the board." },
	),
	id: Type.Optional(Type.String({ description: "Optional stable id so later actions can reference this element." })),
	x: Type.Optional(Type.Number({ description: "Canvas x. Omit to place near the visible center." })),
	y: Type.Optional(Type.Number({ description: "Canvas y. Omit to place near the visible center." })),
	width: Type.Optional(Type.Number()),
	height: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String({ description: "Text content for text/note elements or labels." })),
	path: Type.Optional(Type.String({ description: "Absolute local image path when shape=image." })),
	name: Type.Optional(Type.String({ description: "Display name for an imported image." })),
	mermaid: Type.Optional(Type.String({ description: "Mermaid source when shape=mermaid." })),
	strokeColor: Type.Optional(Type.String({ description: "Hex stroke color, e.g. #1e1e1e." })),
	backgroundColor: Type.Optional(Type.String({ description: "Hex fill color." })),
	strokeWidth: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4)])),
	strokeStyle: Type.Optional(Type.Union([Type.Literal("solid"), Type.Literal("dashed"), Type.Literal("dotted")])),
	fillStyle: Type.Optional(
		Type.Union([Type.Literal("solid"), Type.Literal("hachure"), Type.Literal("cross-hatch"), Type.Literal("zigzag")]),
	),
	roughness: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)])),
	opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	fontSize: Type.Optional(Type.Number({ minimum: 8, maximum: 160 })),
	fontFamily: Type.Optional(
		Type.Union([Type.Literal("hand"), Type.Literal("sans"), Type.Literal("mono"), Type.Literal("assistant")]),
	),
	textAlign: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")])),
	verticalAlign: Type.Optional(Type.Union([Type.Literal("top"), Type.Literal("middle"), Type.Literal("bottom")])),
	roundness: Type.Optional(Type.Union([Type.Literal("sharp"), Type.Literal("round")])),
	link: Type.Optional(Type.String({ description: "Optional URL attached to the element." })),
	locked: Type.Optional(Type.Boolean()),
	startArrowhead: Type.Optional(
		Type.Union([
			Type.Literal("none"),
			Type.Literal("arrow"),
			Type.Literal("bar"),
			Type.Literal("dot"),
			Type.Literal("triangle"),
		]),
	),
	endArrowhead: Type.Optional(
		Type.Union([
			Type.Literal("none"),
			Type.Literal("arrow"),
			Type.Literal("bar"),
			Type.Literal("dot"),
			Type.Literal("triangle"),
		]),
	),
	// Each point is a [x, y] pair. We model it as a nested array (array of
	// number-arrays) rather than Type.Tuple: TypeBox tuples emit `items: [..]`
	// (an array), which Gemini's function-calling schema validator rejects
	// ("items must be a boolean or an object"). A nested Array emits
	// `items: { type: "array", items: { type: "number" } }`, which is valid
	// for every provider and still deserializes to [number, number] pairs.
	points: Type.Optional(
		Type.Array(Type.Array(Type.Number()), {
			minItems: 2,
			description: "Relative [x, y] points for line/arrow/freedraw, e.g. [[0,0],[100,50]].",
		}),
	),
});

const NodeParams = Type.Object({
	kind: Type.Union(
		[
			Type.Literal("thought"),
			Type.Literal("task"),
			Type.Literal("plan"),
			Type.Literal("research"),
			Type.Literal("browser"),
			Type.Literal("artifact"),
			Type.Literal("folder"),
		],
		{ description: "Semantic Space node type." },
	),
	id: Type.Optional(Type.String({ description: "Optional stable id so later actions can reference this node." })),
	name: Type.Optional(Type.String({ description: "Node title." })),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	width: Type.Optional(Type.Number()),
	height: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String({ description: "Primary text/body." })),
	content: Type.Optional(Type.String({ description: "Artifact/source content, e.g. inline HTML." })),
	url: Type.Optional(Type.String({ description: "Browser or external artifact URL." })),
	path: Type.Optional(Type.String({ description: "Absolute local folder path for folder nodes." })),
	caption: Type.Optional(Type.String({ description: "Short note rendered below the node." })),
	status: Type.Optional(Type.String()),
	progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	summary: Type.Optional(Type.String()),
	sources: Type.Optional(Type.Array(Type.String())),
	findings: Type.Optional(Type.Array(Type.String())),
	dependencies: Type.Optional(Type.Array(Type.String())),
	decisions: Type.Optional(Type.Array(Type.String())),
	evidence: Type.Optional(Type.Array(Type.String())),
});

const MoveParams = Type.Object({
	target: Type.String({ description: "Id of the element to move/resize." }),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	width: Type.Optional(Type.Number()),
	height: Type.Optional(Type.Number()),
	angle: Type.Optional(Type.Number({ description: "Rotation in degrees." })),
});

const ConnectParams = Type.Object({
	from: Type.String({ description: "Source element id." }),
	to: Type.String({ description: "Target element id." }),
	fromSide: Type.Optional(Type.String({ description: "right|left|top|bottom" })),
	toSide: Type.Optional(Type.String({ description: "right|left|top|bottom" })),
	label: Type.Optional(Type.String()),
});

const DeleteParams = Type.Object({
	target: Type.String({ description: "Id of the element to delete." }),
});

const StyleParams = Type.Object({
	target: Type.String({ description: "Id of the Excalidraw element to restyle." }),
	name: Type.Optional(Type.String({ description: "Replacement title for a semantic Space card." })),
	text: Type.Optional(Type.String({ description: "Replacement text for a text element or bound shape label." })),
	content: Type.Optional(Type.String({ description: "Replacement body/artifact content for a semantic Space card." })),
	caption: Type.Optional(Type.String({ description: "Replacement caption/note below a Space card." })),
	summary: Type.Optional(Type.String({ description: "Replacement summary for a semantic Space card." })),
	status: Type.Optional(Type.String({ description: "Status label for a semantic Space card." })),
	progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	strokeColor: Type.Optional(Type.String()),
	backgroundColor: Type.Optional(Type.String()),
	strokeWidth: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4)])),
	strokeStyle: Type.Optional(Type.Union([Type.Literal("solid"), Type.Literal("dashed"), Type.Literal("dotted")])),
	fillStyle: Type.Optional(
		Type.Union([Type.Literal("solid"), Type.Literal("hachure"), Type.Literal("cross-hatch"), Type.Literal("zigzag")]),
	),
	roughness: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)])),
	opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
	fontSize: Type.Optional(Type.Number({ minimum: 8, maximum: 160 })),
	fontFamily: Type.Optional(
		Type.Union([Type.Literal("hand"), Type.Literal("sans"), Type.Literal("mono"), Type.Literal("assistant")]),
	),
	textAlign: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")])),
	verticalAlign: Type.Optional(Type.Union([Type.Literal("top"), Type.Literal("middle"), Type.Literal("bottom")])),
	roundness: Type.Optional(Type.Union([Type.Literal("sharp"), Type.Literal("round")])),
	link: Type.Optional(Type.String()),
	locked: Type.Optional(Type.Boolean()),
});

const MermaidParams = Type.Object({
	definition: Type.String({ description: "Complete Mermaid diagram source." }),
	x: Type.Optional(Type.Number({ description: "Canvas x for the diagram's top-left." })),
	y: Type.Optional(Type.Number({ description: "Canvas y for the diagram's top-left." })),
});

const GroupParams = Type.Object({
	targets: Type.Array(Type.String(), { minItems: 2, description: "Element ids to place in one Excalidraw group." }),
});

const ReorderParams = Type.Object({
	target: Type.String({ description: "Element id to reorder." }),
	direction: Type.Union([
		Type.Literal("front"),
		Type.Literal("back"),
		Type.Literal("forward"),
		Type.Literal("backward"),
	]),
});

const DuplicateParams = Type.Object({
	target: Type.String({ description: "Element id to duplicate." }),
	offsetX: Type.Optional(Type.Number({ default: 36 })),
	offsetY: Type.Optional(Type.Number({ default: 36 })),
});

const SnapshotParams = Type.Object({
	includeImage: Type.Optional(
		Type.Boolean({ description: "If true, also returns a JPEG capture of the visible board (default true)." }),
	),
});

const ClusterParams = Type.Object({});

/**
 * Build the Space tool set. Each `execute` simply forwards to the desktop host
 * and reports the host's result back to the model.
 */
export function createSpaceTools(): ToolDefinition[] {
	const draw = defineTool({
		name: "space_draw",
		label: "Draw on Space",
		description:
			"Draw or import a native editable Excalidraw element on AXIOM Space. Supports rectangle, ellipse, diamond, text, arrow, line, freedraw, frame, note, local image, and Mermaid, with colors, stroke, fill, edges, roughness, opacity, fonts, alignment, arrowheads, links, locking, and point controls.",
		promptSnippet:
			"space_draw: draw, style, or import a native Excalidraw shape, text, note, image, line, frame, or Mermaid diagram",
		parameters: DrawParams,
		async execute(_id, params: Static<typeof DrawParams>, signal, _onUpdate, ctx) {
			const result = await spaceCall(ctx.ui, "draw", params, signal);
			return ok(
				`Drew ${params.shape}${(result as { id?: string })?.id ? ` (id: ${(result as { id: string }).id})` : ""}.`,
			);
		},
	});

	const move = defineTool({
		name: "space_move",
		label: "Move/resize on Space",
		description: "Move and/or resize an existing element on the Space whiteboard by id.",
		promptSnippet: "space_move: move or resize a Space element",
		parameters: MoveParams,
		async execute(_id, params: Static<typeof MoveParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "move", params, signal);
			return ok(`Updated ${params.target}.`);
		},
	});

	const connect = defineTool({
		name: "space_connect",
		label: "Connect on Space",
		description: "Draw a connector/arrow between two existing elements on the Space whiteboard.",
		promptSnippet: "space_connect: connect two Space elements with an arrow",
		parameters: ConnectParams,
		async execute(_id, params: Static<typeof ConnectParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "connect", params, signal);
			return ok(`Connected ${params.from} → ${params.to}.`);
		},
	});

	const remove = defineTool({
		name: "space_delete",
		label: "Delete on Space",
		description: "Delete an element from the Space whiteboard by id.",
		promptSnippet: "space_delete: remove a Space element",
		parameters: DeleteParams,
		async execute(_id, params: Static<typeof DeleteParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "delete", params, signal);
			return ok(`Deleted ${params.target}.`);
		},
	});

	const style = defineTool({
		name: "space_style",
		label: "Style Space element",
		description:
			"Change an existing native Excalidraw element's text, color, fill, edges, line style, opacity, roughness, font, alignment, link, or lock state.",
		promptSnippet: "space_style: restyle or edit text on a Space element",
		parameters: StyleParams,
		async execute(_id, params: Static<typeof StyleParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "style", params, signal);
			return ok(`Styled ${params.target}.`);
		},
	});

	const mermaid = defineTool({
		name: "space_mermaid",
		label: "Render Mermaid on Space",
		description:
			"Parse Mermaid source and add the diagram as normal editable Excalidraw shapes, text, and connectors rather than a flat image.",
		promptSnippet: "space_mermaid: turn Mermaid source into editable Excalidraw objects",
		parameters: MermaidParams,
		async execute(_id, params: Static<typeof MermaidParams>, signal, _onUpdate, ctx) {
			const result = (await spaceCall(ctx.ui, "mermaid", params, signal)) as { count?: number };
			return ok(`Rendered Mermaid diagram${result.count ? ` as ${result.count} editable elements` : ""}.`);
		},
	});

	const node = defineTool({
		name: "space_node",
		label: "Create Space node",
		description:
			"Create a semantic Space object: thought, task, plan, research, browser, artifact, or folder. Nodes carry summary, status, progress, sources, findings, decisions, evidence, dependencies, URL/path, and optional content, then appear as first-class resizable board cards.",
		promptSnippet:
			"space_node: create semantic Thought/Task/Plan/Research/Browser/Artifact/Folder nodes with evidence and metadata",
		parameters: NodeParams,
		async execute(_id, params: Static<typeof NodeParams>, signal, _onUpdate, ctx) {
			const result = (await spaceCall(ctx.ui, "node", params, signal)) as { id?: string };
			return ok(`Created ${params.kind} node${result.id ? ` (id: ${result.id})` : ""}.`);
		},
	});

	const group = defineTool({
		name: "space_group",
		label: "Group Space elements",
		description: "Group two or more native Excalidraw elements so they move and resize as one selection.",
		promptSnippet: "space_group: group Space elements",
		parameters: GroupParams,
		async execute(_id, params: Static<typeof GroupParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "group", params, signal);
			return ok(`Grouped ${params.targets.length} elements.`);
		},
	});

	const reorder = defineTool({
		name: "space_reorder",
		label: "Reorder Space element",
		description: "Move an Excalidraw element to front/back or one layer forward/backward.",
		promptSnippet: "space_reorder: change a Space element's layer order",
		parameters: ReorderParams,
		async execute(_id, params: Static<typeof ReorderParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "reorder", params, signal);
			return ok(`Moved ${params.target} ${params.direction}.`);
		},
	});

	const duplicate = defineTool({
		name: "space_duplicate",
		label: "Duplicate Space element",
		description: "Duplicate an existing native Excalidraw element with an optional x/y offset.",
		promptSnippet: "space_duplicate: duplicate a Space element",
		parameters: DuplicateParams,
		async execute(_id, params: Static<typeof DuplicateParams>, signal, _onUpdate, ctx) {
			const result = (await spaceCall(ctx.ui, "duplicate", params, signal)) as { id?: string };
			return ok(`Duplicated ${params.target}${result.id ? ` as ${result.id}` : ""}.`);
		},
	});

	const snapshot = defineTool({
		name: "space_snapshot",
		label: "Read Space board",
		description:
			"Read the current state of the Space whiteboard: all elements with ids, positions, text, and links, plus (optionally) a JPEG capture of the visible viewport. Call this before drawing so you can reference existing elements and avoid overlaps.",
		promptSnippet: "space_snapshot: read the current Space board (elements + optional image)",
		parameters: SnapshotParams,
		async execute(_id, params: Static<typeof SnapshotParams>, signal, _onUpdate, ctx) {
			const result = (await spaceCall(ctx.ui, "snapshot", params, signal)) as {
				objects?: unknown;
				links?: unknown;
				viewport?: unknown;
				image?: { mimeType: string; data: string };
			};
			const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
				{
					type: "text",
					text: JSON.stringify(
						{ objects: result?.objects ?? [], links: result?.links ?? [], viewport: result?.viewport ?? null },
						null,
						2,
					),
				},
			];
			if (result?.image?.data) {
				content.push({ type: "image", mimeType: result.image.mimeType, data: result.image.data });
			}
			return { content, details: undefined };
		},
	});

	const cluster = defineTool({
		name: "space_cluster",
		label: "Cluster Space nodes",
		description:
			"Automatically group existing Space cards into typed regions such as Research Area, Task Area, Browser Area, and Artifact Area.",
		promptSnippet: "space_cluster: organize Space cards into typed visual regions",
		parameters: ClusterParams,
		async execute(_id, _params: Static<typeof ClusterParams>, signal, _onUpdate, ctx) {
			await spaceCall(ctx.ui, "cluster", {}, signal);
			return ok("Clustered Space cards into typed regions.");
		},
	});

	return [snapshot, draw, node, style, mermaid, move, connect, group, reorder, duplicate, cluster, remove];
}
