import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentHistoryMessage, AgentPermissionMode, AgentSlashCommand, AgentThinkingLevel } from "../bridge";
import { AxiomMark } from "../shell/Logo.tsx";
import "./Chat.css";

// Chat surface — a GUI client over the REAL AXIOM agent (@axiom/coding-agent) running
// in RPC mode. Streams genuine agent events: narration text, thinking, and tool runs.

interface Attach {
	name: string;
	mime: string;
	isImage: boolean;
	data?: string;
}

interface ToolStep {
	id: string;
	name: string;
	status: "running" | "done" | "error";
	detail?: string;
	file?: string;
	output?: string;
	diff?: string;
	additions?: number;
	deletions?: number;
}

interface Msg {
	role: "user" | "assistant";
	text: string;
	time: number;
	thinking?: string;
	steps?: ToolStep[];
	streaming?: boolean;
	attachments?: Attach[];
}

let chatSequence = 0;
let activeChatId: string | null = null;

interface UiRequest {
	id: string;
	method: "select" | "multiSelect" | "confirm" | "input" | "editor";
	title: string;
	options?: string[];
	message?: string;
	placeholder?: string;
	prefill?: string;
}

interface ComposerCommand extends AgentSlashCommand {
	keywords: string;
}

const THINKING_LEVELS: AgentThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const VISIBLE_EFFORT_LEVELS: AgentThinkingLevel[] = ["low", "medium", "high", "xhigh"];
const CODEX_MODEL_OPTIONS = [
	{ id: "gpt-5.5", label: "GPT-5.5", speed: "Deep" },
	{ id: "gpt-5.4", label: "GPT-5.4", speed: "Balanced" },
	{ id: "gpt-5.4-mini", label: "GPT-5.4-Mini", speed: "Fast" },
] as const;
const PERMISSION_MODES: Array<{
	mode: AgentPermissionMode;
	label: string;
	description: string;
	icon: string;
}> = [
	{ mode: "ask", label: "Ask before edits", description: "Read freely; edits and commands ask for approval before running.", icon: "◷" },
	{ mode: "edit", label: "Edit automatically", description: "Allow file edits, but keep shell/test commands disabled.", icon: "</>" },
	{ mode: "plan", label: "Plan mode", description: "Explore safely and return a plan before implementation.", icon: "▤" },
	{ mode: "auto", label: "Auto mode", description: "AXIOM chooses the best available tool permissions for the task.", icon: "⚡" },
	{ mode: "bypass", label: "Bypass permissions", description: "Do not restrict agent tools from the desktop permission layer.", icon: "⌘" },
];
const RESTRICTED_MUTATION_TOOLS = new Set(["edit", "write"]);
const RESTRICTED_COMMAND_TOOLS = new Set(["bash", "execute_code", "playwright_cli", "benchmark_test"]);
const DESKTOP_SLASH_COMMANDS = new Set([
	"changelog",
	"clone",
	"compact",
	"copy",
	"export",
	"fork",
	"goal",
	"help",
	"hotkeys",
	"import",
	"login",
	"logout",
	"list_sessions",
	"model",
	"name",
	"new",
	"quit",
	"reasoning",
	"reload",
	"resume",
	"scoped-models",
	"session",
	"sessions",
	"settings",
	"share",
	"steer",
	"tree",
]);

marked.setOptions({ breaks: true, gfm: true });

function renderMd(text: string): string {
	try {
		return marked.parse(text) as string;
	} catch {
		return text;
	}
}

function readImage(file: File): Promise<string> {
	return new Promise((resolve) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
		r.readAsDataURL(file);
	});
}

function extract(content: unknown): { text: string; thinking: string } {
	let text = "";
	let thinking = "";
	if (Array.isArray(content)) {
		for (const b of content as Array<Record<string, unknown>>) {
			if (b.type === "text") text += (b.text as string) ?? "";
			else if (b.type === "thinking") thinking += (b.thinking as string) ?? "";
		}
	} else if (typeof content === "string") {
		text = content;
	}
	return { text, thinking };
}

function formatClock(time: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(time);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function toolLabel(name: string): string {
	const normalized = name.toLowerCase();
	if (normalized.includes("web") || normalized.includes("research")) return "Searched the web";
	if (normalized.includes("playwright") || normalized.includes("browser")) return "Used the browser";
	if (normalized === "read" || normalized.includes("read_file")) return "Read a file";
	if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) return "Edited a file";
	if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("find")) return "Searched the workspace";
	if (normalized.includes("bash") || normalized.includes("terminal") || normalized.includes("command")) return "Ran a command";
	if (normalized.includes("todo") || normalized.includes("plan")) return "Updated the plan";
	return name.replaceAll("_", " ");
}

function toolIcon(name: string): string {
	const normalized = name.toLowerCase();
	if (normalized.includes("web") || normalized.includes("research")) return "◎";
	if (normalized.includes("playwright") || normalized.includes("browser")) return "◌";
	if (normalized === "read" || normalized.includes("read_file")) return "◱";
	if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) return "✎";
	if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("find")) return "⌕";
	if (normalized.includes("bash") || normalized.includes("terminal") || normalized.includes("command")) return "▸";
	if (normalized.includes("todo") || normalized.includes("plan")) return "☷";
	return "◇";
}

function toolTone(name: string): string {
	const normalized = name.toLowerCase();
	if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) return "edit";
	if (normalized.includes("bash") || normalized.includes("terminal") || normalized.includes("command")) return "command";
	if (normalized.includes("web") || normalized.includes("research") || normalized.includes("browser")) return "research";
	if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("find") || normalized === "read") return "read";
	return "default";
}

function toolDetail(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const values = args as Record<string, unknown>;
	const normalized = name.toLowerCase();
	const value = normalized.includes("bash") || normalized.includes("command")
		? values.command
		: normalized.includes("grep") || normalized.includes("search")
			? values.pattern ?? values.query
			: values.path ?? values.filePath ?? values.target;
	return typeof value === "string" && value.trim() ? value.trim().replaceAll("\n", " ").slice(0, 120) : undefined;
}

