// Frontend bridge — re-creates `window.axiom` on top of Tauri (invoke + events).
// Two agent paths:
//   • axiom.agent  — the REAL @axiom/coding-agent via Rust child process. Powers Chat.
//   • axiom.gemini — Rust-owned Gemini call. Powers Space board actions.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AxiomChatMessage {
	role: "user" | "assistant";
	text: string;
	images?: { mimeType: string; data: string }[];
}

export interface AxiomTreeNode {
	name: string;
	path: string;
	dir: boolean;
	children?: AxiomTreeNode[];
}

export interface AppCfg {
	cwd: string;
	platform: string;
	agentModel: string;
	spaceModel: string;
}

export interface DropPayload {
	/** Absolute paths of the dropped files. */
	paths: string[];
	/** Screen-space position of the drop (pixels from top-left of the window). */
	position: { x: number; y: number };
}

export interface DashboardTask {
	text: string;
	status: string;
	sessionId: string;
	updatedAt: string;
}

export interface AxiomDataSummary {
	sessions: number;
	reflections: number;
	skills: number;
	memories: number;
	knowledge: number;
	documentIndexes: number;
	codeGraphs: number;
	flowGraphs: number;
	understandings: number;
	todos: number;
	failureFingerprints: number;
	contextLedgerFiles: number;
	storedBytes: number;
	activeTasks: DashboardTask[];
}

const inTauri = "__TAURI_INTERNALS__" in window;

let cfgPromise: Promise<AppCfg> | null = null;
function config(): Promise<AppCfg> {
	if (!cfgPromise) {
		cfgPromise = inTauri
			? invoke<AppCfg>("app_config")
			: Promise.resolve({
					cwd: "",
					platform: navigator.platform,
					agentModel: "Configured model",
					spaceModel: "Configured model",
				});
	}
	return cfgPromise;
}

// ---------------------------------------------------------------------------
// Gemini (Space) — Rust owns the key and the network call.
// ---------------------------------------------------------------------------
async function geminiPrompt(messages: AxiomChatMessage[], onDelta: (t: string) => void): Promise<void> {
	if (!inTauri) throw new Error("Space AI is available in the AXIOM desktop app.");
	const reply = await invoke<string>("gemini_prompt", { messages });
	if (reply) onDelta(reply);
}

// ---------------------------------------------------------------------------
// Real AXIOM agent (Chat) — RPC child process via Rust.
// ---------------------------------------------------------------------------
export type AgentEvent = { type: string; [k: string]: unknown };

/** A raw LSP message forwarded from a language server, tagged with its language id. */
export interface LspEvent {
	languageId: string;
	message: {
		jsonrpc: string;
		id?: number;
		method?: string;
		params?: unknown;
		result?: unknown;
		error?: unknown;
	};
}

export interface AgentSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface AgentSessionState {
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	isStreaming: boolean;
	thinkingLevel: AgentThinkingLevel;
	backgroundGoal?: string;
}

export interface AgentSessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentPermissionMode = "ask" | "edit" | "plan" | "auto" | "bypass";

export interface AgentHistoryMessage {
	role: "user" | "assistant";
	content: unknown;
	time: string;
}

export interface AgentSlashCommand {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
	sourceInfo?: unknown;
}

export interface SpaceAgentBridge {
	onEvent: (cb: (e: AgentEvent) => void) => () => void;
	prompt: (message: string, images?: { mimeType: string; data: string }[]) => Promise<void>;
	abort: () => Promise<void>;
	setFolder: (cwd: string) => Promise<void>;
	cwd: () => Promise<string>;
	respondToUi: (response: Record<string, unknown>) => Promise<void>;
	onHostCall: (
		channel: string,
		handler: (op: string, payload: unknown) => Promise<unknown> | unknown,
	) => () => void;
}

