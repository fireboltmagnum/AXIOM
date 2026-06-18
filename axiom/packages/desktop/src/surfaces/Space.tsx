import { convertToExcalidrawElements, Excalidraw, FONT_FAMILY, MainMenu, newElementWith } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import CodeMirror from "@uiw/react-codemirror";
import type {
	BinaryFileData,
	DataURL,
	ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types/types";
import type {
	ExcalidrawElement,
	ExcalidrawLinearElement,
	FileId,
} from "@excalidraw/excalidraw/types/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/types/data/transform";
import { useCallback, useEffect, useRef, useState } from "react";
import { AxiomMark } from "../shell/Logo.tsx";
import { loadSpaceBoard, saveSpaceBoard } from "../store.ts";
import { languageExtensions } from "./ide-lsp.ts";
import "./Space.css";

type CardKind =
	| "thought"
	| "task"
	| "plan"
	| "research"
	| "browser"
	| "artifact"
	| "folder"
	| "video"
	| "audio"
	| "pdf"
	| "html"
	| "code"
	| "model3d"
	| "hdrimg"
	| "file";
type Side = "top" | "right" | "bottom" | "left";
type ResizeCorner = "nw" | "ne" | "se" | "sw";
type AgentMode = "idle" | "thinking" | "acting";
type ActivityStatus = "running" | "done" | "error";

interface Card {
	id: string;
	name: string;
	ext: string;
	kind: CardKind;
	url?: string;
	text?: string;
	caption?: string;
	status?: string;
	progress?: number;
	path?: string;
	summary?: string;
	sources?: string[];
	findings?: string[];
	dependencies?: string[];
	decisions?: string[];
	evidence?: string[];
	children?: AxiomSpaceTreeNode[];
	strokeColor?: string;
	backgroundColor?: string;
	textColor?: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

interface AxiomSpaceTreeNode {
	name: string;
	path: string;
	dir: boolean;
	children?: AxiomSpaceTreeNode[];
}

interface IncomingSpaceHandoff {
	id: string;
	text: string;
}

interface View {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

interface Point {
	x: number;
	y: number;
}

interface Bounds extends Point {
	w: number;
	h: number;
}

interface LinkEndpoint {
	objectId: string;
	side: Side;
	t: number;
}

interface Link {
	id: string;
	from: LinkEndpoint;
	to: LinkEndpoint;
	c1: Point;
	c2: Point;
}

interface PendingLink {
	from: LinkEndpoint;
	pointer: Point;
}

interface AgentCursor {
	x: number;
	y: number;
	mode: AgentMode;
	durationMs: number;
}

interface ActivityItem {
	id: string;
	label: string;
	status: ActivityStatus;
}

interface BoardAction {
	type?: string;
	id?: string;
	target?: string;
	text?: string;
	caption?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	from?: string;
	to?: string;
	fromSide?: Side;
	toSide?: Side;
	strokeColor?: string;
	backgroundColor?: string;
	strokeWidth?: 1 | 2 | 4;
	strokeStyle?: "solid" | "dashed" | "dotted";
	fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag";
	roughness?: 0 | 1 | 2;
	opacity?: number;
	fontSize?: number;
	fontFamily?: "hand" | "sans" | "mono" | "assistant";
	textAlign?: "left" | "center" | "right";
	verticalAlign?: "top" | "middle" | "bottom";
	roundness?: "sharp" | "round";
	link?: string;
	locked?: boolean;
	path?: string;
	name?: string;
	angle?: number;
	startArrowhead?: "none" | "arrow" | "bar" | "dot" | "triangle";
	endArrowhead?: "none" | "arrow" | "bar" | "dot" | "triangle";
	points?: Array<[number, number]>;
	mermaid?: string;
	definition?: string;
	targets?: string[];
	direction?: "front" | "back" | "forward" | "backward";
	offsetX?: number;
	offsetY?: number;
	tool?: string;
	kind?: CardKind;
	status?: string;
	progress?: number;
	url?: string;
	summary?: string;
	sources?: string[];
	findings?: string[];
	dependencies?: string[];
	decisions?: string[];
	evidence?: string[];
	content?: string;
}

interface SpaceVisionFrame {
	mimeType: "image/jpeg";
	data: string;
	width: number;
	height: number;
}

// Browser-renderable images — go directly into Excalidraw as native image elements.
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"]);
// HDR / raw image formats — browsers can't display these; shown as a typed file card.
const HDRIMG = new Set(["exr", "hdr", "tif", "tiff", "tga", "dds"]);
const VIDEO = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "weba"]);
// 3-D geometry, scene, and CAD formats.
const MODEL3D = new Set([
	"obj", "mtl", "stl", "fbx", "glb", "gltf",
	"abc", "usd", "usdc", "usda", "usdz",
	"dae", "ply", "x3d", "wrl", "vrml",
	"dxf", "3ds", "blend", "ma", "mb",
	"chan",
]);
const CODE = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"py",
	"json",
	"md",
	"txt",
	"css",
	"scss",
	"c",
	"cpp",
	"h",
	"hpp",
	"java",
	"go",
	"rs",
	"rb",
	"php",
	"sh",
	"bash",
	"yml",
	"yaml",
	"toml",
	"xml",
	"sql",
	"kt",
	"swift",
]);
const SIDES: Side[] = ["top", "right", "bottom", "left"];
const SPACE_VISION_MAX_WIDTH = 1280;
const SPACE_VISION_QUALITY = 0.74;
const SPACE_AGENT_IDLE_TIMEOUT_MS = 90_000;
const SPACE_GRID_SIZE = 28;
const SPACE_INTERNAL_PROMPT_TAG = "axiom_space_canvas_request";

let sequence = 0;
function uid(prefix = "space"): string {
	sequence += 1;
	return `${prefix}_${Date.now().toString(36)}_${sequence}`;
}

export async function convertMermaidToSpaceElements(
	definition: string,
	position: Point,
): Promise<{ elements: readonly ExcalidrawElement[]; files: BinaryFileData[] }> {
	const parsed = await parseMermaidToExcalidraw(definition, {
		startOnLoad: false,
		flowchart: { curve: "basis" },
		themeVariables: { fontSize: "20px" },
		maxEdges: 500,
		maxTextSize: 50_000,
	});
	const records = parsed.elements as unknown as Array<Record<string, unknown>>;
	const xs = records.flatMap((element) =>
		[element.x, element.startX, element.endX].filter((value): value is number => typeof value === "number"),
	);
	const ys = records.flatMap((element) =>
		[element.y, element.startY, element.endY].filter((value): value is number => typeof value === "number"),
	);
	const minX = xs.length ? Math.min(...xs) : 0;
	const minY = ys.length ? Math.min(...ys) : 0;
	const dx = position.x - minX;
	const dy = position.y - minY;
	const translated = records.map((element) => {
		const next = { ...element };
		for (const key of ["x", "startX", "endX"]) {
			if (typeof next[key] === "number") next[key] = (next[key] as number) + dx;
		}
		for (const key of ["y", "startY", "endY"]) {
			if (typeof next[key] === "number") next[key] = (next[key] as number) + dy;
		}
		return next;
	}) as unknown as ExcalidrawElementSkeleton[];
	return {
		elements: convertToExcalidrawElements(translated, { regenerateIds: true }),
		files: parsed.files ? (Object.values(parsed.files) as BinaryFileData[]) : [],
	};
}

function kindOf(ext: string): CardKind {
	if (VIDEO.has(ext)) return "video";
	if (AUDIO.has(ext)) return "audio";
	if (MODEL3D.has(ext)) return "model3d";
	if (HDRIMG.has(ext)) return "hdrimg";
	if (ext === "pdf") return "pdf";
	if (ext === "html" || ext === "htm") return "html";
	if (CODE.has(ext)) return "code";
	return "file";
}

function kindLabel(kind: CardKind, ext: string): string {
	switch (kind) {
		case "thought": return "THOUGHT";
		case "task": return "TASK";
		case "plan": return "PLAN";
		case "research": return "RESEARCH";
		case "browser": return "BROWSER";
		case "artifact": return "ARTIFACT";
		case "folder": return "FOLDER";
		default: return ext.toUpperCase() || "FILE";
	}
}

function spaceAgentPrompt(request: string): string {
	return [
		`<${SPACE_INTERNAL_PROMPT_TAG}>`,
		"User request from the Space canvas. Inspect and update the Space board using the space_* tools — do not produce a chat-facing answer.",
		"",
		"FIRST, read the 'space-drawing' skill and follow it. The core rule: you have no spatial reasoning, so NEVER hand-place a diagram by coordinate (that makes a useless wall of overlapping boxes). For anything with nodes and relationships (flowchart, architecture, sequence, mindmap, class, ER, state, timeline, hierarchy), write tight Mermaid and call space_mermaid — the engine lays it out. Use space_node + space_cluster for tasks/plans/research/decisions. Use a SMALL deliberate set of space_draw shapes only for a literal freeform picture.",
		"Call space_snapshot before editing an existing board, edit by id, keep related work in labeled frames, and avoid overlaps.",
		"",
		"Request:",
		request,
		`</${SPACE_INTERNAL_PROMPT_TAG}>`,
	].join("\n");
}

function artifactUrl(card: Card): string | undefined {
	if (card.url) return card.url;
	if (!card.text) return undefined;
	if (card.ext === "html" || card.ext === "htm" || card.kind === "artifact") {
		return `data:text/html;charset=utf-8,${encodeURIComponent(card.text)}`;
	}
	return undefined;
}

function metadataList(values: string[] | undefined): string[] {
	return (values ?? []).map((value) => value.trim()).filter(Boolean).slice(0, 8);
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth || 320, height: image.naturalHeight || 240 });
		image.onerror = () => reject(new Error("Could not decode image"));
		image.src = dataUrl;
	});
}

function fitSize(width: number, height: number, maxWidth = 620, maxHeight = 460): { width: number; height: number } {
	const scale = Math.min(1, maxWidth / width, maxHeight / height);
	return { width: Math.max(40, Math.round(width * scale)), height: Math.max(40, Math.round(height * scale)) };
}

function drawWrappedText(
	context: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	maxWidth: number,
	lineHeight: number,
	maxLines: number,
): void {
	const words = text.replace(/\s+/g, " ").trim().split(" ");
	let line = "";
	let lineIndex = 0;
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (context.measureText(candidate).width <= maxWidth) {
			line = candidate;
			continue;
		}
		if (line) {
			context.fillText(line, x, y + lineIndex * lineHeight);
			lineIndex += 1;
			if (lineIndex >= maxLines) return;
		}
		line = word;
	}
	if (line && lineIndex < maxLines) context.fillText(line, x, y + lineIndex * lineHeight);
}