function toolFile(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const values = args as Record<string, unknown>;
	const value = values.path ?? values.file_path ?? values.filePath ?? values.target;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolSummary(steps: ToolStep[]): string {
	const groups = new Map<string, number>();
	for (const step of steps) {
		const label = toolLabel(step.name);
		groups.set(label, (groups.get(label) ?? 0) + 1);
	}
	return Array.from(groups.entries())
		.map(([label, count]) => count > 1 ? `${label.replace(/^Read a file$/, "Read files")} (${count})` : label)
		.join(", ");
}

function toolOutput(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const values = result as Record<string, unknown>;
	const content = values.content ?? values.details ?? values;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object" && "text" in item) {
					return String((item as { text?: unknown }).text ?? "");
				}
				try {
					return JSON.stringify(item);
				} catch {
					return "";
				}
			})
			.filter(Boolean)
			.join("\n");
	} else {
		try {
			text = JSON.stringify(content, null, 2);
		} catch {
			return undefined;
		}
	}
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}\n...` : trimmed;
}

function toolDiff(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as Record<string, unknown>).details;
	if (!details || typeof details !== "object") return undefined;
	const diff = (details as Record<string, unknown>).diff;
	return typeof diff === "string" && diff.trim() ? diff : undefined;
}

function diffStats(diff: string | undefined): { additions: number; deletions: number } | undefined {
	if (!diff) return undefined;
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

function shortFile(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const normalized = path.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts.slice(-2).join("/") || path;
}

function diffLineClass(line: string): string {
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+") && !line.startsWith("+++")) return "add";
	if (line.startsWith("-") && !line.startsWith("---")) return "del";
	if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) return "meta";
	return "ctx";
}

function DiffPreview({ step }: { step: ToolStep }) {
	if (!step.diff) return null;
	const lines = step.diff.split("\n").slice(0, 420);
	return (
		<div className="diff-preview">
			<div className="diff-head">
				<span>{shortFile(step.file) ?? step.detail ?? "Edited file"}</span>
				<span>
					{typeof step.additions === "number" && <b className="diff-add">+{step.additions}</b>}
					{typeof step.deletions === "number" && <b className="diff-del">-{step.deletions}</b>}
				</span>
			</div>
			<div className="diff-lines">
				{lines.map((line, index) => (
					<div key={`${index}:${line}`} className={`diff-line ${diffLineClass(line)}`}>
						<span className="diff-line-no">{index + 1}</span>
						<code>{line || " "}</code>
					</div>
				))}
				{lines.length < step.diff.split("\n").length && <div className="diff-truncated">Diff truncated for display.</div>}
			</div>
		</div>
	);
}

function splitOption(option: string): { label: string; description?: string } {
	const [label, ...rest] = option.split(" — ");
	return { label: label.trim(), description: rest.join(" — ").trim() || undefined };
}

function getSlashQuery(input: string, cursor: number): string | null {
	if (!input.startsWith("/")) return null;
	const firstLine = input.split("\n", 1)[0] ?? "";
	const tokenEnd = firstLine.search(/\s/);
	if (tokenEnd !== -1 && cursor > tokenEnd) return null;
	return firstLine.slice(1).split(/\s/, 1)[0].toLowerCase();
}

function getGoalDraft(input: string): string | null {
	if (!input.startsWith("/goal")) return null;
	const text = input.replace(/^\/goal\s*/i, "").trim();
	return text || "Set a concrete objective for this session.";
}

function getSlashName(input: string): string | undefined {
	if (!input.startsWith("/")) return undefined;
	return input.slice(1).split(/\s/, 1)[0]?.trim() || undefined;
}

function visibleUserText(text: string): string {
	const cleaned = stripInternalUserPrefixes(text);
	const skill = /^\/skill:([^\s]+)\s*(.*)$/s.exec(cleaned);
	if (skill) return skill[2]?.trim() || `Using skill ${skill[1]}`;
	const command = /^\/([^\s]+)\s*(.*)$/s.exec(cleaned);
	if (command && command[2]?.trim()) return command[2].trim();
	return cleaned;
}

function stripInternalUserPrefixes(text: string): string {
	return text.replace(/^<axiom_permission_mode\b[\s\S]*?<\/axiom_permission_mode>\s*/i, "").trim();
}

function isInternalChatText(text: string): boolean {
	const trimmed = text.trim();
	const lower = trimmed.toLowerCase();
	return (
		lower.startsWith("<axiom_space_canvas_request>") ||
		trimmed.startsWith("You are operating the AXIOM Space") ||
		trimmed.startsWith("User request from the Space canvas.") ||
		trimmed.startsWith("You are AXIOM's whiteboard.") ||
		trimmed.includes("Use space_snapshot to read the current board") ||
		trimmed.includes("Use space_node for visible work products") ||
		trimmed.includes("Do not produce a chat-facing answer") && trimmed.includes("space_* tools") ||
		trimmed.includes('"method":"host_call"') ||
		trimmed.includes("space_snapshot") && trimmed.includes("space_draw") && trimmed.includes("space_node")
	);
}

function permissionModeLabel(mode: AgentPermissionMode): string {
	return PERMISSION_MODES.find((item) => item.mode === mode)?.label ?? "Auto mode";
}

function isPermissionMode(value: string | null): value is AgentPermissionMode {
	return PERMISSION_MODES.some((item) => item.mode === value);
}

function readPermissionMode(): AgentPermissionMode {
	const saved = localStorage.getItem("axiom.permissionMode");
	return isPermissionMode(saved) ? saved : "auto";
}

function permissionModePrompt(mode: AgentPermissionMode): string {
	const selected = PERMISSION_MODES.find((item) => item.mode === mode);
	return [
		`<axiom_permission_mode mode="${mode}">`,
		`Desktop permission mode: ${selected?.label ?? mode}.`,
		selected?.description ?? "",
		mode === "ask" ? "Permission-sensitive tool calls may be requested, but the runtime will pause for user approval before executing them." : "",
		mode === "plan" ? "Do not edit files or run commands. Inspect what you can and return a concrete plan." : "",
		`</axiom_permission_mode>`,
	].filter(Boolean).join("\n");
}

function toolsForPermissionMode(mode: AgentPermissionMode, toolNames: string[]): string[] {
	if (mode === "ask" || mode === "bypass") return toolNames;
	const blocked = new Set<string>(RESTRICTED_COMMAND_TOOLS);
	if (mode === "plan") {
		for (const tool of RESTRICTED_MUTATION_TOOLS) blocked.add(tool);
	}
	return toolNames.filter((name) => !blocked.has(name));
}

function resolveAutoPermissionMode(prompt: string): AgentPermissionMode {
	const text = prompt.toLowerCase();
	if (/\b(run|test|smoke|debug|trace|benchmark|browser|playwright|npm|pnpm|yarn|cargo|pytest|tsc|lint|check)\b/.test(text)) {
		return "bypass";
	}
	if (/\b(fix|patch|edit|change|update|implement|build|create|write|add|remove|delete|rename|refactor)\b/.test(text)) {
		return "edit";
	}
	if (/\b(plan|review|inspect|analy[sz]e|explain|audit|look\s+at|read)\b/.test(text)) {
		return "plan";
	}
	return "ask";
}

function formatThinkingLevel(level: AgentThinkingLevel): string {
	if (level === "xhigh") return "Extra High";
	return `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
}