const agentListeners = new Set<(e: AgentEvent) => void>();
const spaceAgentListeners = new Set<(e: AgentEvent) => void>();
const pendingAgentRequests = new Map<
	string,
	{ resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
>();
const pendingSpaceAgentRequests = new Map<
	string,
	{ resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
>();
let agentWired = false;
let spaceAgentWired = false;
function wireAgent(): void {
	if (agentWired) return;
	agentWired = true;
	if (!inTauri) return;
	void listen<AgentEvent>("agent:event", (ev) => {
		const payload = ev.payload;
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = pendingAgentRequests.get(payload.id);
			if (pending) {
				window.clearTimeout(pending.timer);
				pendingAgentRequests.delete(payload.id);
				if (payload.success === false) pending.reject(new Error(String(payload.error ?? "Agent command failed")));
				else pending.resolve(payload.data);
			}
		}
		for (const l of agentListeners) l(ev.payload);
	});
}

function wireSpaceAgent(): void {
	if (spaceAgentWired) return;
	spaceAgentWired = true;
	if (!inTauri) return;
	void listen<AgentEvent>("space_agent:event", (ev) => {
		const payload = ev.payload;
		if (payload.type === "response" && typeof payload.id === "string") {
			const pending = pendingSpaceAgentRequests.get(payload.id);
			if (pending) {
				window.clearTimeout(pending.timer);
				pendingSpaceAgentRequests.delete(payload.id);
				if (payload.success === false) pending.reject(new Error(String(payload.error ?? "Space agent command failed")));
				else pending.resolve(payload.data);
			}
		}
		for (const l of spaceAgentListeners) l(ev.payload);
	});
}

const lspListeners = new Set<(e: LspEvent) => void>();
let lspWired = false;
function wireLsp(): void {
	if (lspWired) return;
	lspWired = true;
	if (!inTauri) return;
	void listen<LspEvent>("lsp:event", (ev) => {
		for (const l of lspListeners) l(ev.payload);
	});
}

let rpcSequence = 0;
async function agentRequest<T>(command: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
	if (!inTauri) throw new Error("The AXIOM agent is available in the desktop app.");
	wireAgent();
	rpcSequence += 1;
	const id = `desktop_${Date.now().toString(36)}_${rpcSequence}`;
	return await new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			pendingAgentRequests.delete(id);
			reject(new Error(`Agent command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		pendingAgentRequests.set(id, {
			resolve: (value) => resolve(value as T),
			reject,
			timer,
		});
		void invoke("agent_command", { command: { ...command, id } }).catch((error) => {
			window.clearTimeout(timer);
			pendingAgentRequests.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

async function sendAgentCommand(command: Record<string, unknown>): Promise<void> {
	if (!inTauri) return;
	wireAgent();
	await invoke("agent_command", { command });
}

async function sendSpaceAgentCommand(command: Record<string, unknown>): Promise<void> {
	if (!inTauri) return;
	wireSpaceAgent();
	await invoke("space_agent_command", { command });
}

// ---------------------------------------------------------------------------
// File-drop (Space) — Tauri intercepts native file drops and emits paths.
// We convert them to asset:// URLs for media/PDF and read bytes for images.
// ---------------------------------------------------------------------------

/** Convert a local file path to a URL the webview can load directly. */
export function filePathToUrl(path: string): string {
	return inTauri ? convertFileSrc(path) : `file://${path}`;
}

/** Read a file as base64 via Rust (for Excalidraw image embedding, ≤20 MB). */
export function readFileBase64(path: string): Promise<string> {
	return invoke<string>("read_file_base64", { path });
}

/** Read a file as UTF-8 text via Rust (for code cards). */
export function readFileText(path: string): Promise<string> {
	return invoke<string>("read_file_text", { path });
}

export interface AxiomBridge {
	platform: string;
	config: () => Promise<AppCfg>;
	dashboard: { summary: () => Promise<AxiomDataSummary> };
	gemini: { prompt: (messages: AxiomChatMessage[], onDelta: (t: string) => void) => Promise<void> };
	agent: {
		onEvent: (cb: (e: AgentEvent) => void) => () => void;
		prompt: (message: string, images?: { mimeType: string; data: string }[]) => Promise<void>;
		abort: () => Promise<void>;
		setFolder: (cwd: string) => Promise<void>;
		cwd: () => Promise<string>;
		state: () => Promise<AgentSessionState>;
		newSession: () => Promise<void>;
		listSessions: (all?: boolean) => Promise<AgentSessionInfo[]>;
		switchSession: (path: string) => Promise<void>;
		setSessionName: (name: string) => Promise<void>;
		history: () => Promise<AgentHistoryMessage[]>;
		stats: () => Promise<AgentSessionStats>;
		commands: () => Promise<AgentSlashCommand[]>;
		runSlashCommand: (command: string) => Promise<{ message: string; copyText?: string }>;
		setThinkingLevel: (level: AgentThinkingLevel) => Promise<void>;
		getActiveTools: () => Promise<string[]>;
		getAllTools: () => Promise<string[]>;
		setActiveTools: (toolNames: string[]) => Promise<string[]>;
		setToolPermissionMode: (mode: AgentPermissionMode) => Promise<AgentPermissionMode>;
		respondToUi: (response: Record<string, unknown>) => Promise<void>;
		/**
		 * Handle agent host-calls for a given channel (e.g. "space"). The handler
		 * receives the op + payload and returns a JSON result (or throws). The
		 * bridge auto-responds to the agent over RPC. Returns an unsubscribe fn.
		 */
		onHostCall: (
			channel: string,
			handler: (op: string, payload: unknown) => Promise<unknown> | unknown,
		) => () => void;
	};
	spaceAgent: SpaceAgentBridge;
	space: {
		/** Subscribe to native file-drop events from Tauri. Returns unsubscribe fn. */
		onFileDrop: (cb: (payload: DropPayload) => void) => () => void;
		filePathToUrl: (path: string) => string;
		readFileBase64: (path: string) => Promise<string>;
		readFileText: (path: string) => Promise<string>;
	};
	ide: {
		openFolder: () => Promise<{ root: string; name: string; tree: AxiomTreeNode[] } | null>;
		openPath: (path: string) => Promise<{ root: string; name: string; tree: AxiomTreeNode[] } | null>;
		listDir: (path: string) => Promise<AxiomTreeNode[]>;
		readFile: (path: string) => Promise<string>;
		writeFile: (path: string, content: string) => Promise<void>;
	};
	lsp: {
		/** Subscribe to raw LSP messages from servers. Returns unsubscribe fn. */
		onEvent: (cb: (e: LspEvent) => void) => () => void;
		/** Set the workspace root (rootUri) for newly-started servers. */
		setRoot: (path: string) => Promise<void>;
		/** Open a document. Returns the detected language id, or null if unsupported. */
		didOpen: (path: string, text: string) => Promise<string | null>;
		didChange: (path: string, text: string, version: number) => Promise<void>;
		didClose: (path: string) => Promise<void>;
		/** Position-based request (hover/definition). Returns the request id. */
		request: (path: string, method: string, position: { line: number; character: number }) => Promise<number>;
		/** Kill all running servers (on workspace change). */
		shutdownAll: () => Promise<void>;
	};
	settings: {
		/** Read ~/.axiom/.env as a key→value map. */
		read: () => Promise<Record<string, string>>;
		/** Merge updates into ~/.axiom/.env (empty value removes a key). */
		writeEnv: (updates: Record<string, string>) => Promise<void>;
		/** Whether the user is signed in with Google (Gemini OAuth). */
		geminiOAuthStatus: () => Promise<{ loggedIn: boolean; email?: string }>;
		/** Run the Google login flow. Resolves with the signed-in email. */
		geminiOAuthLogin: () => Promise<{ loggedIn: boolean; email?: string }>;
		/** Sign out of Google (clear stored tokens). */
		geminiOAuthLogout: () => Promise<void>;
		/** Whether the user is signed in with ChatGPT (Codex OAuth). */
		codexOAuthStatus: () => Promise<{ loggedIn: boolean; email?: string }>;
		/** Run the ChatGPT login flow. Resolves with the signed-in email. */
		codexOAuthLogin: () => Promise<{ loggedIn: boolean; email?: string }>;
		/** Sign out of ChatGPT (clear stored Codex tokens). */
		codexOAuthLogout: () => Promise<void>;
	};
}

export const axiom: AxiomBridge = {
	platform: navigator.platform,
	config,
	dashboard: {
		summary() {
			if (!inTauri) {
				return Promise.resolve({
					sessions: 0,
					reflections: 0,
					skills: 0,
					memories: 0,
					knowledge: 0,
					documentIndexes: 0,
					codeGraphs: 0,
					flowGraphs: 0,
					understandings: 0,
					todos: 0,
					failureFingerprints: 0,
					contextLedgerFiles: 0,
					storedBytes: 0,
					activeTasks: [],
				});
			}
			return invoke<AxiomDataSummary>("axiom_data_summary");
		},
	},
	gemini: { prompt: geminiPrompt },
	agent: {
		onEvent(cb) {
			wireAgent();
			agentListeners.add(cb);
			return () => agentListeners.delete(cb);
		},
		prompt(message, images) {
			if (!inTauri) return Promise.reject(new Error("The AXIOM agent is available in the desktop app."));
			return invoke("agent_prompt", { message, images: images ?? null });
		},
		abort() {
			if (!inTauri) return Promise.resolve();
			return invoke("agent_abort");
		},
		setFolder(cwd) {
			if (!inTauri) return Promise.reject(new Error("Folder access is available in the desktop app."));
			return Promise.all([invoke("agent_set_cwd", { cwd }), invoke("space_agent_set_cwd", { cwd })]).then(() => undefined);
		},
		cwd() {
			if (!inTauri) return Promise.resolve("");
			return invoke<string>("agent_cwd");
		},
		state() {
			return agentRequest<AgentSessionState>({ type: "get_state" });
		},
		async newSession() {
			await agentRequest({ type: "new_session" });
		},
		async listSessions(all = true) {
			const data = await agentRequest<{ sessions: AgentSessionInfo[] }>({ type: "list_sessions", all });
			return data.sessions;
		},
		async switchSession(path) {
			await agentRequest({ type: "switch_session", sessionPath: path }, 30000);
		},
		async setSessionName(name) {
			await agentRequest({ type: "set_session_name", name });
		},
		async history() {
			const data = await agentRequest<{ messages: AgentHistoryMessage[] }>({ type: "get_history" });
			return data.messages;
		},
		stats() {
			return agentRequest<AgentSessionStats>({ type: "get_session_stats" });
		},
		async commands() {
			const fallback: AgentSlashCommand[] = [
				{ name: "settings", description: "Open settings menu", source: "builtin" },
				{ name: "model", description: "Select model", source: "builtin" },
				{ name: "scoped-models", description: "Enable or disable models for cycling", source: "builtin" },
				{ name: "export", description: "Export session", source: "builtin" },
				{ name: "import", description: "Import and resume a session", source: "builtin" },
				{ name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
				{ name: "copy", description: "Copy last agent message", source: "builtin" },
				{ name: "name", description: "Set session display name", source: "builtin" },
				{ name: "session", description: "Show session info and stats", source: "builtin" },
				{ name: "changelog", description: "Show changelog entries", source: "builtin" },
				{ name: "hotkeys", description: "Show keyboard shortcuts", source: "builtin" },
				{ name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
				{ name: "clone", description: "Duplicate the current session", source: "builtin" },
				{ name: "tree", description: "Navigate session tree", source: "builtin" },
				{ name: "login", description: "Configure provider authentication", source: "builtin" },
				{ name: "logout", description: "Remove provider authentication", source: "builtin" },
				{ name: "new", description: "Start a new session", source: "builtin" },
				{ name: "compact", description: "Compact this session context", source: "builtin" },
				{ name: "goal", description: "Set or update the active working goal", source: "builtin" },
				{ name: "steer", description: "Inject a message mid-task", source: "builtin" },
				{ name: "resume", description: "Resume a different session", source: "builtin" },
				{
					name: "reload",
					description: "Reload keybindings, extensions, skills, prompts, and themes",
					source: "builtin",
				},
				{ name: "quit", description: "Quit AXIOM", source: "builtin" },
			];
			if (!inTauri) return fallback;
			const data = await agentRequest<{ commands: AgentSlashCommand[] }>({ type: "get_commands" });
			const seen = new Set<string>();
			return data.commands.filter((command) => {
				if (seen.has(command.name)) return false;
				seen.add(command.name);
				return true;
			});
		},
		runSlashCommand(command) {
			return agentRequest<{ message: string; copyText?: string }>({ type: "run_slash_command", command }, 60000);
		},
		async setThinkingLevel(level) {
			await agentRequest({ type: "set_thinking_level", level });
		},
		async getActiveTools() {
			const data = await agentRequest<{ toolNames: string[] }>({ type: "get_active_tools" });
			return data.toolNames;
		},
		async getAllTools() {
			const data = await agentRequest<{ toolNames: string[] }>({ type: "get_all_tools" });
			return data.toolNames;
		},
		async setActiveTools(toolNames) {
			const data = await agentRequest<{ toolNames: string[] }>({ type: "set_active_tools", toolNames });
			return data.toolNames;
		},
		async setToolPermissionMode(mode) {
			const data = await agentRequest<{ mode: AgentPermissionMode }>({ type: "set_tool_permission_mode", mode });
			return data.mode;
		},
		respondToUi(response) {
			return sendAgentCommand({ type: "extension_ui_response", ...response });
		},
		onHostCall(channel, handler) {
			wireAgent();
			const listener = (e: AgentEvent) => {
				if (e.type !== "extension_ui_request" || e.method !== "host_call" || e.channel !== channel) return;
				const id = e.id as string;
				const op = e.op as string;
				void (async () => {
					try {
						const result = await handler(op, e.payload);
						await sendAgentCommand({ type: "extension_ui_response", id, result });
					} catch (err) {
						await sendAgentCommand({
							type: "extension_ui_response",
							id,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			};
			agentListeners.add(listener);
			return () => agentListeners.delete(listener);
		},
	},
	spaceAgent: {
		onEvent(cb) {
			wireSpaceAgent();
			spaceAgentListeners.add(cb);
			return () => spaceAgentListeners.delete(cb);
		},
		prompt(message, images) {
			if (!inTauri) return Promise.reject(new Error("The AXIOM Space agent is available in the desktop app."));
			return invoke("space_agent_prompt", { message, images: images ?? null });
		},
		abort() {
			if (!inTauri) return Promise.resolve();
			return invoke("space_agent_abort");
		},
		setFolder(cwd) {
			if (!inTauri) return Promise.reject(new Error("Folder access is available in the desktop app."));
			return invoke("space_agent_set_cwd", { cwd });
		},
		cwd() {
			if (!inTauri) return Promise.resolve("");
			return invoke<string>("space_agent_cwd");
		},
		respondToUi(response) {
			return sendSpaceAgentCommand({ type: "extension_ui_response", ...response });
		},
		onHostCall(channel, handler) {
			wireSpaceAgent();
			const listener = (e: AgentEvent) => {
				if (e.type !== "extension_ui_request" || e.method !== "host_call" || e.channel !== channel) return;
				const id = e.id as string;
				const op = e.op as string;
				void (async () => {
					try {
						const result = await handler(op, e.payload);
						await sendSpaceAgentCommand({ type: "extension_ui_response", id, result });
					} catch (err) {
						await sendSpaceAgentCommand({
							type: "extension_ui_response",
							id,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			};
			spaceAgentListeners.add(listener);
			return () => spaceAgentListeners.delete(listener);
		},
	},
	space: {
		onFileDrop(cb) {
			if (!inTauri) return () => {};
			let cancelled = false;
			let unlistenFn: (() => void) | null = null;
			void listen<DropPayload>("tauri://drag-drop", (ev) => {
				if (!cancelled && ev.payload.paths?.length) cb(ev.payload);
			}).then((fn) => {
				if (cancelled)
					fn(); // effect already cleaned up — unlisten immediately
				else unlistenFn = fn;
			});
			return () => {
				cancelled = true;
				unlistenFn?.();
			};
		},
		filePathToUrl,
		readFileBase64,
		readFileText,
	},
	ide: {
		openFolder() {
			if (!inTauri) return Promise.resolve(null);
			return invoke("ide_open_folder");
		},
		openPath(path) {
			if (!inTauri) return Promise.resolve(null);
			return invoke("ide_open_path", { path });
		},
		listDir(path) {
			if (!inTauri) return Promise.resolve([]);
			return invoke<AxiomTreeNode[]>("ide_list_dir", { path });
		},
		readFile(path) {
			if (!inTauri) return Promise.reject(new Error("File access is available in the desktop app."));
			return invoke<string>("ide_read_file", { path });
		},
		writeFile(path, content) {
			if (!inTauri) return Promise.reject(new Error("File access is available in the desktop app."));
			return invoke("ide_write_file", { path, content });
		},
	},
	lsp: {
		onEvent(cb) {
			wireLsp();
			lspListeners.add(cb);
			return () => lspListeners.delete(cb);
		},
		setRoot(path) {
			if (!inTauri) return Promise.resolve();
			return invoke("lsp_set_root", { path });
		},
		didOpen(path, text) {
			if (!inTauri) return Promise.resolve(null);
			wireLsp();
			return invoke<string | null>("lsp_did_open", { path, text });
		},
		didChange(path, text, version) {
			if (!inTauri) return Promise.resolve();
			return invoke("lsp_did_change", { path, text, version });
		},
		didClose(path) {
			if (!inTauri) return Promise.resolve();
			return invoke("lsp_did_close", { path });
		},
		request(path, method, position) {
			if (!inTauri) return Promise.reject(new Error("LSP is available in the desktop app."));
			return invoke<number>("lsp_request", { path, method, position });
		},
		shutdownAll() {
			if (!inTauri) return Promise.resolve();
			return invoke("lsp_shutdown_all");
		},
	},
	settings: {
		read() {
			if (!inTauri) return Promise.resolve({});
			return invoke<Record<string, string>>("settings_read");
		},
		writeEnv(updates) {
			if (!inTauri) return Promise.reject(new Error("Settings are available in the desktop app."));
			return invoke("settings_write_env", { updates });
		},
		geminiOAuthStatus() {
			if (!inTauri) return Promise.resolve({ loggedIn: false });
			return invoke<{ loggedIn: boolean; email?: string }>("gemini_oauth_status");
		},
		geminiOAuthLogin() {
			if (!inTauri) return Promise.reject(new Error("Login is available in the desktop app."));
			return invoke<{ loggedIn: boolean; email?: string }>("gemini_oauth_login");
		},
		geminiOAuthLogout() {
			if (!inTauri) return Promise.resolve();
			return invoke("gemini_oauth_logout");
		},
		codexOAuthStatus() {
			if (!inTauri) return Promise.resolve({ loggedIn: false });
			return invoke<{ loggedIn: boolean; email?: string }>("codex_oauth_status");
		},
		codexOAuthLogin() {
			if (!inTauri) return Promise.reject(new Error("Login is available in the desktop app."));
			return invoke<{ loggedIn: boolean; email?: string }>("codex_oauth_login");
		},
		codexOAuthLogout() {
			if (!inTauri) return Promise.resolve();
			return invoke("codex_oauth_logout");
		},
	},
};

(window as unknown as { axiom: AxiomBridge }).axiom = axiom;