function captureSpaceVision(
	node: HTMLElement,
	cards: readonly Card[],
	elements: readonly ExcalidrawElement[],
	links: readonly Link[],
	view: View,
): SpaceVisionFrame {
	const sourceWidth = Math.max(1, node.clientWidth);
	const sourceHeight = Math.max(1, node.clientHeight);
	const scale = Math.min(1, SPACE_VISION_MAX_WIDTH / sourceWidth);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(sourceWidth * scale));
	canvas.height = Math.max(1, Math.round(sourceHeight * scale));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas capture context is unavailable.");
	context.scale(scale, scale);
	context.fillStyle = "#f7f8fb";
	context.fillRect(0, 0, sourceWidth, sourceHeight);

	const rootRect = node.getBoundingClientRect();
	for (const sourceCanvas of node.querySelectorAll("canvas")) {
		const rect = sourceCanvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		try {
			context.drawImage(
				sourceCanvas,
				rect.left - rootRect.left,
				rect.top - rootRect.top,
				rect.width,
				rect.height,
			);
		} catch {
			// A tainted media preview must not prevent the rest of the board capture.
		}
	}

	const bounds = new Map<string, Bounds>();
	for (const card of cards) bounds.set(card.id, { x: card.x, y: card.y, w: card.w, h: card.h });
	for (const element of elements) {
		if (!element.isDeleted) {
			bounds.set(element.id, { x: element.x, y: element.y, w: element.width, h: element.height });
		}
	}
	const toPixel = (point: Point): Point => ({
		x: (point.x + view.scrollX) * view.zoom,
		y: (point.y + view.scrollY) * view.zoom,
	});

	context.strokeStyle = "#697386";
	context.lineWidth = 2;
	for (const link of links) {
		const fromBounds = bounds.get(link.from.objectId);
		const toBounds = bounds.get(link.to.objectId);
		if (!fromBounds || !toBounds) continue;
		const fromScene = endpointFor(fromBounds, link.from.side, link.from.t);
		const toScene = endpointFor(toBounds, link.to.side, link.to.t);
		const from = toPixel(fromScene);
		const to = toPixel(toScene);
		context.beginPath();
		context.moveTo(from.x, from.y);
		context.bezierCurveTo(
			from.x + link.c1.x * view.zoom,
			from.y + link.c1.y * view.zoom,
			to.x + link.c2.x * view.zoom,
			to.y + link.c2.y * view.zoom,
			to.x,
			to.y,
		);
		context.stroke();
	}

	for (const card of cards) {
		const position = toPixel(card);
		const width = card.w * view.zoom;
		const height = card.h * view.zoom;
		if (
			position.x > sourceWidth ||
			position.y > sourceHeight ||
			position.x + width < 0 ||
			position.y + height < 0
		) {
			continue;
		}
		context.fillStyle = "#ffffff";
		context.strokeStyle = "#cbd1dc";
		context.lineWidth = 1.5;
		context.beginPath();
		context.roundRect(position.x, position.y, width, height, Math.min(8, 8 * view.zoom));
		context.fill();
		context.stroke();
		const headerHeight = Math.min(height, 34 * view.zoom);
		context.fillStyle = "#f0f2f6";
		context.fillRect(position.x, position.y, width, headerHeight);
		context.fillStyle = "#20242c";
		context.font = `${Math.max(10, 12 * view.zoom)}px system-ui`;
		context.fillText(card.name.slice(0, 42), position.x + 10 * view.zoom, position.y + 21 * view.zoom);
		context.fillStyle = "#4b5565";
		context.font = `${Math.max(9, 11 * view.zoom)}px ui-monospace, monospace`;
		const body = card.text?.slice(0, 700) || `${card.kind.toUpperCase()} preview`;
		drawWrappedText(
			context,
			body,
			position.x + 10 * view.zoom,
			position.y + headerHeight + 20 * view.zoom,
			Math.max(20, width - 20 * view.zoom),
			Math.max(12, 16 * view.zoom),
			Math.max(1, Math.floor((height - headerHeight - 20 * view.zoom) / Math.max(12, 16 * view.zoom))),
		);
		if (card.caption) {
			context.fillStyle = "#313743";
			context.font = `${Math.max(9, 11 * view.zoom)}px system-ui`;
			context.fillText(card.caption.slice(0, 80), position.x + 8 * view.zoom, position.y + height + 16 * view.zoom);
		}
	}

	const dataUrl = canvas.toDataURL("image/jpeg", SPACE_VISION_QUALITY);
	const separator = dataUrl.indexOf(",");
	if (separator < 0) throw new Error("Canvas capture produced an invalid image.");
	return {
		mimeType: "image/jpeg",
		data: dataUrl.slice(separator + 1),
		width: canvas.width,
		height: canvas.height,
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function endpointFor(bounds: Bounds, side: Side, t: number): Point {
	const amount = clamp(t, 0, 1);
	switch (side) {
		case "top":
			return { x: bounds.x + bounds.w * amount, y: bounds.y };
		case "right":
			return { x: bounds.x + bounds.w, y: bounds.y + bounds.h * amount };
		case "bottom":
			return { x: bounds.x + bounds.w * amount, y: bounds.y + bounds.h };
		case "left":
			return { x: bounds.x, y: bounds.y + bounds.h * amount };
	}
}

function nearestEndpoint(bounds: Bounds, point: Point, objectId: string): LinkEndpoint {
	const options: Array<{ side: Side; distance: number; t: number }> = [
		{ side: "top", distance: Math.abs(point.y - bounds.y), t: (point.x - bounds.x) / bounds.w },
		{ side: "right", distance: Math.abs(point.x - (bounds.x + bounds.w)), t: (point.y - bounds.y) / bounds.h },
		{ side: "bottom", distance: Math.abs(point.y - (bounds.y + bounds.h)), t: (point.x - bounds.x) / bounds.w },
		{ side: "left", distance: Math.abs(point.x - bounds.x), t: (point.y - bounds.y) / bounds.h },
	];
	options.sort((a, b) => a.distance - b.distance);
	return { objectId, side: options[0].side, t: clamp(options[0].t, 0, 1) };
}

function defaultCurve(from: Point, to: Point): { c1: Point; c2: Point } {
	const dx = Math.max(70, Math.abs(to.x - from.x) * 0.42);
	return {
		c1: { x: dx, y: 0 },
		c2: { x: -dx, y: 0 },
	};
}

function curvePath(from: Point, c1: Point, c2: Point, to: Point): string {
	return `M ${from.x} ${from.y} C ${from.x + c1.x} ${from.y + c1.y}, ${to.x + c2.x} ${to.y + c2.y}, ${to.x} ${to.y}`;
}

function CodeCardPreview({ card, expanded = false }: { card: Card; expanded?: boolean }) {
	const code = card.text ?? "Loading...";
	if (!expanded) {
		const lines = code.split(/\r?\n/);
		return (
			<div className="cp-code-compact">
				<div className="cp-code-meta">
					<span>{card.ext.toUpperCase() || "CODE"}</span>
					<span>{lines.length} lines</span>
				</div>
				<pre className="cp-code">{code}</pre>
			</div>
		);
	}
	return (
		<CodeMirror
			value={code}
			extensions={languageExtensions(card.name || card.path || card.ext)}
			editable={false}
			basicSetup={{
				foldGutter: true,
				lineNumbers: true,
				highlightActiveLine: false,
				highlightActiveLineGutter: false,
			}}
			theme="dark"
			className="cp-code-editor"
		/>
	);
}

function CardPreview({ card, expanded = false }: { card: Card; expanded?: boolean }) {
	switch (card.kind) {
		case "thought":
		case "plan":
		case "research":
		case "task":
			return (
				<div className={`cp-space-node cp-${card.kind}`}>
					<div className="cp-node-title">{card.name}</div>
					{card.summary && <p>{card.summary}</p>}
					{card.status && <span className="cp-node-status">{card.status}</span>}
					{typeof card.progress === "number" && (
						<div className="cp-progress" aria-label={`Progress ${card.progress}%`}>
							<span style={{ width: `${clamp(card.progress, 0, 100)}%` }} />
						</div>
					)}
					{metadataList(card.findings).length > 0 && (
						<ul>
							{metadataList(card.findings).slice(0, 3).map((item) => <li key={item}>{item}</li>)}
						</ul>
					)}
				</div>
			);
		case "browser":
			return card.url ? (
				<iframe src={card.url} className="cp-frame cp-browser" title={card.name} sandbox="allow-scripts allow-forms allow-popups" />
			) : (
				<div className="cp-file"><div className="cp-file-ext">URL</div><div className="cp-file-note">Add a URL</div></div>
			);
		case "artifact": {
			const src = artifactUrl(card);
			return src ? <iframe src={src} className="cp-frame" title={card.name} sandbox="allow-scripts" /> : <CodeCardPreview card={card} expanded={expanded} />;
		}
		case "folder":
			return (
				<div className="cp-folder">
					<div className="cp-folder-path">{card.path ?? card.name}</div>
					<div className="cp-folder-list">
						{(card.children ?? []).slice(0, 12).map((child) => (
							<div key={child.path} className="cp-folder-row">
								<span>{child.dir ? "▸" : "·"}</span>
								<b>{child.name}</b>
							</div>
						))}
						{(card.children?.length ?? 0) === 0 && <div className="cp-folder-empty">Folder contents will appear here.</div>}
					</div>
				</div>
			);
		case "video":
			return <video src={card.url} className="cp-media" controls />;
		case "audio":
			return (
				<div className="cp-audio">
					<div className="cp-audio-glyph">♪</div>
					<audio src={card.url} controls />
				</div>
			);
		case "pdf":
			return <iframe src={card.url} className="cp-frame" title={card.name} />;
		case "html":
			return <iframe src={artifactUrl(card)} className="cp-frame" title={card.name} sandbox="allow-scripts" />;
		case "code":
			return <CodeCardPreview card={card} expanded={expanded} />;
		case "model3d":
			return (
				<div className="cp-3d">
					<div className="cp-3d-icon">⬡</div>
					<div className="cp-3d-ext">{card.ext.toUpperCase()}</div>
					<div className="cp-3d-name">{card.name}</div>
				</div>
			);
		case "hdrimg":
			return (
				<div className="cp-hdrimg">
					<div className="cp-hdrimg-icon">◈</div>
					<div className="cp-hdrimg-ext">{card.ext.toUpperCase()}</div>
					<div className="cp-hdrimg-name">{card.name}</div>
				</div>
			);
		default:
			return (
				<div className="cp-file">
					<div className="cp-file-ext">{card.ext.toUpperCase() || "FILE"}</div>
					<div className="cp-file-note">Preview unavailable</div>
				</div>
			);
	}
}

export function Space({
	sessionKey = "default",
	incomingHandoff,
	onTransfer,
}: {
	sessionKey?: string;
	incomingHandoff?: IncomingSpaceHandoff;
	// Hand the board off to Chat: the shell switches to the Chat tab and sends this
	// prompt (+ fit-to-all image) to the shared agent so the coding model continues.
	onTransfer?: (handoff: { text: string; image?: { mimeType: string; data: string } }) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	const objectUrls = useRef(new Set<string>());
	const agentWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hydratedRef = useRef(false);
	const [view, setView] = useState<View>({ scrollX: 0, scrollY: 0, zoom: 1 });
	const [cards, setCards] = useState<Card[]>([]);
	const [sceneElements, setSceneElements] = useState<readonly ExcalidrawElement[]>([]);
	const [links, setLinks] = useState<Link[]>([]);
	const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
	const [fullscreenCard, setFullscreenCard] = useState<Card | null>(null);
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
	const [linkMode, setLinkMode] = useState(false);
	const [agentInput, setAgentInput] = useState("");
	const [agentBusy, setAgentBusy] = useState(false);
	const [agentOrbOpen, setAgentOrbOpen] = useState(false);
	const [agentMessage, setAgentMessage] = useState("I’m here on the board. Ask me to draw, arrange, connect, or explain.");
	const [agentActivity, setAgentActivity] = useState<ActivityItem[]>([]);
	const [spaceModel, setSpaceModel] = useState("Space model");
	const [transferring, setTransferring] = useState(false);
	const [agentCursor, setAgentCursor] = useState<AgentCursor>({
		x: 520,
		y: 280,
		mode: "idle",
		durationMs: 900,
	});

	const viewRef = useRef(view);
	viewRef.current = view;
	const cardsRef = useRef(cards);
	cardsRef.current = cards;
	const elementsRef = useRef(sceneElements);
	elementsRef.current = sceneElements;
	const linksRef = useRef(links);
	linksRef.current = links;
	const agentBusyRef = useRef(agentBusy);
	agentBusyRef.current = agentBusy;
	// Agent-first drawing: we run the real agent (full brain + space_* tools), but
	// if it finishes without ever touching the board (flaky free tier, no tool call,
	// or a wedge), we fall back to the reliable direct-draw path so Space never just
	// sits there empty. These refs track that across the async agent event stream.
	const spaceToolRanRef = useRef(false);
	const pendingPromptRef = useRef<string | null>(null);
	const consumedHandoffIdRef = useRef<string | null>(null);
	const fallbackRanRef = useRef(false);
	// Lets the watchdog (a useCallback defined before directDraw) reach the fallback
	// without a stale closure or use-before-declaration.
	const maybeFallbackDrawRef = useRef<(() => Promise<void>) | null>(null);

	useEffect(() => {
		hydratedRef.current = false;
		const saved = loadSpaceBoard(sessionKey);
		const nextView = saved?.view ?? { scrollX: 0, scrollY: 0, zoom: 1 };
		const nextCards = (saved?.cards ?? []) as Card[];
		const nextLinks = (saved?.links ?? []) as Link[];
		const nextElements = (saved?.elements ?? []) as readonly ExcalidrawElement[];
		setView(nextView);
		setCards(nextCards);
		setLinks(nextLinks);
		setSceneElements(nextElements);
		setSelectedCardId(null);
		setSelectedLinkId(null);
		setFullscreenCard(null);
		apiRef.current?.updateScene({
			elements: nextElements,
			appState: {
				scrollX: nextView.scrollX,
				scrollY: nextView.scrollY,
				zoom: { value: nextView.zoom as never },
				gridSize: SPACE_GRID_SIZE,
				viewBackgroundColor: "#fbfbfa",
			},
		});
		hydratedRef.current = true;
	}, [sessionKey]);

	useEffect(() => {
		if (!hydratedRef.current) return;
		const timer = window.setTimeout(() => {
			saveSpaceBoard(sessionKey, {
				cards,
				elements: sceneElements.filter((element) => !element.isDeleted),
				links,
				view,
			});
		}, 250);
		return () => window.clearTimeout(timer);
	}, [cards, links, sceneElements, sessionKey, view]);

	const clearAgentWatchdog = useCallback(() => {
		if (agentWatchdogRef.current) {
			clearTimeout(agentWatchdogRef.current);
			agentWatchdogRef.current = null;
		}
	}, []);

	const armAgentWatchdog = useCallback(() => {
		clearAgentWatchdog();
		agentWatchdogRef.current = setTimeout(() => {
			if (!agentBusyRef.current) return;
			agentWatchdogRef.current = null;
			// The agent wedged (common on the free tier). Kill it. If it never drew
			// and we still have the request, draw directly instead of leaving Space
			// empty; maybeFallbackDrawRef is set once directDraw is defined.
			void window.axiom?.agent?.abort();
			setAgentActivity((current) =>
				current.map((item) => (item.status === "running" ? { ...item, status: "error" } : item)),
			);
			if (pendingPromptRef.current && !spaceToolRanRef.current && !fallbackRanRef.current) {
				setAgentMessage("Agent stalled; drawing directly…");
				void maybeFallbackDrawRef.current?.();
			} else {
				setAgentBusy(false);
				setAgentMessage("Stopped because the agent produced no progress for 90 seconds.");
				setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 520 }));
			}
		}, SPACE_AGENT_IDLE_TIMEOUT_MS);
	}, [clearAgentWatchdog]);

	useEffect(() => {
		void window.axiom?.config().then((cfg) => setSpaceModel(cfg.spaceModel)).catch(() => {});
	}, []);

	useEffect(() => {
		const root = containerRef.current;
		if (!root) return;
		const normalizeExcalidrawControls = () => {
			const menu = root.querySelector<HTMLButtonElement>(".main-menu-trigger");
			if (menu && !menu.getAttribute("aria-label")) menu.setAttribute("aria-label", "Open canvas menu");
			const tools = root.querySelectorAll<HTMLInputElement>(".ToolIcon_type_radio[data-testid]");
			tools.forEach((tool, index) => {
				const stableId = `axiom-space-${tool.dataset.testid ?? index}`;
				if (tool.id !== stableId) tool.id = stableId;
			});
			root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
				if (input.getAttribute("aria-label")) return;
				const label = input.closest("label")?.textContent?.trim();
				if (label) input.setAttribute("aria-label", label);
			});
			const seenIds = new Set<string>();
			root.querySelectorAll<SVGElement>("svg [id]").forEach((node, index) => {
				const originalId = node.id;
				if (!originalId || !seenIds.has(originalId)) {
					if (originalId) seenIds.add(originalId);
					return;
				}
				const stableId = `axiom-space-svg-${originalId}-${index}`;
				const svg = node.closest("svg");
				svg?.querySelectorAll(`[clip-path="url(#${originalId})"]`).forEach((reference) => {
					reference.setAttribute("clip-path", `url(#${stableId})`);
				});
				node.id = stableId;
				seenIds.add(stableId);
			});
		};
		const frame = window.requestAnimationFrame(normalizeExcalidrawControls);
		const observer = new MutationObserver(normalizeExcalidrawControls);
		observer.observe(root, { childList: true, subtree: true });
		return () => {
			window.cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, []);

	useEffect(
		() => () => {
			clearAgentWatchdog();
			for (const url of objectUrls.current) URL.revokeObjectURL(url);
			objectUrls.current.clear();
		},
		[clearAgentWatchdog],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.ctrlKey || event.metaKey || event.altKey) setLinkMode(true);
			if ((event.key === "Backspace" || event.key === "Delete") && selectedLinkId) {
				setLinks((current) => current.filter((link) => link.id !== selectedLinkId));
				setSelectedLinkId(null);
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			setLinkMode(event.ctrlKey || event.metaKey || event.altKey);
		};
		const onBlur = () => setLinkMode(false);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
		};
	}, [selectedLinkId]);

	useEffect(() => {
		if (agentBusyRef.current) return;
		const width = containerRef.current?.clientWidth ?? 1000;
		const height = containerRef.current?.clientHeight ?? 700;
		const localX = (agentCursor.x + view.scrollX) * view.zoom;
		const localY = (agentCursor.y + view.scrollY) * view.zoom;
		if (localX >= 42 && localX <= width - 150 && localY >= 72 && localY <= height - 150) return;
		setAgentCursor({
			x: -view.scrollX + width / view.zoom * 0.7,
			y: -view.scrollY + height / view.zoom * 0.34,
			mode: "idle",
			durationMs: 520,
		});
	}, [agentCursor.x, agentCursor.y, view]);

	const toLocal = useCallback(
		(x: number, y: number, currentView: View = viewRef.current): Point => ({
			x: (x + currentView.scrollX) * currentView.zoom,
			y: (y + currentView.scrollY) * currentView.zoom,
		}),
		[],
	);

	const clientToScene = useCallback((clientX: number, clientY: number): Point => {
		const rect = containerRef.current?.getBoundingClientRect();
		const currentView = viewRef.current;
		return {
			x: (clientX - (rect?.left ?? 0)) / currentView.zoom - currentView.scrollX,
			y: (clientY - (rect?.top ?? 0)) / currentView.zoom - currentView.scrollY,
		};
	}, []);

	const objectBounds = useCallback((objectId: string): Bounds | null => {
		const card = cardsRef.current.find((candidate) => candidate.id === objectId);
		if (card) return { x: card.x, y: card.y, w: card.w, h: card.h };
		const element = elementsRef.current.find((candidate) => candidate.id === objectId && !candidate.isDeleted);
		if (!element) return null;
		return {
			x: element.x,
			y: element.y,
			w: Math.max(1, element.width),
			h: Math.max(1, element.height),
		};
	}, []);

	const objectAt = useCallback(
		(point: Point, excludeId?: string): string | null => {
			const hitPadding = 36;
			const cardsUnderPoint = [...cardsRef.current].reverse().find((card) => {
				return (
					card.id !== excludeId &&
					point.x >= card.x - hitPadding &&
					point.x <= card.x + card.w + hitPadding &&
					point.y >= card.y - hitPadding &&
					point.y <= card.y + card.h + hitPadding
				);
			});
			if (cardsUnderPoint) return cardsUnderPoint.id;
			const element = [...elementsRef.current].reverse().find((candidate) => {
				return (
					!candidate.isDeleted &&
					candidate.id !== excludeId &&
					point.x >= candidate.x - hitPadding &&
					point.x <= candidate.x + candidate.width + hitPadding &&
					point.y >= candidate.y - hitPadding &&
					point.y <= candidate.y + candidate.height + hitPadding
				);
			});
			return element?.id ?? null;
		},
		[],
	);

	// Use Tauri's native drag-drop events (file paths) instead of browser File objects,
	// which are empty on macOS WKWebView when dropped from Finder.
	useEffect(() => {
		return window.axiom?.space?.onFileDrop(({ paths, position }) => {
			const origin = clientToScene(position.x, position.y);
			paths.forEach((filePath, index) => {
				const name = filePath.split("/").pop() ?? filePath;
				const ext = (name.split(".").pop() ?? "").toLowerCase();
				const x = origin.x + (index % 3) * 290;
				const y = origin.y + Math.floor(index / 3) * 230;
				if (IMAGE.has(ext) && !HDRIMG.has(ext)) {
					void addNativeImageFromPath(filePath, name, x, y);
				} else {
					void addCardFromPath(filePath, name, ext, x, y);
				}
			});
		});
	}, [clientToScene]);

	// Path-based versions used by the Tauri native drop handler.
	async function addNativeImageFromPath(filePath: string, name: string, x: number, y: number): Promise<string | null> {
		const api = apiRef.current;
		if (!api) return null;
		try {
			const base64 = await window.axiom.space.readFileBase64(filePath);
			const ext = (name.split(".").pop() ?? "png").toLowerCase();
			const mimeType =
				ext === "jpg" || ext === "jpeg" ? "image/jpeg"
					: ext === "gif" ? "image/gif"
						: ext === "webp" ? "image/webp"
							: ext === "svg" ? "image/svg+xml"
								: ext === "avif" ? "image/avif"
									: ext === "bmp" ? "image/bmp"
										: "image/png";
			const dataURL = `data:${mimeType};base64,${base64}` as DataURL;
			const decoded = await imageDimensions(dataURL);
			const dimensions = fitSize(decoded.width, decoded.height);
			const id = `img-${base64.slice(0, 16)}` as FileId;
			const binary: BinaryFileData = { id, dataURL, mimeType: mimeType as BinaryFileData["mimeType"], created: Date.now() };
			api.addFiles([binary]);
			const [element] = convertToExcalidrawElements([{ type: "image", x, y, width: dimensions.width, height: dimensions.height, fileId: id, status: "saved" }], { regenerateIds: false });
			api.updateScene({ elements: [...api.getSceneElements(), element], appState: { selectedElementIds: { [element.id]: true } } });
			return element.id;
		} catch (error) {
			setAgentMessage(`Could not place ${name}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	async function addCardFromPath(filePath: string, name: string, ext: string, x: number, y: number): Promise<void> {
		const kind = kindOf(ext);
		const card: Card = {
			id: uid("card"),
			name,
			ext,
			kind,
			path: filePath,
			x,
			y,
			w: kind === "pdf" || kind === "html" ? 320 : kind === "model3d" ? 200 : 260,
			h: kind === "pdf" || kind === "html" ? 230 : kind === "model3d" ? 180 : 190,
		};
		if (kind === "code") {
			try {
				const text = await window.axiom.space.readFileText(filePath);
				card.text = text.slice(0, 12_000);
			} catch { card.text = `// Could not read ${name}`; }
		} else if (kind !== "file" && kind !== "hdrimg" && kind !== "model3d") {
			// Use Tauri asset protocol — serves local files directly to the webview.
			card.url = window.axiom.space.filePathToUrl(filePath);
		}
		setCards((current) => [...current, card]);
		setSelectedCardId(card.id);
	}

	async function createStructuredNode(action: BoardAction, center: Point): Promise<string> {
		const kind = action.kind ?? "thought";
		const width = Math.max(180, action.width ?? (kind === "browser" || kind === "artifact" || kind === "folder" ? 420 : 300));
		const height = Math.max(120, action.height ?? (kind === "browser" || kind === "artifact" || kind === "folder" ? 280 : 190));
		const card: Card = {
			id: action.id || uid(kind),
			name: action.name || action.text?.split("\n")[0]?.slice(0, 80) || kindLabel(kind, ""),
			ext: kind === "browser" ? "url" : kind === "folder" ? "dir" : kind,
			kind,
			x: action.x ?? center.x,
			y: action.y ?? center.y,
			w: width,
			h: height,
			url: action.url,
			path: action.path,
			text: action.content ?? action.text,
			caption: action.caption,
			status: action.status,
			progress: action.progress,
			summary: action.summary ?? action.text,
			sources: metadataList(action.sources),
			findings: metadataList(action.findings),
			dependencies: metadataList(action.dependencies),
			decisions: metadataList(action.decisions),
			evidence: metadataList(action.evidence),
			strokeColor: action.strokeColor,
			backgroundColor: action.backgroundColor,
			textColor: action.strokeColor,
		};
		if (kind === "folder" && action.path) {
			try {
				const folder = await window.axiom.ide.openPath(action.path);
				if (folder) {
					card.name = action.name || folder.name;
					card.path = folder.root;
					card.children = folder.tree;
				}
			} catch (error) {
				card.summary = `Could not read folder: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		setCards((current) => [...current, card]);
		setSelectedCardId(card.id);
		return card.id;
	}

	function visibleCenter(): Point {
		const currentView = viewRef.current;
		const width = containerRef.current?.clientWidth ?? 1000;
		const height = containerRef.current?.clientHeight ?? 700;
		return {
			x: -currentView.scrollX + width / currentView.zoom / 2,
			y: -currentView.scrollY + height / currentView.zoom / 2,
		};
	}

	function openCardPosition(width: number, height: number): Point {
		const center = visibleCenter();
		const origin = { x: center.x - width / 2, y: center.y - height / 2 - 40 };
		const gap = 24;
		const stepX = width + gap;
		const stepY = height + gap;
		const offsets: Point[] = [{ x: 0, y: 0 }];
		for (let ring = 1; ring <= 4; ring += 1) {
			for (let x = -ring; x <= ring; x += 1) {
				offsets.push({ x: x * stepX, y: -ring * stepY });
				offsets.push({ x: x * stepX, y: ring * stepY });
			}
			for (let y = -ring + 1; y < ring; y += 1) {
				offsets.push({ x: -ring * stepX, y: y * stepY });
				offsets.push({ x: ring * stepX, y: y * stepY });
			}
		}
		const padding = 14;
		for (const offset of offsets) {
			const candidate = { x: origin.x + offset.x, y: origin.y + offset.y };
			const overlaps = cardsRef.current.some(
				(card) =>
					candidate.x < card.x + card.w + padding &&
					candidate.x + width + padding > card.x &&
					candidate.y < card.y + card.h + padding &&
					candidate.y + height + padding > card.y,
			);
			if (!overlaps) return candidate;
		}
		return origin;
	}

	function createNoteAtCenter(): void {
		const position = openCardPosition(280, 160);
		addCanvasElement({
			type: "note",
			text: "Double-click to write",
			x: position.x,
			y: position.y,
			width: 280,
			height: 160,
			strokeColor: "#c9bf83",
			backgroundColor: "#fff9dc",
			fontFamily: "sans",
			fontSize: 17,
		}, position);
	}

	function tidyBoard(): void {
		const center = visibleCenter();
		const allCards = cardsRef.current;
		const allElements = elementsRef.current.filter((element) => !element.isDeleted);
		const total = allCards.length + allElements.length;
		if (total === 0) return;
		const columns = Math.max(1, Math.ceil(Math.sqrt(total)));
		const gapX = 340;
		const gapY = 250;
		const rows = Math.ceil(total / columns);
		const startX = center.x - ((columns - 1) * gapX) / 2;
		const startY = center.y - ((rows - 1) * gapY) / 2;
		const placement = new Map<string, Point>();
		[...allCards, ...allElements].forEach((item, index) => {
			placement.set(item.id, {
				x: startX + (index % columns) * gapX,
				y: startY + Math.floor(index / columns) * gapY,
			});
		});
		setCards((current) =>
			current.map((card) => {
				const point = placement.get(card.id);
				return point ? { ...card, ...point } : card;
			}),
		);
		const api = apiRef.current;
		if (api) {
			api.updateScene({
				elements: api.getSceneElements().map((element) => {
					const point = placement.get(element.id);
					return point ? newElementWith(element, point) : element;
				}),
			});
		}
		setAgentMessage(`Organized ${total} object${total === 1 ? "" : "s"} into a clean region.`);
		setAgentOrbOpen(true);
	}

	function clusterBoard(): void {
		const allCards = cardsRef.current;
		if (allCards.length === 0) return;
		const center = visibleCenter();
		const groups = new Map<CardKind, Card[]>();
		for (const card of allCards) {
			const group = groups.get(card.kind) ?? [];
			group.push(card);
			groups.set(card.kind, group);
		}
		const groupEntries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		const startX = center.x - (Math.min(3, groupEntries.length) - 1) * 185;
		const startY = center.y - 210;
		const placements = new Map<string, Point>();
		groupEntries.forEach(([kind, group], groupIndex) => {
			const column = groupIndex % 3;
			const row = Math.floor(groupIndex / 3);
			const origin = { x: startX + column * 370, y: startY + row * 340 };
			group.forEach((card, index) => {
				placements.set(card.id, {
					x: origin.x + (index % 2) * 30,
					y: origin.y + index * 44,
				});
			});
			addCanvasElement({
				id: uid(`region_${kind}`),
				type: "frame",
				text: `${kindLabel(kind, "")} Area`,
				x: origin.x - 24,
				y: origin.y - 50,
				width: 340,
				height: Math.max(230, group.length * 44 + 118),
				strokeColor: "#d5dae3",
				backgroundColor: "transparent",
				strokeWidth: 1,
			}, origin);
		});
		setCards((current) => current.map((card) => {
			const point = placements.get(card.id);
			return point ? { ...card, ...point } : card;
		}));
		setAgentMessage(`Clustered ${allCards.length} card${allCards.length === 1 ? "" : "s"} into ${groupEntries.length} typed region${groupEntries.length === 1 ? "" : "s"}.`);
		setAgentOrbOpen(true);
	}

	function removeCard(card: Card): void {
		if (card.url) {
			URL.revokeObjectURL(card.url);
			objectUrls.current.delete(card.url);
		}
		setCards((current) => current.filter((candidate) => candidate.id !== card.id));
		setLinks((current) =>
			current.filter((link) => link.from.objectId !== card.id && link.to.objectId !== card.id),
		);
		if (selectedCardId === card.id) setSelectedCardId(null);
	}

	function updateCard(id: string, patch: Partial<Card>): void {
		setCards((current) => current.map((card) => (card.id === id ? { ...card, ...patch } : card)));
	}

	async function openCardInLsp(card: Card): Promise<void> {
		if (!card.path || (card.kind !== "code" && card.kind !== "artifact")) return;
		try {
			const text = card.text ?? await window.axiom.space.readFileText(card.path);
			const languageId = await window.axiom.lsp.didOpen(card.path, text);
			updateCard(card.id, {
				status: languageId ? `LSP ready: ${languageId}` : "No LSP server for this file type",
				evidence: [`Opened ${card.path} in the IDE LSP bridge.`],
			});
			setAgentMessage(languageId ? `LSP is ready for ${card.name}.` : `No LSP server is configured for ${card.name}.`);
			setAgentOrbOpen(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateCard(card.id, { status: "LSP error", evidence: [message] });
			setAgentMessage(`Could not open ${card.name} in LSP: ${message}`);
			setAgentOrbOpen(true);
		}
	}

	function startCardDrag(event: React.PointerEvent, id: string): void {
		if (isConnectGesture(event)) {
			const point = clientToScene(event.clientX, event.clientY);
			const bounds = objectBounds(id);
			if (bounds) startLink(event, nearestEndpoint(bounds, point, id));
			return;
		}
		event.stopPropagation();
		setSelectedCardId(id);
		setSelectedLinkId(null);
		const card = cardsRef.current.find((candidate) => candidate.id === id);
		if (!card) return;
		const start = clientToScene(event.clientX, event.clientY);
		const origin = { x: card.x, y: card.y };
		const move = (moveEvent: PointerEvent) => {
			const point = clientToScene(moveEvent.clientX, moveEvent.clientY);
			updateCard(id, { x: origin.x + point.x - start.x, y: origin.y + point.y - start.y });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function isConnectGesture(event: React.PointerEvent): boolean {
		return linkMode || event.ctrlKey || event.metaKey || event.altKey;
	}

	function startCardResize(event: React.PointerEvent, card: Card, corner: ResizeCorner): void {
		event.stopPropagation();
		const start = clientToScene(event.clientX, event.clientY);
		const origin = { ...card };
		const move = (moveEvent: PointerEvent) => {
			const point = clientToScene(moveEvent.clientX, moveEvent.clientY);
			const dx = point.x - start.x;
			const dy = point.y - start.y;
			let x = origin.x;
			let y = origin.y;
			let w = origin.w;
			let h = origin.h;
			if (corner.includes("e")) w = Math.max(150, origin.w + dx);
			if (corner.includes("s")) h = Math.max(100, origin.h + dy);
			if (corner.includes("w")) {
				w = Math.max(150, origin.w - dx);
				x = origin.x + origin.w - w;
			}
			if (corner.includes("n")) {
				h = Math.max(100, origin.h - dy);
				y = origin.y + origin.h - h;
			}
			updateCard(card.id, { x, y, w, h });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function startLink(event: React.PointerEvent, from: LinkEndpoint): void {
		event.preventDefault();
		event.stopPropagation();
		setSelectedLinkId(null);
		const move = (moveEvent: PointerEvent) => {
			setPendingLink({ from, pointer: clientToScene(moveEvent.clientX, moveEvent.clientY) });
		};
		const up = (upEvent: PointerEvent) => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			const point = clientToScene(upEvent.clientX, upEvent.clientY);
			const targetId = objectAt(point, from.objectId);
			const targetBounds = targetId ? objectBounds(targetId) : null;
			if (targetId && targetBounds) {
				const to = nearestEndpoint(targetBounds, point, targetId);
				const fromBounds = objectBounds(from.objectId);
				if (fromBounds) {
					const curve = defaultCurve(endpointFor(fromBounds, from.side, from.t), endpointFor(targetBounds, to.side, to.t));
					const link: Link = { id: uid("link"), from, to, ...curve };
					setLinks((current) => [...current, link]);
					setSelectedLinkId(link.id);
				}
			}
			setPendingLink(null);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function dragLinkControl(event: React.PointerEvent, link: Link, which: "c1" | "c2"): void {
		event.preventDefault();
		event.stopPropagation();
		const endpoint = which === "c1" ? link.from : link.to;
		const bounds = objectBounds(endpoint.objectId);
		if (!bounds) return;
		const anchor = endpointFor(bounds, endpoint.side, endpoint.t);
		const move = (moveEvent: PointerEvent) => {
			const point = clientToScene(moveEvent.clientX, moveEvent.clientY);
			setLinks((current) =>
				current.map((candidate) =>
					candidate.id === link.id
						? { ...candidate, [which]: { x: point.x - anchor.x, y: point.y - anchor.y } }
						: candidate,
				),
			);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function dragLinkEndpoint(event: React.PointerEvent, link: Link, which: "from" | "to"): void {
		event.preventDefault();
		event.stopPropagation();
		const endpoint = link[which];
		const bounds = objectBounds(endpoint.objectId);
		if (!bounds) return;
		const move = (moveEvent: PointerEvent) => {
			const point = clientToScene(moveEvent.clientX, moveEvent.clientY);
			const next = nearestEndpoint(bounds, point, endpoint.objectId);
			setLinks((current) =>
				current.map((candidate) => (candidate.id === link.id ? { ...candidate, [which]: next } : candidate)),
			);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function updateSelectedLink(patch: Partial<Link>): void {
		if (!selectedLinkId) return;
		setLinks((current) => current.map((link) => link.id === selectedLinkId ? { ...link, ...patch } : link));
	}

	function applyCurvePreset(preset: "straight" | "smooth" | "tight"): void {
		if (!selectedLinkId) return;
		setLinks((current) => current.map((link) => {
			if (link.id !== selectedLinkId) return link;
			const fromBounds = objectBounds(link.from.objectId);
			const toBounds = objectBounds(link.to.objectId);
			if (!fromBounds || !toBounds) return link;
			const from = endpointFor(fromBounds, link.from.side, link.from.t);
			const to = endpointFor(toBounds, link.to.side, link.to.t);
			const distance = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y));
			if (preset === "straight") {
				return { ...link, c1: { x: (to.x - from.x) / 3, y: (to.y - from.y) / 3 }, c2: { x: (from.x - to.x) / 3, y: (from.y - to.y) / 3 } };
			}
			const amount = distance * (preset === "tight" ? 0.18 : 0.36);
			const vector = (side: Side, multiplier: number): Point => {
				switch (side) {
					case "left": return { x: -amount * multiplier, y: 0 };
					case "right": return { x: amount * multiplier, y: 0 };
					case "top": return { x: 0, y: -amount * multiplier };
					case "bottom": return { x: 0, y: amount * multiplier };
				}
			};
			return { ...link, c1: vector(link.from.side, 1), c2: vector(link.to.side, 1) };
		}));
	}

	function addCanvasElement(action: BoardAction, center: Point): string | null {
		const api = apiRef.current;
		if (!api) return null;
		const id = action.id || uid("agent");
		const x = action.x ?? center.x;
		const y = action.y ?? center.y;
		const width = Math.max(30, action.width ?? 220);
		const height = Math.max(30, action.height ?? 130);
		const fontFamily = action.fontFamily === "sans"
			? FONT_FAMILY.Helvetica
			: action.fontFamily === "mono"
				? FONT_FAMILY.Cascadia
				: action.fontFamily === "assistant"
					? FONT_FAMILY.Assistant
					: FONT_FAMILY.Virgil;
		const startArrowhead = action.startArrowhead === "none" ? null : action.startArrowhead;
		const endArrowhead = action.endArrowhead === "none" ? null : action.endArrowhead;
		const roundness: ExcalidrawElement["roundness"] | undefined =
			action.roundness === "sharp" ? null : action.roundness === "round" ? { type: 3 } : undefined;
		const base = {
			id,
			x,
			y,
			width,
			height,
			strokeColor: action.strokeColor ?? "#252b35",
			backgroundColor: action.backgroundColor ?? "transparent",
			fillStyle: action.fillStyle ?? "solid",
			roughness: action.roughness ?? 1,
			strokeWidth: action.strokeWidth ?? 2,
			strokeStyle: action.strokeStyle ?? "solid",
			opacity: action.opacity ?? 100,
			roundness,
			link: action.link ?? null,
			locked: action.locked ?? false,
		};
		let skeleton: ExcalidrawElementSkeleton | null = null;
		switch (action.type) {
			case "rectangle":
			case "ellipse":
			case "diamond":
				skeleton = { ...base, type: action.type };
				break;
			case "note":
				skeleton = {
					...base,
					type: "rectangle",
					backgroundColor: action.backgroundColor ?? "#fff9dc",
					strokeColor: action.strokeColor ?? "#c9bf83",
					roughness: action.roughness ?? 0,
					strokeWidth: action.strokeWidth ?? 1,
					label: {
						text: action.text ?? "Note",
						fontSize: action.fontSize ?? 18,
						fontFamily,
						textAlign: action.textAlign ?? "left",
						verticalAlign: action.verticalAlign ?? "top",
						strokeColor: "#3b382b",
					},
				};
				break;
			case "text":
				skeleton = {
					type: "text",
					id,
					x,
					y,
					text: action.text ?? "Text",
					fontSize: action.fontSize ?? 24,
					fontFamily,
					textAlign: action.textAlign ?? "left",
					verticalAlign: action.verticalAlign ?? "top",
					opacity: action.opacity ?? 100,
					strokeColor: action.strokeColor ?? "#1f2937",
				};
				break;
			case "arrow":
			case "line":
					skeleton = {
						...base,
						type: action.type,
						points: action.points,
						label: action.text ? { text: action.text, fontSize: action.fontSize ?? 18, fontFamily } : undefined,
						startArrowhead: action.type === "arrow" ? (startArrowhead ?? null) : null,
						endArrowhead: action.type === "arrow" ? (endArrowhead ?? "arrow") : null,
					};
				break;
			case "freedraw":
				skeleton = {
					...base,
					type: "line",
					roughness: 2,
					points: (action.points ?? [
						[0, 0],
						[width * 0.22, -height * 0.08],
						[width * 0.48, height * 0.18],
						[width * 0.73, height * 0.06],
						[width, height * 0.3],
					]) as ExcalidrawLinearElement["points"],
				};
				break;
			case "frame":
				skeleton = { ...base, type: "frame", children: [], name: action.text ?? "Frame" };
				break;
		}
		if (!skeleton) return null;
		const converted = convertToExcalidrawElements([skeleton], { regenerateIds: false });
		const primary = converted[0];
		if (!primary) return null;
		api.updateScene({
			elements: [...api.getSceneElements(), ...converted],
			appState: { selectedElementIds: Object.fromEntries(converted.map((element) => [element.id, true])) },
		});
		return primary.id;
	}

	async function addMermaidDiagram(definition: string, position: Point): Promise<number> {
		const api = apiRef.current;
		if (!api) throw new Error("Space canvas is not ready.");
		const { elements: converted, files } = await convertMermaidToSpaceElements(definition, position);
		if (files.length) api.addFiles(files);
		api.updateScene({
			elements: [...api.getSceneElements(), ...converted],
			appState: { selectedElementIds: Object.fromEntries(converted.map((element) => [element.id, true])) },
		});
		return converted.length;
	}

	function styleObject(action: BoardAction): void {
		if (!action.target) return;
		if (cardsRef.current.some((card) => card.id === action.target)) {
			const patch: Partial<Card> = {};
			if (action.name !== undefined) patch.name = action.name;
			if (action.content !== undefined || action.text !== undefined) patch.text = action.content ?? action.text;
			if (action.summary !== undefined || action.text !== undefined) patch.summary = action.summary ?? action.text;
			if (action.status !== undefined) patch.status = action.status;
			if (action.progress !== undefined) patch.progress = action.progress;
			if (action.strokeColor !== undefined) patch.strokeColor = action.strokeColor;
			if (action.backgroundColor !== undefined) patch.backgroundColor = action.backgroundColor;
			if (action.strokeColor !== undefined) patch.textColor = action.strokeColor;
			if (action.caption !== undefined) patch.caption = action.caption;
			updateCard(action.target, patch);
			return;
		}
		const api = apiRef.current;
		if (!api) return;
		const fontFamily =
			action.fontFamily === "sans" ? FONT_FAMILY.Helvetica
				: action.fontFamily === "mono" ? FONT_FAMILY.Cascadia
					: action.fontFamily === "assistant" ? FONT_FAMILY.Assistant
						: action.fontFamily === "hand" ? FONT_FAMILY.Virgil
							: undefined;
		api.updateScene({
			elements: api.getSceneElements().map((element) => {
				const isTarget = element.id === action.target || ("containerId" in element && element.containerId === action.target);
				if (!isTarget) return element;
				const patch: Record<string, unknown> = {};
				for (const key of ["strokeColor", "backgroundColor", "strokeWidth", "strokeStyle", "fillStyle", "roughness", "opacity", "textAlign", "verticalAlign"] as const) {
					if (action[key] !== undefined) patch[key] = action[key];
				}
				if (action.roundness !== undefined) patch.roundness = action.roundness === "round" ? { type: 3 } : null;
				if (action.link !== undefined) patch.link = action.link || null;
				if (action.locked !== undefined) patch.locked = action.locked;
				if (fontFamily !== undefined && element.type === "text") patch.fontFamily = fontFamily;
				if (action.fontSize !== undefined && element.type === "text") patch.fontSize = action.fontSize;
				if (action.text !== undefined && element.type === "text") {
					patch.text = action.text;
					patch.originalText = action.text;
				}
				return newElementWith(element, patch);
			}),
		});
	}

	function groupObjects(targets: string[]): void {
		const api = apiRef.current;
		if (!api || targets.length < 2) return;
		const groupId = uid("group");
		const targetSet = new Set(targets);
		api.updateScene({ elements: api.getSceneElements().map((element) => targetSet.has(element.id) ? newElementWith(element, { groupIds: [...element.groupIds, groupId] }) : element) });
	}

	function reorderObject(target: string, direction: BoardAction["direction"]): void {
		const api = apiRef.current;
		if (!api || !direction) return;
		const elements = [...api.getSceneElements()];
		const index = elements.findIndex((element) => element.id === target);
		if (index < 0) return;
		const [element] = elements.splice(index, 1);
		if (direction === "front") elements.push(element);
		else if (direction === "back") elements.unshift(element);
		else if (direction === "forward") elements.splice(Math.min(elements.length, index + 1), 0, element);
		else elements.splice(Math.max(0, index - 1), 0, element);
		api.updateScene({ elements });
	}

	function duplicateObject(target: string, offsetX = 36, offsetY = 36): string | null {
		const api = apiRef.current;
		if (!api) return null;
		const source = api.getSceneElements().find((element) => element.id === target);
		if (!source) return null;
		const skeleton = newElementWith(source, { x: source.x + offsetX, y: source.y + offsetY, groupIds: [], boundElements: [] });
		const [duplicate] = convertToExcalidrawElements([skeleton as ExcalidrawElementSkeleton], { regenerateIds: true });
		api.updateScene({ elements: [...api.getSceneElements(), duplicate], appState: { selectedElementIds: { [duplicate.id]: true } } });
		return duplicate.id;
	}

	function mutateObject(target: string, patch: { x?: number; y?: number; width?: number; height?: number; angle?: number }): void {
		const card = cardsRef.current.find((candidate) => candidate.id === target);
		if (card) {
			updateCard(target, {
				x: patch.x ?? card.x,
				y: patch.y ?? card.y,
				w: Math.max(150, patch.width ?? card.w),
				h: Math.max(100, patch.height ?? card.h),
			});
			return;
		}
		const api = apiRef.current;
		if (!api) return;
		api.updateScene({
			elements: api.getSceneElements().map((element) =>
				element.id === target
					? newElementWith(element, {
							x: patch.x ?? element.x,
							y: patch.y ?? element.y,
							width: Math.max(1, patch.width ?? element.width),
							height: Math.max(1, patch.height ?? element.height),
							angle: "angle" in patch && typeof patch.angle === "number" ? patch.angle * Math.PI / 180 : element.angle,
						})
					: element,
			),
		});
	}

	function removeObject(target: string): void {
		const card = cardsRef.current.find((candidate) => candidate.id === target);
		if (card) {
			removeCard(card);
			return;
		}
		const api = apiRef.current;
		if (!api) return;
		api.updateScene({
			elements: api
				.getSceneElements()
				.map((element) => (element.id === target ? newElementWith(element, { isDeleted: true }) : element)),
		});
		setLinks((current) =>
			current.filter((link) => link.from.objectId !== target && link.to.objectId !== target),
		);
	}

	function addConnection(action: BoardAction): void {
		if (!action.from || !action.to || action.from === action.to) return;
		const fromBounds = objectBounds(action.from);
		const toBounds = objectBounds(action.to);
		if (!fromBounds || !toBounds) return;
		const from: LinkEndpoint = { objectId: action.from, side: action.fromSide ?? "right", t: 0.5 };
		const to: LinkEndpoint = { objectId: action.to, side: action.toSide ?? "left", t: 0.5 };
		const curve = defaultCurve(endpointFor(fromBounds, from.side, from.t), endpointFor(toBounds, to.side, to.t));
		setLinks((current) => [...current, { id: action.id || uid("link"), from, to, ...curve }]);
	}


	// Visible-center of the board, in canvas coordinates. Used to place elements
	// the agent draws without explicit coordinates.
	function computeCenter(): Point {
		const currentView = viewRef.current;
		const width = containerRef.current?.clientWidth ?? 1000;
		const height = containerRef.current?.clientHeight ?? 700;
		return {
			x: -currentView.scrollX + width / currentView.zoom / 2,
			y: -currentView.scrollY + height / currentView.zoom / 2 - 60,
		};
	}

	// Structured snapshot of the board (+ optional JPEG capture). Shared by the
	// Gemini board agent and the real RPC agent's `space_snapshot` host-call.
	function buildSceneSnapshot(includeImage: boolean): {
		objects: unknown[];
		links: unknown[];
		viewport: unknown;
		image?: { mimeType: string; data: string };
	} {
		const currentView = viewRef.current;
		const width = containerRef.current?.clientWidth ?? 1000;
		const height = containerRef.current?.clientHeight ?? 700;
		const objects = [
			...cardsRef.current.map((card) => ({
				id: card.id,
				type: `card:${card.kind}`,
				name: card.name,
				caption: card.caption,
				status: card.status,
				progress: card.progress,
				path: card.path,
				url: card.url,
				summary: card.summary?.slice(0, 1200),
				sources: metadataList(card.sources),
				findings: metadataList(card.findings),
				dependencies: metadataList(card.dependencies),
				decisions: metadataList(card.decisions),
				evidence: metadataList(card.evidence),
				children: card.children?.slice(0, 20).map((child) => ({ name: child.name, path: child.path, dir: child.dir })),
				style: {
					strokeColor: card.strokeColor,
					backgroundColor: card.backgroundColor,
					textColor: card.textColor,
				},
				text: card.text?.slice(0, 1200),
				x: Math.round(card.x),
				y: Math.round(card.y),
				width: Math.round(card.w),
				height: Math.round(card.h),
			})),
			...elementsRef.current
				.filter((element) => !element.isDeleted)
				.map((element) => ({
					id: element.id,
					type: element.type,
					text: "text" in element && typeof element.text === "string" ? element.text.slice(0, 1200) : undefined,
					x: Math.round(element.x),
					y: Math.round(element.y),
					width: Math.round(element.width),
					height: Math.round(element.height),
				})),
		];
		const links = linksRef.current.map((link) => ({ id: link.id, from: link.from, to: link.to }));
		const viewport = {
			left: Math.round(-currentView.scrollX),
			top: Math.round(-currentView.scrollY),
			right: Math.round(-currentView.scrollX + width / currentView.zoom),
			bottom: Math.round(-currentView.scrollY + height / currentView.zoom),
			zoom: Number(currentView.zoom.toFixed(3)),
		};
		let image: { mimeType: string; data: string } | undefined;
		if (includeImage && containerRef.current) {
			try {
				const frame = captureSpaceVision(
					containerRef.current,
					cardsRef.current,
					elementsRef.current,
					linksRef.current,
					currentView,
				);
				image = { mimeType: frame.mimeType, data: frame.data };
			} catch (error) {
				console.warn("Space snapshot vision capture failed", error);
			}
		}
		return { objects, links, viewport, image };
	}

	// Fit EVERY object into the viewport, let it render, then capture a snapshot +
	// image that frames the whole board. Used by Transfer-to-Chat so the handoff
	// image shows the complete design, not just whatever was scrolled into view.
	// Restores the user's prior view afterward so the transfer is non-destructive.
	async function fitToAllAndCapture(): Promise<{
		objects: unknown[];
		links: unknown[];
		viewport: unknown;
		image?: { mimeType: string; data: string };
	}> {
		const api = apiRef.current;
		const prior = { ...viewRef.current };
		if (api) {
			try {
				const all = api.getSceneElements();
				if (all.length > 0) {
					api.scrollToContent(all, { fitToContent: true, animate: false });
					// Two RAFs: one for Excalidraw to apply the new scroll/zoom (which
					// flows back into viewRef via onChange), one for the canvas to paint
					// at the new view before we read pixels.
					await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				}
			} catch (error) {
				console.warn("Space fit-to-all failed; capturing current view", error);
			}
		}
		const snapshot = buildSceneSnapshot(true);
		// Restore the user's original view — the transfer should not move their canvas.
		if (api) {
			try {
				api.updateScene({
					appState: {
						scrollX: prior.scrollX,
						scrollY: prior.scrollY,
						zoom: { value: prior.zoom as never },
					},
				});
			} catch {
				// Non-fatal: worst case the board stays fit-to-all, which is harmless.
			}
		}
		return snapshot;
	}

	// TRANSFER TO CHAT. Fit the whole board, capture image + structured objects, then
	// hand a detailed, build-ready brief to the coding agent in Chat. If the board is
	// a design/UI, instruct the agent to write DESIGN.md via the space-design-md skill
	// before building. The fit-to-all image goes along so the multimodal handoff sees
	// the complete composition, not a scrolled fragment.
	async function transferToChat(): Promise<void> {
		if (transferring) return;
		setTransferring(true);
		setAgentMessage("Capturing the board for Chat…");
		try {
			const snapshot = await fitToAllAndCapture();
			const objectCount = Array.isArray(snapshot.objects) ? snapshot.objects.length : 0;
			if (objectCount === 0) {
				setAgentMessage("The board is empty — nothing to transfer yet.");
				setTransferring(false);
				return;
			}
			// Compact the structured board so the agent has exact ids/text/colors/sizes
			// to reason over, alongside the fit-to-all image for composition/vibe.
			const board = JSON.stringify({ objects: snapshot.objects, links: snapshot.links }, null, 1).slice(0, 24_000);
			const handoff = [
				"You are picking up work handed off from the AXIOM Space whiteboard. The attached image frames the ENTIRE board (fit to all objects); the JSON below is the exact structured board (object ids, text, colors, sizes, and links).",
				"",
				"Do this, in order:",
				"1. Read the board: summarize what it is and what the user is trying to build — a detailed, compaction-style brief (purpose, the key objects and their relationships per the links, any decisions/text on the board). Be specific and exhaustive enough that someone who never saw the board could continue.",
				"2. If the board is a UI / mockup / visual design, invoke the 'space-design-md' skill and write a DESIGN.md in the working directory capturing the design system (atmosphere, palette with hex + roles, typography, components, layout) from the image + JSON.",
				"3. Then proceed to help build it, starting from that brief and DESIGN.md.",
				"",
				"=== BOARD (JSON) ===",
				board,
				"=== END BOARD ===",
			].join("\n");
			onTransfer?.({ text: handoff, image: snapshot.image });
			setAgentMessage("Sent the board to Chat. Continuing there…");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setAgentMessage(`Transfer failed: ${message}`);
		} finally {
			setTransferring(false);
		}
	}

	// Bridge the REAL AXIOM agent's canvas tools (space_draw/move/connect/delete/
	// snapshot) to the board. This is what gives Space the full AXIOM brain
	// (SparseTreeGrep, DeepResearch, …) AND the ability to draw: the agent calls
	// these tools, the host_call lands here, we mutate the board and reply.
	useEffect(() => {
		const off = window.axiom?.spaceAgent?.onHostCall?.("space", async (op, rawPayload) => {
			const payload = (rawPayload ?? {}) as BoardAction & { shape?: string; includeImage?: boolean };
			console.log("[SPACE host_call]", op, "apiReady=", !!apiRef.current, JSON.stringify(rawPayload).slice(0, 160));
			const center = computeCenter();
			switch (op) {
				case "snapshot":
					return buildSceneSnapshot(payload.includeImage !== false);
				case "draw": {
					const shape = payload.shape ?? payload.type ?? "rectangle";
					if (shape === "node") {
						return { id: await createStructuredNode(payload, center) };
					}
					if (shape === "mermaid") {
						const count = await addMermaidDiagram(payload.mermaid ?? payload.text ?? "", { x: payload.x ?? center.x, y: payload.y ?? center.y });
						return { count };
					}
					if (shape === "image") {
						if (!payload.path) throw new Error("space_draw shape=image requires an absolute path.");
						const id = await addNativeImageFromPath(
							payload.path,
							payload.name ?? payload.path.split("/").pop() ?? "image",
							payload.x ?? center.x,
							payload.y ?? center.y,
						);
						if (!id) throw new Error(`Could not import image: ${payload.path}`);
						return { id };
					}
					const id = addCanvasElement({ ...payload, type: shape }, center);
					return { id };
				}
				case "node":
					return { id: await createStructuredNode(payload, center) };
				case "style":
					styleObject(payload);
					return { ok: true };
				case "cluster":
					clusterBoard();
					return { ok: true };
				case "mermaid": {
					const count = await addMermaidDiagram(payload.definition ?? payload.mermaid ?? "", { x: payload.x ?? center.x, y: payload.y ?? center.y });
					return { count };
				}
				case "move":
					if (payload.target) mutateObject(payload.target, payload);
					return { ok: true };
				case "connect":
					addConnection(payload);
					return { ok: true };
				case "group":
					groupObjects(payload.targets ?? []);
					return { ok: true };
				case "reorder":
					if (payload.target) reorderObject(payload.target, payload.direction);
					return { ok: true };
				case "duplicate":
					return { id: payload.target ? duplicateObject(payload.target, payload.offsetX, payload.offsetY) : null };
				case "delete":
					if (payload.target) removeObject(payload.target);
					return { ok: true };
				default:
					throw new Error(`Unknown Space host op: ${op}`);
			}
		});
		return () => off?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Surface the real agent's streamed reply + tool activity in the Space orb.
	useEffect(() => {
		const off = window.axiom?.spaceAgent?.onEvent?.((e) => {
			if (agentBusyRef.current) armAgentWatchdog();
			switch (e.type) {
				case "message_update":
				case "message_end": {
					const msg = e.message as { role?: string; content?: unknown } | undefined;
					if (msg?.role !== "assistant") break;
					const textPart = Array.isArray(msg.content)
						? (msg.content.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined)
								?.text
						: typeof msg.content === "string"
							? (msg.content as string)
							: undefined;
					if (textPart) setAgentMessage(textPart.slice(-1200));
					break;
				}
				case "tool_execution_start": {
					const name = String((e as { toolName?: string }).toolName ?? "");
					const id = String((e as { toolCallId?: string }).toolCallId ?? uid("activity"));
					const args = ((e as { args?: unknown; arguments?: unknown }).args ??
						(e as { arguments?: unknown }).arguments) as Record<string, unknown> | undefined;
					const label = name.startsWith("space_")
						? name.replace("space_", "").replace(/^\w/, (m) => m.toUpperCase()) + " on board"
						: name.replaceAll("_", " ");
					setAgentActivity((cur) => [...cur, { id, label, status: "running" as const }]);
					if (name.startsWith("space_")) {
						// The agent actually touched the board — no fallback needed.
						spaceToolRanRef.current = true;
						const target = typeof args?.target === "string" ? objectBounds(args.target) : null;
						const fallback = computeCenter();
						setAgentCursor({
							x: target ? target.x + target.w * 0.68 : typeof args?.x === "number" ? args.x : fallback.x + 80,
							y: target ? target.y + Math.min(target.h * 0.3, 70) : typeof args?.y === "number" ? args.y : fallback.y - 35,
							mode: "acting",
							durationMs: 360,
						});
					} else {
						setAgentCursor((cursor) => ({ ...cursor, mode: "thinking", durationMs: 420 }));
					}
					break;
				}
				case "tool_execution_end": {
					const id = String((e as { toolCallId?: string }).toolCallId ?? "");
					const isError = Boolean((e as { isError?: boolean }).isError);
					setAgentActivity((cur) =>
						cur.map((item) => (item.id === id ? { ...item, status: isError ? "error" : "done" } : item)),
					);
					setAgentCursor((cursor) => ({
						...cursor,
						mode: agentBusyRef.current ? "thinking" : "idle",
						durationMs: 520,
					}));
					break;
				}
				case "agent_end":
				case "rpc_error":
				case "rpc_exit": {
					clearAgentWatchdog();
					setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 900 }));
					// If the agent finished without ever drawing, draw directly so
					// Space is never left empty. maybeFallbackDraw re-arms busy state;
					// otherwise clear it here.
					if (pendingPromptRef.current && !spaceToolRanRef.current && !fallbackRanRef.current) {
						void maybeFallbackDraw();
					} else {
						setAgentBusy(false);
					}
					break;
				}
			}
		});
		return () => off?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function stopAgent(): Promise<void> {
		clearAgentWatchdog();
		setAgentBusy(false);
		setAgentMessage("Stopped.");
		setAgentActivity((current) =>
			current.map((item) => (item.status === "running" ? { ...item, status: "error" } : item)),
		);
		setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 520 }));
		try {
			await window.axiom?.spaceAgent?.abort();
		} catch (error) {
			setAgentMessage(`Could not stop the agent: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// AGENT-FIRST. Run the real AXIOM agent: it gets the full brain (research,
	// snapshot→reason→draw, multi-step) AND the space-drawing skill, and draws via
	// the space_* tools that land in the onHostCall bridge above. If the agent never
	// touches the board — flaky free tier, no tool call, or a wedge — the agent_end /
	// watchdog handler calls directDraw() as a reliable fallback so Space is never
	// left empty.
	async function runAgent(requestOverride?: string): Promise<void> {
		const text = (requestOverride ?? agentInput).trim();
		if (!text || agentBusy) return;
		const agent = window.axiom?.spaceAgent;
		if (!agent?.prompt) {
			// No agent bridge at all — go straight to direct draw.
			setAgentInput("");
			await directDraw(text);
			return;
		}
		setAgentInput("");
		setAgentBusy(true);
		setAgentOrbOpen(true);
		setAgentCursor((cursor) => ({ ...cursor, mode: "thinking", durationMs: 500 }));
		setAgentMessage("Thinking with the full AXIOM toolset…");
		setAgentActivity([]);
		// Reset fallback bookkeeping for this run.
		spaceToolRanRef.current = false;
		fallbackRanRef.current = false;
		pendingPromptRef.current = text;
		armAgentWatchdog();

		try {
			await agent.prompt(spaceAgentPrompt(text));
		} catch (error) {
			// The prompt call itself failed to dispatch — fall back immediately.
			const message = error instanceof Error ? error.message : String(error);
			setAgentMessage(`Agent unavailable (${message.slice(0, 80)}); drawing directly…`);
			await maybeFallbackDraw();
		}
	}

	// If the agent finished/aborted without ever drawing, run the reliable
	// Mermaid/shapes direct-draw on the original request. Guarded so it runs once.
	async function maybeFallbackDraw(): Promise<void> {
		const prompt = pendingPromptRef.current;
		if (!prompt || fallbackRanRef.current || spaceToolRanRef.current) return;
		fallbackRanRef.current = true;
		pendingPromptRef.current = null;
		await directDraw(prompt);
	}
	maybeFallbackDrawRef.current = maybeFallbackDraw;

	useEffect(() => {
		if (!incomingHandoff || incomingHandoff.id === consumedHandoffIdRef.current) return;
		consumedHandoffIdRef.current = incomingHandoff.id;
		setAgentInput(incomingHandoff.text);
		setAgentOrbOpen(true);
		setAgentMessage("Receiving Chat context…");
		window.setTimeout(() => {
			void runAgent(incomingHandoff.text);
		}, 80);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingHandoff?.id]);

	// DIRECT DRAW fallback (no agent function-calling — reliable over the flaky free
	// tier). Models have NO spatial reasoning, so asking for raw {x,y,w,h} shapes
	// produces garbage (a grid of overlapping boxes). Instead we ask the model for
	// MERMAID — a semantic diagram language models are genuinely good at — and run it
	// through @excalidraw/mermaid-to-excalidraw, which does real layout. Only literal
	// freeform sketches fall back to shape JSON.
	async function directDraw(text: string): Promise<void> {
		setAgentBusy(true);
		setAgentOrbOpen(true);
		setAgentCursor((cursor) => ({ ...cursor, mode: "thinking", durationMs: 500 }));
		armAgentWatchdog();

		const center = computeCenter();
		const prompt = [
			"You are AXIOM's whiteboard. Turn the request into a clean diagram.",
			"PREFER Mermaid — it is laid out automatically and looks professional. Use it for anything",
			"structured: flowcharts, architectures, sequences, mindmaps, class/ER diagrams, timelines, org charts, state machines.",
			"",
			"Reply with ONLY a JSON object, no prose, no markdown fences. Two shapes are allowed:",
			'  Diagram:  { "kind": "mermaid", "mermaid": "<mermaid source>" }',
			'  Freeform: { "kind": "shapes", "actions": [ { "shape": "rectangle|ellipse|diamond|text|note|line|arrow", "x": number, "y": number, "width": number, "height": number, "text"?: string, "strokeColor"?: "#hex", "backgroundColor"?: "#hex" } ] }',
			"Use Mermaid unless the request is a literal picture/sketch that cannot be a diagram.",
			"Mermaid rules: start with the diagram type (graph TD, flowchart LR, sequenceDiagram, mindmap, classDiagram, erDiagram, etc.).",
			"Keep node labels short. Do NOT wrap the mermaid in backticks.",
			"For freeform shapes only: use absolute coordinates near { x: " + Math.round(center.x) + ", y: " + Math.round(center.y) + " } and avoid overlaps.",
			"",
			"Request: " + text,
		].join("\n");

		try {
			let raw = "";
			await window.axiom.gemini.prompt([{ role: "user", text: prompt }], (delta) => {
				raw += delta;
			});
			const plan = parseDrawPlan(raw);

			if (plan.kind === "mermaid" && plan.mermaid) {
				setAgentCursor((cursor) => ({ ...cursor, mode: "acting", durationMs: 600 }));
				try {
					const count = await addMermaidDiagram(plan.mermaid, center);
					setAgentMessage(`Drew a diagram (${count} element${count === 1 ? "" : "s"}).`);
				} catch (mermaidError) {
					// Mermaid parse can fail on a malformed definition — surface it
					// rather than silently drawing nothing.
					const detail = mermaidError instanceof Error ? mermaidError.message : String(mermaidError);
					setAgentMessage(`Couldn't render that diagram (${detail.slice(0, 80)}). Try rephrasing.`);
				}
				setAgentBusy(false);
				setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 900 }));
				clearAgentWatchdog();
				return;
			}

			const actions = plan.actions ?? [];
			if (actions.length === 0) {
				setAgentMessage("AXIOM replied but produced no drawable output. Try rephrasing.");
				setAgentBusy(false);
				setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 900 }));
				clearAgentWatchdog();
				return;
			}
			setAgentCursor((cursor) => ({ ...cursor, mode: "acting", durationMs: 600 }));
			let drawn = 0;
			for (const action of actions) {
				// The model returns the kind as `shape`; our BoardAction uses `type`.
				const shape = (action as { shape?: string }).shape ?? action.type ?? "rectangle";
				try {
					if (shape === "node") {
						await createStructuredNode(action, center);
					} else {
						addCanvasElement({ ...action, type: shape }, center);
					}
					drawn += 1;
				} catch {
					// skip a malformed action, keep drawing the rest
				}
			}
			setAgentMessage(`Drew ${drawn} element${drawn === 1 ? "" : "s"} on the board.`);
			setAgentBusy(false);
			setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 900 }));
			clearAgentWatchdog();
		} catch (error) {
			clearAgentWatchdog();
			const message = error instanceof Error ? error.message : String(error);
			setAgentMessage(`Space failed: ${message}`);
			setAgentActivity((current) => current.map((item) => ({ ...item, status: "error" })));
			setAgentBusy(false);
			setAgentCursor((cursor) => ({ ...cursor, mode: "idle", durationMs: 900 }));
		}
	}

	// Parse a model reply into a draw plan: either a Mermaid diagram or a list of
	// freeform shape actions. Tolerates code fences and stray prose around the JSON.
	function parseDrawPlan(raw: string): { kind: "mermaid" | "shapes"; mermaid?: string; actions?: BoardAction[] } {
		if (!raw) return { kind: "shapes", actions: [] };
		let text = raw.trim();
		const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		if (fence) text = fence[1].trim();
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start === -1 || end === -1 || end <= start) return { kind: "shapes", actions: [] };
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as {
				kind?: string;
				mermaid?: string;
				definition?: string;
				actions?: BoardAction[];
			};
			const mermaid = (parsed.mermaid ?? parsed.definition ?? "").trim();
			if (parsed.kind === "mermaid" || (mermaid && !parsed.actions)) {
				return { kind: "mermaid", mermaid: stripMermaidFences(mermaid) };
			}
			return { kind: "shapes", actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
		} catch {
			return { kind: "shapes", actions: [] };
		}
	}

	// Models sometimes wrap mermaid in ```mermaid fences even when told not to.
	function stripMermaidFences(definition: string): string {
		const fence = /```(?:mermaid)?\s*([\s\S]*?)```/i.exec(definition);
		return (fence ? fence[1] : definition).trim();
	}

	function renderLink(link: Link) {
		const fromBounds = objectBounds(link.from.objectId);
		const toBounds = objectBounds(link.to.objectId);
		if (!fromBounds || !toBounds) return null;
		const fromScene = endpointFor(fromBounds, link.from.side, link.from.t);
		const toScene = endpointFor(toBounds, link.to.side, link.to.t);
		const from = toLocal(fromScene.x, fromScene.y);
		const to = toLocal(toScene.x, toScene.y);
		const c1 = { x: link.c1.x * view.zoom, y: link.c1.y * view.zoom };
		const c2 = { x: link.c2.x * view.zoom, y: link.c2.y * view.zoom };
		const selected = selectedLinkId === link.id;
		const c1Point = { x: from.x + c1.x, y: from.y + c1.y };
		const c2Point = { x: to.x + c2.x, y: to.y + c2.y };
		return (
			<g key={link.id} className={selected ? "link-group selected" : "link-group"}>
				<path className="link-hit" d={curvePath(from, c1, c2, to)} onPointerDown={() => setSelectedLinkId(link.id)} />
				<path className="link" d={curvePath(from, c1, c2, to)} />
				{selected && (
					<>
						<path className="link-guide" d={`M ${from.x} ${from.y} L ${c1Point.x} ${c1Point.y}`} />
						<path className="link-guide" d={`M ${to.x} ${to.y} L ${c2Point.x} ${c2Point.y}`} />
						<circle className="link-anchor" cx={from.x} cy={from.y} r="6" onPointerDown={(event) => dragLinkEndpoint(event, link, "from")} />
						<circle className="link-anchor" cx={to.x} cy={to.y} r="6" onPointerDown={(event) => dragLinkEndpoint(event, link, "to")} />
						<circle className="link-control" cx={c1Point.x} cy={c1Point.y} r="6" onPointerDown={(event) => dragLinkControl(event, link, "c1")} />
						<circle className="link-control" cx={c2Point.x} cy={c2Point.y} r="6" onPointerDown={(event) => dragLinkControl(event, link, "c2")} />
					</>
				)}
			</g>
		);
	}

	const selectedLink = links.find((link) => link.id === selectedLinkId) ?? null;
	const selectedCard = selectedCardId ? cards.find((card) => card.id === selectedCardId) ?? null : null;

	return (
		<div
			className={`space${linkMode ? " link-mode" : ""}`}
			ref={containerRef}
			onContextMenu={(event) => {
				event.preventDefault();
			}}
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) {
					setSelectedCardId(null);
					setSelectedLinkId(null);
				}
			}}
		>
			<Excalidraw
				theme="light"
				initialData={{
					appState: {
						gridSize: SPACE_GRID_SIZE,
						viewBackgroundColor: "#fbfbfa",
					},
				}}
				excalidrawAPI={(api) => {
					apiRef.current = api;
				}}
				onChange={(elements, appState) => {
					setSceneElements(elements);
					setView((current) =>
						current.scrollX === appState.scrollX &&
						current.scrollY === appState.scrollY &&
						current.zoom === appState.zoom.value
							? current
							: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value },
					);
				}}
				onPointerDown={() => {
					setSelectedLinkId(null);
					setSelectedCardId(null);
				}}
			>
				<MainMenu>
					<MainMenu.DefaultItems.LoadScene />
					<MainMenu.DefaultItems.SaveToActiveFile />
					<MainMenu.DefaultItems.Export />
					<MainMenu.DefaultItems.SaveAsImage />
					<MainMenu.DefaultItems.Help />
					<MainMenu.DefaultItems.ClearCanvas />
					<MainMenu.Separator />
					<MainMenu.DefaultItems.ChangeCanvasBackground />
					<MainMenu.ItemCustom className="space-menu-credit">
						*Space is built on top of Excalidraw.
					</MainMenu.ItemCustom>
				</MainMenu>
			</Excalidraw>

				<div className="space-hud" data-space-vision-exclude>
				<div className="space-hud-title">
					<b>SPACE</b>
					<span>{cards.length + sceneElements.filter((element) => !element.isDeleted).length} objects</span>
				</div>

				{selectedLink && (
					<aside className="link-inspector" data-space-vision-exclude aria-label="Connector properties">
						<div className="link-inspector-title">
							<span>Connector</span>
							<button onClick={() => setSelectedLinkId(null)} aria-label="Close connector properties">×</button>
						</div>
						<label>Curve</label>
						<div className="curve-presets" role="group" aria-label="Curve preset">
							<button onClick={() => applyCurvePreset("straight")} title="Straight">╱</button>
							<button onClick={() => applyCurvePreset("smooth")} title="Smooth">∿</button>
							<button onClick={() => applyCurvePreset("tight")} title="Tight">⌁</button>
						</div>
						<label htmlFor="link-outgoing">Outgoing bend</label>
						<input
							id="link-outgoing"
							type="range"
							min="-500"
							max="500"
							value={selectedLink.c1.x}
							onChange={(event) => updateSelectedLink({ c1: { ...selectedLink.c1, x: Number(event.target.value) } })}
						/>
						<label htmlFor="link-incoming">Incoming bend</label>
						<input
							id="link-incoming"
							type="range"
							min="-500"
							max="500"
							value={selectedLink.c2.x}
							onChange={(event) => updateSelectedLink({ c2: { ...selectedLink.c2, x: Number(event.target.value) } })}
						/>
						<label>Anchor position</label>
						<div className="anchor-sliders">
							<input aria-label="Start anchor position" type="range" min="0" max="1" step="0.01" value={selectedLink.from.t} onChange={(event) => updateSelectedLink({ from: { ...selectedLink.from, t: Number(event.target.value) } })} />
							<input aria-label="End anchor position" type="range" min="0" max="1" step="0.01" value={selectedLink.to.t} onChange={(event) => updateSelectedLink({ to: { ...selectedLink.to, t: Number(event.target.value) } })} />
						</div>
						<button className="link-delete" onClick={() => { setLinks((current) => current.filter((link) => link.id !== selectedLink.id)); setSelectedLinkId(null); }}>Delete connector</button>
					</aside>
				)}
				{selectedCard && (
					<aside className="space-node-inspector" data-space-vision-exclude aria-label="Selected Space node details">
						<div className="node-inspector-head">
							<span>{kindLabel(selectedCard.kind, selectedCard.ext)}</span>
							<button onClick={() => setSelectedCardId(null)} aria-label="Close node details">×</button>
						</div>
						<input
							className="node-title-input"
							value={selectedCard.name}
							onChange={(event) => updateCard(selectedCard.id, { name: event.target.value })}
							aria-label="Node title"
						/>
						<textarea
							value={selectedCard.summary ?? selectedCard.text ?? ""}
							onChange={(event) => updateCard(selectedCard.id, { summary: event.target.value })}
							placeholder="Summary, useful reasoning, or what this object represents…"
							aria-label="Node summary"
						/>
						<div className="node-inspector-grid">
							<label>Status <input value={selectedCard.status ?? ""} onChange={(event) => updateCard(selectedCard.id, { status: event.target.value })} /></label>
							<label>Progress <input type="number" min="0" max="100" value={selectedCard.progress ?? ""} onChange={(event) => updateCard(selectedCard.id, { progress: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
						</div>
						{([
							["Findings", selectedCard.findings],
							["Decisions", selectedCard.decisions],
							["Evidence", selectedCard.evidence],
							["Sources", selectedCard.sources],
							["Dependencies", selectedCard.dependencies],
						] as const).map(([label, values]) => (
							<section key={label} className="node-inspector-section">
								<b>{label}</b>
								{metadataList(values).length > 0 ? (
									<ul>{metadataList(values).map((item) => <li key={item}>{item}</li>)}</ul>
								) : (
									<span>No {label.toLowerCase()} yet.</span>
								)}
							</section>
						))}
					</aside>
				)}
				<div className="space-hud-actions">
					<button onClick={createNoteAtCenter}>+ Note</button>
					<button onClick={tidyBoard} disabled={cards.length + sceneElements.length === 0}>Tidy</button>
					<button onClick={clusterBoard} disabled={cards.length === 0}>Cluster</button>
				</div>
			</div>

			<div className="space-overlay">
				<svg className="space-links">
					{links.map(renderLink)}
					{pendingLink &&
						(() => {
							const bounds = objectBounds(pendingLink.from.objectId);
							if (!bounds) return null;
							const fromScene = endpointFor(bounds, pendingLink.from.side, pendingLink.from.t);
							const from = toLocal(fromScene.x, fromScene.y);
							const to = toLocal(pendingLink.pointer.x, pendingLink.pointer.y);
							const curve = defaultCurve(from, to);
							return <path className="link pending" d={curvePath(from, curve.c1, curve.c2, to)} />;
						})()}
				</svg>

				{linkMode &&
					sceneElements
						.filter((element) => !element.isDeleted)
						.map((element) => {
							const pos = toLocal(element.x, element.y);
							return (
								<div
									key={`connect_${element.id}`}
									className="element-connect-outline"
									style={{
										transform: `translate(${pos.x}px, ${pos.y}px) scale(${view.zoom})`,
										width: Math.max(1, element.width),
										height: Math.max(1, element.height),
									}}
									onPointerDown={(event) => {
										const point = clientToScene(event.clientX, event.clientY);
										startLink(event, nearestEndpoint({ x: element.x, y: element.y, w: element.width, h: element.height }, point, element.id));
									}}
								>
									{SIDES.map((side) => (
										<button
											key={side}
											className={`connect-port ${side}`}
											aria-label={`Connect from ${side}`}
											onPointerDown={(event) => startLink(event, { objectId: element.id, side, t: 0.5 })}
										/>
									))}
								</div>
							);
						})}

				{cards.map((card) => {
					const pos = toLocal(card.x, card.y);
					const selected = selectedCardId === card.id;
					return (
						<div
							key={card.id}
							data-card={card.id}
							className={`node-shell${selected ? " selected" : ""}`}
							style={{
								transform: `translate(${pos.x}px, ${pos.y}px) scale(${view.zoom})`,
								width: card.w,
								height: card.h,
							}}
							onContextMenu={(event) => event.preventDefault()}
							onPointerDown={(event) => {
								if (!isConnectGesture(event)) return;
								const point = clientToScene(event.clientX, event.clientY);
								startLink(event, nearestEndpoint({ x: card.x, y: card.y, w: card.w, h: card.h }, point, card.id));
							}}
						>
							<div
								className="node-card"
								style={{
									borderColor: card.strokeColor,
									backgroundColor: card.backgroundColor,
									color: card.textColor,
								}}
							>
								<div
								className="node-head"
								onPointerDown={(event) => startCardDrag(event, card.id)}
								onDoubleClick={(event) => {
									if (!event.ctrlKey && !event.metaKey) return;
									if (card.kind !== "code") return;
									event.stopPropagation();
									const body = event.currentTarget.nextElementSibling;
									const content = body?.firstElementChild;
									if (!content) return;
									const HEAD = 32;
									const PAD = 28;
									const newW = Math.max(260, Math.min(1200, content.scrollWidth + PAD));
									const newH = Math.max(120, Math.min(1000, content.scrollHeight + HEAD + PAD));
									updateCard(card.id, { w: newW, h: newH });
								}}
							>
								<span className={`node-kind kind-${card.kind}`}>{kindLabel(card.kind, card.ext)}</span>
									<span className="node-name" title={card.name}>{card.name}</span>
									<button
										className="node-action"
										title="Add or edit caption"
										onPointerDown={(event) => event.stopPropagation()}
										onClick={() => updateCard(card.id, { caption: card.caption ?? "" })}
									>
										T
									</button>
									<button
										className="node-action"
										title="Expand preview"
										onPointerDown={(event) => event.stopPropagation()}
										onClick={() => setFullscreenCard(card)}
										aria-label={`Expand ${card.name}`}
									>
										⤢
									</button>
									{card.path && (card.kind === "code" || card.kind === "artifact") && (
										<button
											className="node-action"
											title="Open in LSP"
											onPointerDown={(event) => event.stopPropagation()}
											onClick={() => void openCardInLsp(card)}
											aria-label={`Open ${card.name} in LSP`}
										>
											λ
										</button>
									)}
									<button
										className="node-action"
										onPointerDown={(event) => event.stopPropagation()}
										onClick={() => removeCard(card)}
										aria-label={`Remove ${card.name}`}
									>
										×
									</button>
								</div>
								<div
								className="node-body"
								onPointerDown={() => setSelectedCardId(card.id)}
								onDoubleClick={() => setFullscreenCard(card)}
							>
									<CardPreview card={card} />
								</div>
							</div>

							{card.caption !== undefined && (
								<input
									className="node-caption"
									value={card.caption}
									autoFocus={card.caption.length === 0}
									placeholder="Add a note below this card…"
									onPointerDown={(event) => event.stopPropagation()}
									onChange={(event) => updateCard(card.id, { caption: event.target.value })}
								/>
							)}

							{selected &&
								(["nw", "ne", "se", "sw"] as ResizeCorner[]).map((corner) => (
									<button
										key={corner}
										className={`resize-handle ${corner}`}
										aria-label={`Resize from ${corner}`}
										onPointerDown={(event) => startCardResize(event, card, corner)}
									/>
								))}

							{linkMode &&
								SIDES.map((side) => (
									<button
										key={side}
										className={`connect-port ${side}`}
										aria-label={`Connect from ${side}`}
										onPointerDown={(event) => startLink(event, { objectId: card.id, side, t: 0.5 })}
									/>
								))}
						</div>
					);
				})}

				{(() => {
					const cursor = toLocal(agentCursor.x, agentCursor.y);
					return (
						<div
							className={`agent-cursor ${agentCursor.mode}`}
							style={{
								transform: `translate(${cursor.x}px, ${cursor.y}px)`,
								transitionDuration: `${agentCursor.durationMs}ms`,
							}}
						>
							<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
								<path d="M2 2 L2 18 L7 13 L10 20 L13 18.5 L9.5 12 L17 12 Z" />
							</svg>
							<span className="agent-label">
								<span className="agent-presence" />
								AXIOM {agentCursor.mode}
							</span>
						</div>
					);
				})()}
			</div>

			<section
				className={`space-agent-orb${agentBusy || agentOrbOpen ? " expanded" : " idle"}`}
				data-space-vision-exclude
				aria-label="AXIOM Space agent"
				aria-live="polite"
			>
				<button
					className={`orb-core${agentBusy ? " working" : ""}`}
					onClick={() => setAgentOrbOpen((open) => !open)}
					aria-label={agentOrbOpen ? "Collapse Space agent" : "Expand Space agent"}
					title={agentOrbOpen ? "Collapse AXIOM" : "Open AXIOM"}
				>
					<span className="orb-star"><AxiomMark size={20} dark /></span>
				</button>
				<div className="orb-content">
					<div className="orb-copy">
						<div className="orb-title">{agentBusy ? "AXIOM is working" : "AXIOM in Space"}</div>
						<div className="orb-message">{agentMessage}</div>
					</div>
					{agentActivity.length > 0 && (
						<details className="sap-steps" open={agentBusy}>
							<summary>View steps <span>{agentActivity.length}</span></summary>
							<div className="sap-step-list">
								{agentActivity.slice(-10).map((item) => (
									<div key={item.id} className={`sap-step ${item.status}`}>
										<span className="sap-step-dot" />
										<span>{item.label}</span>
										<b>{item.status === "running" ? "working" : item.status}</b>
									</div>
								))}
							</div>
						</details>
					)}
				</div>
			</section>

				<div className="space-composer" data-space-vision-exclude>
				<textarea
					rows={1}
					value={agentInput}
					onChange={(event) => setAgentInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void runAgent();
						}
					}}
					placeholder="Ask AXIOM to draw, organize, connect, resize, or explain…"
					aria-label="Message AXIOM in Space"
					disabled={agentBusy}
				/>
				<div className="space-composer-bar">
					<div className="space-composer-left">
						<span className="space-status"><span /> Live board vision on</span>
						<span className="space-shortcut">Ctrl-drag to connect</span>
					</div>
					<div className="space-composer-right">
						<span className="space-model">{spaceModel}</span>
							<button
								className="sc-transfer"
								onClick={() => void transferToChat()}
								disabled={transferring || agentBusy}
								title="Capture the whole board and continue it in Chat (writes DESIGN.md if it's a design)"
							>
								{transferring ? "Capturing…" : "Transfer to Chat"} <span aria-hidden="true">→</span>
							</button>
							<button
								className={`sc-send${agentBusy ? " stop" : ""}`}
								onClick={() => void (agentBusy ? stopAgent() : runAgent())}
								disabled={!agentBusy && !agentInput.trim()}
							>
								{agentBusy ? "Stop" : "Send"} <span>{agentBusy ? "■" : "↑"}</span>
							</button>
					</div>
				</div>
				<div className="space-attribution" data-space-vision-exclude>*Space is built on top of Excalidraw.</div>
			</div>

			{fullscreenCard && (
				<div className="card-fullscreen" role="dialog" aria-modal="true" aria-label={`Preview ${fullscreenCard.name}`} onClick={() => setFullscreenCard(null)}>
					<div className="card-fs-inner" onClick={(e) => e.stopPropagation()}>
						<div className="card-fs-head">
							<span className="card-fs-name">{fullscreenCard.name}</span>
							{fullscreenCard.path && (fullscreenCard.kind === "code" || fullscreenCard.kind === "artifact") && (
								<button className="card-fs-tool" onClick={() => void openCardInLsp(fullscreenCard)}>Open LSP</button>
							)}
							<button className="card-fs-close" aria-label="Close preview" onClick={() => setFullscreenCard(null)}>✕</button>
						</div>
						<div className="card-fs-body">
							<CardPreview card={fullscreenCard} expanded />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