function compactModelName(modelId: string): string {
	const match = /^gpt-(\d+(?:\.\d+)?)(?:-(mini|nano|pro))?$/i.exec(modelId.trim());
	if (!match) return modelId;
	const suffix = match[2] ? ` ${match[2][0]?.toUpperCase()}${match[2].slice(1)}` : "";
	return `${match[1]}${suffix}`;
}

function labelForCodexModel(modelId: string): string {
	return CODEX_MODEL_OPTIONS.find((model) => model.id === modelId)?.label ?? compactModelName(modelId);
}

function buildSpaceHandoff(messages: Msg[], draft: string, workspaceName?: string): string {
	const recent = messages
		.filter((message) => message.text.trim())
		.slice(-8)
		.map((message) => {
			const role = message.role === "user" ? "User" : "AXIOM";
			const text = message.text.replace(/\s+/g, " ").trim().slice(0, 900);
			return `${role}: ${text}`;
		});
	const parts = [
		"Continue this Chat session inside Space.",
		"Create useful Space objects from the conversation: task nodes, plan nodes, research/artifact notes, and links between them. Preserve concrete user intent and current status. Do not expose hidden chain-of-thought.",
		workspaceName ? `Workspace: ${workspaceName}` : "",
		recent.length ? `Recent chat transcript:\n${recent.join("\n")}` : "",
		draft.trim() ? `Current unsent draft:\n${draft.trim()}` : "",
	].filter(Boolean);
	return parts.join("\n\n");
}

function parseThinkingLevel(text: string): AgentThinkingLevel | undefined {
	const [, raw = ""] = text.trim().split(/\s+/, 2);
	return THINKING_LEVELS.includes(raw as AgentThinkingLevel) ? raw as AgentThinkingLevel : undefined;
}

function historyMessage(message: AgentHistoryMessage): Msg {
	const { text, thinking } = extract(message.content);
	const steps: ToolStep[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block.type !== "toolCall") continue;
			const name = String(block.name ?? "tool");
			steps.push({
				id: String(block.id ?? `${name}_${steps.length}`),
				name,
				status: "done",
				detail: toolDetail(name, block.arguments),
			});
		}
	}
	return {
		role: message.role,
		text: message.role === "user" ? visibleUserText(text) : text,
		thinking: thinking || undefined,
		steps: steps.length ? steps : undefined,
		time: Number.isFinite(Date.parse(message.time)) ? Date.parse(message.time) : Date.now(),
	};
}

function shouldShowHistoryMessage(message: AgentHistoryMessage): boolean {
	const { text } = extract(message.content);
	return !isInternalChatText(text);
}

function visibleHistory(history: AgentHistoryMessage[]): AgentHistoryMessage[] {
	const visible: AgentHistoryMessage[] = [];
	let suppressAssistant = false;
	for (const message of history) {
		const { text } = extract(message.content);
		if (message.role === "user" && isInternalChatText(text)) {
			suppressAssistant = true;
			continue;
		}
		if (suppressAssistant && message.role === "assistant") {
			suppressAssistant = false;
			continue;
		}
		if (!shouldShowHistoryMessage(message)) continue;
		visible.push(message);
		if (message.role === "user") suppressAssistant = false;
	}
	return visible;
}

function CopyBtn({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			className="copy-btn"
			title="Copy"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1800);
				});
			}}
		>
			{copied ? "✓" : "⎘"}
		</button>
	);
}

export function Chat({
	onOpenSpace,
	sessionKey,
	onSessionChanged,
	workspaceName,
}: {
	onOpenSpace?: (handoff?: { text: string }) => void;
	sessionKey?: string;
	onSessionChanged?: () => void;
	workspaceName?: string;
}) {
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [attachments, setAttachments] = useState<Attach[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	const [modelName, setModelName] = useState("GPT-5.5");
	const [activeModelId, setActiveModelId] = useState("gpt-5.5");
	const [dragOver, setDragOver] = useState(false);
	const [uiRequest, setUiRequest] = useState<UiRequest | null>(null);
	const [uiAnswer, setUiAnswer] = useState("");
	const [uiSelections, setUiSelections] = useState<string[]>([]);
	const [commands, setCommands] = useState<ComposerCommand[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [activeCommandIndex, setActiveCommandIndex] = useState(0);
	const [thinkingLevel, setThinkingLevel] = useState<AgentThinkingLevel>("medium");
	const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
	const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(() => readPermissionMode());
	const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
	const [permissionStatus, setPermissionStatus] = useState("");
	const [activeGoal, setActiveGoal] = useState<string | undefined>();
	const [goalStartedAt, setGoalStartedAt] = useState<number | undefined>();
	const [now, setNow] = useState(Date.now());
	const [goalPaused, setGoalPaused] = useState(false);
	const [goalCollapsed, setGoalCollapsed] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [chatId] = useState(() => `chat_${(chatSequence += 1)}`);
	const suppressInternalTurn = useRef(false);
	const slashQuery = getSlashQuery(input, cursorPosition);
	const goalDraft = getGoalDraft(input);
	const filteredCommands = slashQuery === null
		? []
		: commands
				.filter((command) => command.keywords.includes(slashQuery));

	const acc = useRef({ committedText: "", committedThinking: "", curText: "", curThinking: "" });
	// The agent runs nested loops (preflight/classification + the real turn), so it
	// emits several agent_start/agent_end pairs per prompt. Count depth and only
	// clear "busy" (flip Stop→Send) when the OUTERMOST agent_end fires — otherwise
	// the Stop button vanishes after the first inner loop (~1s in).
	const agentDepth = useRef(0);

	function paintActive(patch?: (m: Msg) => Msg) {
		setMessages((cur) => {
			const next = [...cur];
			const i = next.length - 1;
			if (i < 0 || next[i].role !== "assistant") return cur;
			const a = acc.current;
			let m: Msg = {
				...next[i],
				text: a.committedText + a.curText,
				thinking: (a.committedThinking + a.curThinking) || undefined,
			};
			if (patch) m = patch(m);
			next[i] = m;
			return next;
		});
	}

	// Auto-resize textarea
	function resizeTextarea() {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	}

	function syncActiveGoal(nextGoal: string | undefined) {
		setActiveGoal((current) => {
			if (current !== nextGoal) setGoalStartedAt(nextGoal ? Date.now() : undefined);
			return nextGoal;
		});
	}

	async function applyPermissionMode(mode: AgentPermissionMode): Promise<void> {
		setPermissionMode(mode);
		setPermissionMenuOpen(false);
		localStorage.setItem("axiom.permissionMode", mode);
		setPermissionStatus("Applying…");
		try {
			await window.axiom?.agent.setToolPermissionMode(mode);
			const allTools = await window.axiom?.agent.getAllTools();
			const nextTools = toolsForPermissionMode(mode, allTools ?? []);
			const applied = await window.axiom?.agent.setActiveTools(nextTools);
			setPermissionStatus(mode === "auto" ? "Prompt-aware" : `${applied?.length ?? nextTools.length} tools`);
		} catch (error) {
			setPermissionStatus(error instanceof Error ? error.message : "Could not apply");
		}
	}

	async function enforcePermissionForPrompt(prompt: string): Promise<AgentPermissionMode> {
		const effectiveMode = permissionMode === "auto" ? resolveAutoPermissionMode(prompt) : permissionMode;
		try {
			await window.axiom.agent.setToolPermissionMode(effectiveMode);
			const allTools = await window.axiom.agent.getAllTools();
			const nextTools = toolsForPermissionMode(effectiveMode, allTools);
			const applied = await window.axiom.agent.setActiveTools(nextTools);
			setPermissionStatus(
				permissionMode === "auto"
					? `Auto: ${permissionModeLabel(effectiveMode)}`
					: `${applied.length} tools`,
			);
		} catch (error) {
			setPermissionStatus(error instanceof Error ? error.message : "Could not apply");
		}
		return effectiveMode;
	}

	function cyclePermissionMode(): void {
		const index = PERMISSION_MODES.findIndex((item) => item.mode === permissionMode);
		const next = PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length] ?? PERMISSION_MODES[0];
		void applyPermissionMode(next.mode);
	}

	function cycleThinkingLevel(): void {
		const index = THINKING_LEVELS.findIndex((level) => level === thinkingLevel);
		const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length] ?? "medium";
		void chooseThinkingLevel(next);
	}

	async function refreshModelFromSettings(): Promise<void> {
		try {
			const env = await window.axiom?.settings.read();
			const modelId = env?.AXIOM_PRIMARY_MODEL || "gpt-5.5";
			setActiveModelId(modelId);
			setModelName(env?.AXIOM_PRIMARY_PROVIDER === "openai-codex" ? labelForCodexModel(modelId) : modelId);
		} catch {
			try {
				const cfg = await window.axiom?.config();
				if (cfg?.agentModel) setModelName(cfg.agentModel);
			} catch {
				// best effort only
			}
		}
	}

	useEffect(() => {
		void refreshModelFromSettings();
		void window.axiom?.agent.state().then((state) => {
			setThinkingLevel(state.thinkingLevel);
			syncActiveGoal(state.backgroundGoal);
		}).catch(() => {});
		void applyPermissionMode(permissionMode);
	}, []);

	useEffect(() => {
		if (!activeGoal || !goalStartedAt || goalPaused) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [activeGoal, goalPaused, goalStartedAt]);

	useEffect(() => {
		let cancelled = false;
		void window.axiom?.agent.commands().then((items) => {
			if (cancelled) return;
			setCommands(items.map((item) => ({
				...item,
				keywords: `${item.name} ${item.description ?? ""} ${item.source}`.toLowerCase(),
			})));
		}).catch(() => {
			if (!cancelled) {
				setCommands([
					{ name: "goal", description: "Set or update the active working goal", source: "builtin", keywords: "goal set objective working session" },
					{ name: "compact", description: "Compact this session context", source: "builtin", keywords: "compact context" },
					{ name: "new", description: "Start a new chat session", source: "builtin", keywords: "new chat session" },
					{ name: "session", description: "Show current session info", source: "builtin", keywords: "session id status cwd messages" },
					{ name: "sessions", description: "List recent saved sessions", source: "builtin", keywords: "sessions list recent chats saved resume" },
					{ name: "list_sessions", description: "List recent saved sessions", source: "builtin", keywords: "list sessions recent chats saved resume" },
					{ name: "reasoning", description: "Change reasoning effort", source: "builtin", keywords: "reasoning effort thinking level" },
					{ name: "model", description: "Show the active model", source: "builtin", keywords: "model active provider" },
					{ name: "name", description: "Rename this session", source: "builtin", keywords: "name rename title session" },
					{ name: "export", description: "Export this session to HTML", source: "builtin", keywords: "export html share transcript" },
					{ name: "copy", description: "Copy the latest assistant reply", source: "builtin", keywords: "copy latest assistant reply clipboard" },
					{ name: "reload", description: "Reload settings, skills, prompts, and themes", source: "builtin", keywords: "reload settings skills prompts themes" },
					{ name: "hotkeys", description: "Show keyboard shortcuts", source: "builtin", keywords: "hotkeys shortcuts keyboard help" },
					{ name: "help", description: "Show AXIOM command help", source: "builtin", keywords: "help commands" },
				]);
			}
		});
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		setActiveCommandIndex(0);
	}, [slashQuery]);

	useEffect(() => {
		if (filteredCommands.length === 0) {
			setActiveCommandIndex(0);
			return;
		}
		setActiveCommandIndex((index) => Math.min(index, filteredCommands.length - 1));
	}, [filteredCommands.length]);

	useEffect(() => {
		let cancelled = false;
		setBusy(false);
		setUiRequest(null);
		setMessages([]);
		acc.current = { committedText: "", committedThinking: "", curText: "", curThinking: "" };
		void window.axiom?.agent.history().then((history) => {
			if (!cancelled) setMessages(visibleHistory(history).map(historyMessage));
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [sessionKey]);

	useEffect(() => {
		const off = window.axiom?.agent?.onEvent((e: AgentEvent) => {
			if (e.type === "extension_ui_request") {
				const request = e as AgentEvent & Partial<UiRequest>;
				if (["select", "multiSelect", "confirm", "input", "editor"].includes(String(request.method))) {
					setUiAnswer(String(request.prefill ?? ""));
					setUiSelections([]);
					setUiRequest({
						id: String(request.id),
						method: request.method as UiRequest["method"],
						title: String(request.title ?? "AXIOM needs your input"),
						options: Array.isArray(request.options) ? request.options.map(String) : undefined,
						message: typeof request.message === "string" ? request.message : undefined,
						placeholder: typeof request.placeholder === "string" ? request.placeholder : undefined,
						prefill: typeof request.prefill === "string" ? request.prefill : undefined,
					});
				}
				return;
			}
			if (e.type === "session_info_changed") {
				onSessionChanged?.();
				return;
			}
			// Stream events belong to whichever Chat is currently mounted. We used
			// to gate on `activeChatId === chatId`, but a hot-reload / remount gives
			// the component a NEW chatId while the global still held the old one, so
			// every event was dropped and the reply never rendered. Since only one
			// Chat mounts at a time, claim ownership here instead of dropping.
			if (activeChatId !== chatId) activeChatId = chatId;
			const msg = (e as { message?: { role?: string; content?: unknown } }).message;
			switch (e.type) {
				case "message_start": {
					if (msg?.role === "user") {
						const { text } = extract(msg.content);
						if (isInternalChatText(text)) {
							suppressInternalTurn.current = true;
							return;
						}
					}
					if (suppressInternalTurn.current) break;
					if (msg?.role === "assistant") {
						acc.current.committedText += acc.current.curText;
						acc.current.committedThinking += acc.current.curThinking;
						acc.current.curText = "";
						acc.current.curThinking = "";
					}
					break;
				}
				case "message_update": {
					if (suppressInternalTurn.current) break;
					if (msg?.role === "assistant") {
						const { text, thinking } = extract(msg.content);
						acc.current.curText = text;
						acc.current.curThinking = thinking;
						paintActive();
					}
					break;
				}
				case "message_discard": {
					if (suppressInternalTurn.current) break;
					acc.current.curText = "";
					acc.current.curThinking = "";
					paintActive();
					break;
				}
				case "message_end": {
					if (suppressInternalTurn.current) break;
					if (msg?.role === "assistant") {
						const { text, thinking } = extract(msg.content);
						acc.current.curText = text;
						acc.current.curThinking = thinking;
						paintActive();
					}
					break;
				}
				case "tool_execution_start": {
					if (suppressInternalTurn.current) break;
					const id = String((e as { toolCallId?: string }).toolCallId ?? Math.random());
					const name = String((e as { toolName?: string }).toolName ?? "tool");
					const args = (e as { args?: unknown; arguments?: unknown }).args ?? (e as { arguments?: unknown }).arguments;
					paintActive((m) => ({
						...m,
						steps: [
							...(m.steps ?? []),
							{ id, name, status: "running", detail: toolDetail(name, args), file: toolFile(args) },
						],
					}));
					break;
				}
				case "tool_execution_end": {
					if (suppressInternalTurn.current) break;
					const id = String((e as { toolCallId?: string }).toolCallId ?? "");
					const isError = Boolean((e as { isError?: boolean }).isError);
					const output = toolOutput((e as { result?: unknown }).result);
					const diff = toolDiff((e as { result?: unknown }).result);
					const stats = diffStats(diff);
					paintActive((m) => ({
						...m,
						steps: (m.steps ?? []).map((s) =>
							s.id === id
								? {
										...s,
										status: isError ? "error" : "done",
										output,
										diff,
										additions: stats?.additions,
										deletions: stats?.deletions,
									}
								: s,
						),
					}));
					break;
				}
				case "agent_start": {
					agentDepth.current += 1;
					break;
				}
				case "agent_end": {
					acc.current.committedText += acc.current.curText;
					acc.current.committedThinking += acc.current.curThinking;
					acc.current.curText = "";
					acc.current.curThinking = "";
					agentDepth.current = Math.max(0, agentDepth.current - 1);
					// Only the outermost agent_end means the whole prompt is done.
					// Inner loops (preflight/classification) keep Stop visible.
					if (agentDepth.current > 0) break;
					suppressInternalTurn.current = false;
					paintActive((m) => ({ ...m, streaming: false }));
					setBusy(false);
					activeChatId = null;
					onSessionChanged?.();
					break;
				}
				case "rpc_error":
				case "rpc_exit": {
					suppressInternalTurn.current = false;
					const err = String((e as { error?: string }).error ?? "the agent stopped unexpectedly");
					paintActive((m) => ({ ...m, text: `${m.text}\n\n⚠️ ${err}`.trim(), streaming: false }));
					setBusy(false);
					activeChatId = null;
					break;
				}
				case "response": {
					if ((e as { success?: boolean }).success === false) {
						suppressInternalTurn.current = false;
						const err = String((e as { error?: string }).error ?? "request failed");
						paintActive((m) => ({ ...m, text: `${m.text}\n\n⚠️ ${err}`.trim(), streaming: false }));
						setBusy(false);
						activeChatId = null;
					}
					break;
				}
			}
		});
		return () => {
			off?.();
			if (activeChatId === chatId) {
				activeChatId = null;
			}
		};
	}, [chatId, onSessionChanged]);

	// Scroll to bottom on new messages
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (isNearBottom || busy) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, [messages, busy]);

	async function onFiles(list: FileList | File[] | null) {
		if (!list) return;
		const next: Attach[] = [];
		for (const file of Array.from(list)) {
			const isImage = file.type.startsWith("image/");
			next.push({
				name: file.name,
				mime: file.type || "application/octet-stream",
				isImage,
				data: isImage ? await readImage(file) : undefined,
			});
		}
		setAttachments((a) => [...a, ...next]);
	}

	async function pickFolder() {
		try {
			const res = await window.axiom?.ide?.openFolder();
			if (res) {
				await window.axiom.agent.setFolder(res.root);
				setFolder(res.name);
			}
		} catch (error) {
			setMessages((cur) => [
				...cur,
				{
					role: "assistant",
					text: `Could not open the folder: ${error instanceof Error ? error.message : String(error)}`,
					time: Date.now(),
				},
			]);
		}
	}

	async function send() {
		const text = input.trim();
		// `busy` already guards against sending while a reply is streaming. We no
		// longer bail on `activeChatId` — a stale global left by a remount used to
		// deadlock send permanently.
		if ((!text && attachments.length === 0) || busy) return;
		if (!window.axiom?.agent) return;
		const slashName = getSlashName(text);
		const slashCommand = slashName ? commands.find((command) => command.name === slashName) : undefined;
		if (((slashCommand?.source === "builtin") || (slashName ? DESKTOP_SLASH_COMMANDS.has(slashName) : false)) && attachments.length === 0) {
			setInput("");
			setCursorPosition(0);
			if (textareaRef.current) textareaRef.current.style.height = "auto";
			try {
				const result = await window.axiom.agent.runSlashCommand(text);
				if (result.copyText) {
					await navigator.clipboard.writeText(result.copyText).catch(() => {});
				}
				if (slashName === "goal") {
					const state = await window.axiom.agent.state().catch(() => undefined);
					syncActiveGoal(state?.backgroundGoal);
					setGoalPaused(false);
					setGoalCollapsed(false);
				}
				if (slashName === "reasoning") {
					const level = parseThinkingLevel(text);
					if (level) setThinkingLevel(level);
				}
				setMessages((cur) => [
					...cur,
					{ role: "assistant", text: result.message, time: Date.now() },
				]);
				if (slashName === "new" || slashName === "goal" || slashName === "name") onSessionChanged?.();
			} catch (error) {
				setMessages((cur) => [
					...cur,
					{
						role: "assistant",
						text: `Could not run ${text}: ${error instanceof Error ? error.message : String(error)}`,
						time: Date.now(),
					},
				]);
			}
			return;
		}
		activeChatId = chatId;
		setInput("");
		setCursorPosition(0);
		if (textareaRef.current) textareaRef.current.style.height = "auto";
		const atts = attachments;
		setAttachments([]);
		const noteFiles = atts.filter((a) => !a.isImage).map((a) => a.name);
		const fullText = noteFiles.length ? `${text}\n\n[Attached: ${noteFiles.join(", ")}]` : text;
		const displayText = visibleUserText(fullText);
		const effectivePermissionMode = await enforcePermissionForPrompt(fullText || "(see attachments)");
		const agentText = `${permissionModePrompt(effectivePermissionMode)}\n\n${fullText || "(see attachments)"}`;
		setMessages((cur) => [
			...cur,
			{ role: "user", text: displayText || "(see attachments)", attachments: atts, time: Date.now() },
			{ role: "assistant", text: "", steps: [], streaming: true, time: Date.now() },
		]);
		acc.current = { committedText: "", committedThinking: "", curText: "", curThinking: "" };
		agentDepth.current = 0;
		setBusy(true);
		const images = atts.filter((a) => a.isImage && a.data).map((a) => ({ mimeType: a.mime, data: a.data! }));
		try {
			await window.axiom.agent.prompt(agentText, images);
			if (messages.length === 0 && text) {
				void window.axiom.agent.setSessionName(text.replaceAll("\n", " ").slice(0, 64)).then(() => onSessionChanged?.());
			}
		} catch (error) {
			paintActive((m) => ({
				...m,
				text: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
				streaming: false,
			}));
			setBusy(false);
			activeChatId = null;
		}
	}

	async function answerUi(value: string | string[] | boolean, cancelled = false) {
		if (!uiRequest) return;
		const response = cancelled
			? { id: uiRequest.id, cancelled: true }
			: uiRequest.method === "confirm"
				? { id: uiRequest.id, confirmed: Boolean(value) }
				: uiRequest.method === "multiSelect"
					? { id: uiRequest.id, values: Array.isArray(value) ? value : [String(value)] }
					: { id: uiRequest.id, value: String(value) };
		setUiRequest(null);
		setUiAnswer("");
		setUiSelections([]);
		await window.axiom?.agent.respondToUi(response);
	}

	function selectCommand(command: ComposerCommand) {
		const suffix = command.name === "goal" ? " " : "";
		const next = `/${command.name}${suffix}`;
		setInput(next);
		setCursorPosition(next.length);
		window.requestAnimationFrame(() => {
			textareaRef.current?.focus();
			textareaRef.current?.setSelectionRange(next.length, next.length);
		});
	}

	function toggleUiSelection(option: string) {
		setUiSelections((current) =>
			current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
		);
	}

	async function chooseThinkingLevel(level: AgentThinkingLevel) {
		setThinkingLevel(level);
		try {
			await window.axiom?.agent.setThinkingLevel(level);
		} catch (error) {
			setMessages((cur) => [
				...cur,
				{
					role: "assistant",
					text: `Could not change reasoning level: ${error instanceof Error ? error.message : String(error)}`,
					time: Date.now(),
				},
			]);
		}
	}

	async function chooseCodexModel(modelId: string) {
		setActiveModelId(modelId);
		setModelName(labelForCodexModel(modelId));
		setThinkingMenuOpen(false);
		try {
			await window.axiom?.settings.writeEnv({
				AXIOM_MODEL_MODE: "split",
				AXIOM_PRIMARY_PROVIDER: "openai-codex",
				AXIOM_PRIMARY_MODEL: modelId,
			});
			await window.axiom?.agent.abort().catch(() => {});
		} catch (error) {
			setMessages((cur) => [
				...cur,
				{
					role: "assistant",
					text: `Could not change model: ${error instanceof Error ? error.message : String(error)}`,
					time: Date.now(),
				},
			]);
		}
	}

	async function chooseEffort(level: AgentThinkingLevel) {
		await chooseThinkingLevel(level);
		setThinkingMenuOpen(false);
	}

	async function chooseSpeedPreset() {
		await chooseCodexModel("gpt-5.4-mini");
		await chooseThinkingLevel("low");
	}

	function editGoal() {
		setInput(`/goal ${activeGoal ?? ""}`);
		setCursorPosition((`/goal ${activeGoal ?? ""}`).length);
		window.requestAnimationFrame(() => textareaRef.current?.focus());
	}

	async function clearGoal() {
		try {
			await window.axiom?.agent.runSlashCommand("/goal clear");
			syncActiveGoal(undefined);
			setGoalPaused(false);
			setGoalCollapsed(false);
			onSessionChanged?.();
		} catch (error) {
			setMessages((cur) => [
				...cur,
				{
					role: "assistant",
					text: `Could not clear goal: ${error instanceof Error ? error.message : String(error)}`,
					time: Date.now(),
				},
			]);
		}
	}

	const goalElapsed = activeGoal && goalStartedAt ? formatDuration(now - goalStartedAt) : "";

	function abort() {
		void window.axiom?.agent?.abort();
		// Reflect the interruption immediately; don't wait for the agent's
		// (possibly delayed) end event to flip Stop back to Send.
		agentDepth.current = 0;
		setBusy(false);
		paintActive((m) => ({ ...m, streaming: false }));
	}

	function onKey(e: React.KeyboardEvent) {
		if (filteredCommands.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveCommandIndex((index) => (index + 1) % filteredCommands.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveCommandIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				selectCommand(filteredCommands[activeCommandIndex] ?? filteredCommands[0]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setInput("");
				setCursorPosition(0);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const command = filteredCommands[activeCommandIndex] ?? filteredCommands[0];
				if (input.trim() === `/${command.name}`) {
					void send();
				} else {
					selectCommand(command);
				}
				return;
			}
		}
		if (e.key === "Tab") {
			e.preventDefault();
			cyclePermissionMode();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}

	// Drag-drop files into the composer area
	function onComposerDragOver(e: React.DragEvent) {
		if (e.dataTransfer.types.includes("Files")) {
			e.preventDefault();
			setDragOver(true);
		}
	}
	function onComposerDragLeave() { setDragOver(false); }
	function onComposerDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);
		void onFiles(e.dataTransfer.files);
	}

	return (
		<div className="chat">
			<div className="chat-bar">
				<div className="chat-context">
					<span className="context-mark" />
					<span>AXIOM agent</span>
					<span className="context-separator">/</span>
					<span className="context-muted">{folder ?? workspaceName ?? "No folder selected"}</span>
				</div>
				<button className="space-btn" onClick={() => onOpenSpace?.({ text: buildSpaceHandoff(messages, input, workspaceName) })}>
					<span className="space-btn-mark">◍</span>
					Open Space
				</button>
			</div>

			<div className="chat-scroll" ref={scrollRef}>
				<div className="chat-col">
					{messages.length === 0 && (
						<div className="chat-empty">
							<div className="ce-glyph"><AxiomMark size={34} /></div>
							<div className="ce-title">Start a task</div>
							<div className="ce-sub">AXIOM can inspect files, run commands, browse, edit code, and verify the result.</div>
						</div>
					)}
					{messages.map((m, i) =>
						m.role === "user" ? (
							<div key={i} className="turn user">
								<div className="turn-body">
									{m.attachments?.filter((a) => a.isImage && a.data).map((a, j) => (
										<img key={j} src={`data:${a.mime};base64,${a.data}`} alt={a.name} className="turn-img" />
									))}
									<div className="turn-text">{m.text}</div>
									<div className="turn-time">{formatClock(m.time)}</div>
								</div>
							</div>
						) : (
							<div key={i} className="turn assistant">
								<span className="turn-glyph"><AxiomMark size={22} /></span>
								<div className="turn-body">
									<div className="assistant-label">
										<span>AXIOM</span>
										{m.streaming && <span className="live-label">Working</span>}
									</div>
									{m.thinking && (
										<details className="disclosure thought-disclosure">
											<summary>
												<span className="thought-icon">◌</span>
												<span>Reasoning summary</span>
											</summary>
											<div
												className="disclosure-body thought-body md"
												// biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from agent reasoning summary
												dangerouslySetInnerHTML={{ __html: renderMd(m.thinking) }}
											/>
										</details>
									)}
									{m.steps && m.steps.length > 0 && (
										<details className="disclosure worklog">
											<summary>
												<span className="worklog-icon">⌁</span>
												<span className="worklog-summary">
													{toolSummary(m.steps)}
												</span>
												<span className="step-count">{m.steps.length}</span>
											</summary>
											<div className="disclosure-body">
												{m.steps.map((s) => (
													<div key={s.id} className={`step step-${s.status} tone-${toolTone(s.name)}`}>
														<span className="step-icon">{toolIcon(s.name)}</span>
														<span className="step-name">{toolLabel(s.name)}</span>
														<span className="step-detail">
															{shortFile(s.file) ?? s.detail}
															{typeof s.additions === "number" && <b className="diff-add"> +{s.additions}</b>}
															{typeof s.deletions === "number" && <b className="diff-del"> -{s.deletions}</b>}
														</span>
														<span className="step-status">
															{s.status === "running" ? "working" : s.status === "error" ? "error" : "done"}
														</span>
														<DiffPreview step={s} />
														{s.output && <pre className="step-output">{s.output}</pre>}
													</div>
												))}
											</div>
										</details>
									)}
									{m.text || m.streaming ? (
										<div
											className={`turn-text md${m.streaming ? " streaming" : ""}`}
											// biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from agent
											dangerouslySetInnerHTML={{ __html: renderMd(m.text) + (m.streaming ? '<span class="caret">▍</span>' : "") }}
										/>
									) : null}
									{!m.streaming && m.text && (
										<div className="turn-footer">
											<span>{formatClock(m.time)}</span>
											<CopyBtn text={m.text} />
										</div>
									)}
								</div>
							</div>
						),
					)}
				</div>
			</div>

			<div
				className={`composer-wrap${dragOver ? " drag-over" : ""}`}
				onDragOver={onComposerDragOver}
				onDragLeave={onComposerDragLeave}
				onDrop={onComposerDrop}
			>
				<div className="composer">
					{activeGoal && !goalDraft && (
						<div className={`active-goal-card${goalPaused ? " paused" : ""}`}>
							<div className="active-goal-meta">
								<div className="active-goal-title">
									<span>◎</span>
									<b>{goalPaused ? "Goal paused" : "Pursuing goal"}</b>
									{goalElapsed && <span className="active-goal-duration">{goalElapsed}</span>}
								</div>
								<div className="active-goal-actions">
									<button type="button" title="Review goal progress">Review</button>
									<button onClick={editGoal} title="Edit goal">✎</button>
									<button onClick={() => setGoalPaused((paused) => !paused)} title={goalPaused ? "Resume goal" : "Pause goal"}>{goalPaused ? "▶" : "Ⅱ"}</button>
									<button onClick={() => void clearGoal()} title="Delete goal">⌫</button>
									<button onClick={() => setGoalCollapsed((collapsed) => !collapsed)} title={goalCollapsed ? "Expand goal" : "Collapse goal"}>{goalCollapsed ? "›" : "⌄"}</button>
								</div>
							</div>
							{!goalCollapsed && <div className="active-goal-text">{activeGoal}</div>}
						</div>
					)}
					{filteredCommands.length > 0 && (
						<div className="slash-palette" role="listbox" aria-label="Slash commands">
							{filteredCommands.map((command, index) => (
								<button
									key={`${command.source}:${command.name}`}
									type="button"
									className={`slash-command slash-${command.source}${index === activeCommandIndex ? " active" : ""}`}
									onClick={() => selectCommand(command)}
									onMouseEnter={() => setActiveCommandIndex(index)}
									aria-selected={index === activeCommandIndex}
								>
									<span className="slash-name">/{command.name}</span>
									<span className="slash-desc">{command.description ?? command.source}</span>
									<span className="slash-source">{command.source}</span>
								</button>
							))}
						</div>
					)}
					{goalDraft && (
						<div className="composer-goal-card">
							<div className="goal-card-top">
								<span>Pursuing goal</span>
								<span className="goal-card-time">draft</span>
							</div>
							<div className="goal-card-text">{goalDraft}</div>
						</div>
					)}
					{attachments.length > 0 && (
						<div className="attach-row">
							{attachments.map((a, i) => (
								<span key={i} className="attach-chip">
									{a.isImage && a.data
										? <img src={`data:${a.mime};base64,${a.data}`} alt={a.name} className="ac-thumb" />
										: <span className="ac-ic">📎</span>}
									<span className="ac-name">{a.name}</span>
									<button
										className="ac-x"
										onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
										aria-label={`Remove attachment ${a.name}`}
									>
										✕
									</button>
								</span>
							))}
						</div>
					)}
					{dragOver && <div className="drop-hint">Drop files to attach</div>}
					<textarea
						ref={textareaRef}
						className="composer-input"
						rows={1}
						placeholder="How can I help you today?"
						aria-label="Message AXIOM"
						value={input}
						onChange={(e) => { setInput(e.target.value); setCursorPosition(e.target.selectionStart); resizeTextarea(); }}
						onClick={(e) => setCursorPosition(e.currentTarget.selectionStart)}
						onKeyUp={(e) => setCursorPosition(e.currentTarget.selectionStart)}
						onSelect={(e) => setCursorPosition(e.currentTarget.selectionStart)}
						onKeyDown={onKey}
					/>
					<input ref={fileInput} type="file" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
					<div className="composer-bar">
						<div className="composer-left">
							<button className={`ghost${folder ? " on" : ""}`} onClick={pickFolder}>
								<span className="folder-icon" aria-hidden="true">⌑</span>
								{folder ?? "Choose folder"}
							</button>
							<button className="ghost plus" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files">+</button>
							<div className="permission-picker">
								<button
									className="ghost permission-chip"
									onClick={() => setPermissionMenuOpen((open) => !open)}
									aria-expanded={permissionMenuOpen}
									aria-haspopup="menu"
									title={permissionStatus ? `Permission mode · ${permissionStatus}` : "Permission mode"}
								>
									<span className="permission-icon" aria-hidden="true">⚡</span>
									{permissionModeLabel(permissionMode)}
									<span aria-hidden="true">⌄</span>
								</button>
								{permissionMenuOpen && (
									<div className="permission-menu" role="menu">
										<div className="permission-menu-head">
											<span>Modes</span>
											<kbd>tab</kbd>
										</div>
										{PERMISSION_MODES.map((item) => (
											<button
												key={item.mode}
												className={item.mode === permissionMode ? "active" : ""}
												onClick={() => void applyPermissionMode(item.mode)}
												role="menuitem"
											>
												<span className="permission-mode-icon" aria-hidden="true">{item.icon}</span>
												<span className="permission-menu-copy">
													<strong>{item.label}</strong>
													<small>{item.description}</small>
												</span>
												{item.mode === permissionMode && <span className="permission-check">✓</span>}
											</button>
										))}
										<button className="permission-effort" onClick={cycleThinkingLevel} role="menuitem">
											<span className="permission-mode-icon" aria-hidden="true">▥</span>
											<span className="permission-menu-copy">
												<strong>Effort ({formatThinkingLevel(thinkingLevel)})</strong>
												<small>Click to cycle reasoning level. The composer chip uses the same setting.</small>
											</span>
											<span className="effort-dots" aria-hidden="true">
												{THINKING_LEVELS.slice(1).map((level) => (
													<span key={level} className={level === thinkingLevel ? "on" : ""} />
												))}
											</span>
										</button>
									</div>
								)}
							</div>
							<button className={`ghost command-chip${input.startsWith("/goal") ? " active" : ""}`} onClick={() => selectCommand({ name: "goal", source: "builtin", description: "Set or update the active working goal", keywords: "goal" })}>
								<span className="goal-icon" aria-hidden="true">◎</span>
								Goal
							</button>
						</div>
						<div className="composer-right">
							<div className="model-picker">
								<button
									className="model-effort-chip"
									onClick={() => setThinkingMenuOpen((open) => !open)}
									aria-expanded={thinkingMenuOpen}
									aria-haspopup="menu"
									title="Model and reasoning effort"
								>
									<span>{compactModelName(activeModelId)}</span>
									<span>{formatThinkingLevel(thinkingLevel)}</span>
									<span aria-hidden="true">⌄</span>
								</button>
								{thinkingMenuOpen && (
									<div className="model-effort-menu" role="menu">
										<div className="model-effort-section-title">Reasoning</div>
										{VISIBLE_EFFORT_LEVELS.map((level) => (
											<button
												key={level}
												className={`model-effort-row${level === thinkingLevel ? " active" : ""}`}
												onClick={() => void chooseEffort(level)}
												role="menuitem"
											>
												<span>{formatThinkingLevel(level)}</span>
												{level === thinkingLevel && <span>✓</span>}
											</button>
										))}
										<div className="model-effort-separator" />
										<button className="model-effort-row model-effort-parent" role="menuitem">
											<span>{labelForCodexModel(activeModelId)}</span>
											<span aria-hidden="true">⌄</span>
										</button>
										<div className="model-effort-section-title">Model</div>
										{CODEX_MODEL_OPTIONS.map((model) => (
											<button
												key={model.id}
												className={`model-effort-row${model.id === activeModelId ? " active" : ""}`}
												onClick={() => void chooseCodexModel(model.id)}
												role="menuitem"
											>
												<span>{model.label}</span>
												{model.id === activeModelId && <span>✓</span>}
											</button>
										))}
										<button className="model-effort-row model-effort-parent" onClick={() => void chooseSpeedPreset()} role="menuitem">
											<span>Speed</span>
											<span aria-hidden="true">›</span>
										</button>
									</div>
								)}
							</div>
							{busy
								? <button className="abort-btn" onClick={abort}><span className="stop-icon" /> Stop</button>
								: <button className="send" onClick={() => void send()} disabled={!input.trim() && attachments.length === 0} aria-label="Send message">↑</button>
							}
						</div>
					</div>
				</div>
			</div>

			{uiRequest && (
				<div className="question-backdrop" role="presentation">
					<section className="question-dialog" role="dialog" aria-modal="true" aria-labelledby="question-title">
						<div className="question-head">
							<span className="question-mark"><AxiomMark size={18} /></span>
							<div>
								<div className="question-kicker">AXIOM needs your input</div>
								<h2 id="question-title">{uiRequest.title}</h2>
							</div>
						</div>
						{uiRequest.message && <p>{uiRequest.message}</p>}
						{uiRequest.method === "select" && (
							<div className="question-options">
								{uiRequest.options?.map((option, index) => {
									const parsed = splitOption(option);
									return (
										<button key={option} className="question-option" onClick={() => void answerUi(option)}>
											<span className="question-option-index">{index + 1}</span>
											<span className="question-option-copy">
												<strong>{parsed.label}</strong>
												{parsed.description && <span>{parsed.description}</span>}
											</span>
										</button>
									);
								})}
							</div>
						)}
						{uiRequest.method === "multiSelect" && (
							<>
								<div className="question-options">
									{uiRequest.options?.map((option, index) => {
										const parsed = splitOption(option);
										const active = uiSelections.includes(option);
										return (
											<button
												key={option}
												className={`question-option selectable${active ? " selected" : ""}`}
												onClick={() => toggleUiSelection(option)}
											>
												<span className="question-option-index">{active ? "✓" : index + 1}</span>
												<span className="question-option-copy">
													<strong>{parsed.label}</strong>
													{parsed.description && <span>{parsed.description}</span>}
												</span>
											</button>
										);
									})}
								</div>
								<div className="question-actions">
									<button className="question-primary" disabled={uiSelections.length === 0} onClick={() => void answerUi(uiSelections)}>Continue</button>
								</div>
							</>
						)}
						{uiRequest.method === "confirm" && (
							<div className="question-actions">
								<button className="question-secondary" onClick={() => void answerUi(false)}>No</button>
								<button className="question-primary" onClick={() => void answerUi(true)}>Yes</button>
							</div>
						)}
						{(uiRequest.method === "input" || uiRequest.method === "editor") && (
							<>
								<textarea
									autoFocus
									value={uiAnswer}
									placeholder={uiRequest.placeholder}
									onChange={(event) => setUiAnswer(event.target.value)}
								/>
								<div className="question-actions">
									<button className="question-primary" disabled={!uiAnswer.trim()} onClick={() => void answerUi(uiAnswer)}>Continue</button>
								</div>
							</>
						)}
						<div className="question-footer">
							<button className="question-cancel" onClick={() => void answerUi("", true)}>Cancel</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
