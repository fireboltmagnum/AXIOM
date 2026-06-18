/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { normalizeGoalInput } from "../../core/background-goal.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import type { SessionMessageEntry } from "../../core/session-manager.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { createSyntheticSourceInfo } from "../../core/source-info.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		multiSelect: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "multiSelect", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "values" in r ? r.values : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		hostCall<T = unknown>(
			channel: string,
			op: string,
			payload?: unknown,
			opts?: ExtensionUIDialogOptions,
		): Promise<T> {
			// Round-trips to the embedding host (desktop app) and awaits its JSON
			// result. Rejects on host-reported error so the tool surfaces failures
			// to the agent. Resolves undefined on cancel/abort/timeout.
			const id = crypto.randomUUID();
			return new Promise<T>((resolve, reject) => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					opts?.signal?.removeEventListener("abort", onAbort);
					pendingExtensionRequests.delete(id);
				};
				const onAbort = () => {
					cleanup();
					resolve(undefined as T);
				};
				if (opts?.signal?.aborted) {
					resolve(undefined as T);
					return;
				}
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				if (opts?.timeout) {
					timeoutId = setTimeout(() => {
						cleanup();
						reject(new Error(`host_call ${channel}.${op} timed out after ${opts.timeout}ms`));
					}, opts.timeout);
				}
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						cleanup();
						if ("error" in response && response.error) {
							reject(new Error(response.error));
							return;
						}
						resolve("result" in response ? (response.result as T) : (undefined as T));
					},
					reject,
				});
				output({
					type: "extension_ui_request",
					id,
					method: "host_call",
					channel,
					op,
					payload,
					timeout: opts?.timeout,
				} as RpcExtensionUIRequest);
			});
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "run_slash_command": {
				const text = command.command.trim();
				if (!text.startsWith("/")) return error(id, "run_slash_command", "Slash command must start with /.");
				const [rawName = "", ...rest] = text.slice(1).split(/\s+/);
				const name = rawName.toLowerCase();
				const arg = rest.join(" ").trim();
				switch (name) {
					case "goal": {
						const normalized = normalizeGoalInput(arg);
						session.setBackgroundGoal(normalized);
						return success(id, "run_slash_command", {
							message: normalized ? `Pursuing goal: ${normalized}` : "Background goal cleared.",
						});
					}
					case "compact": {
						await session.compact(arg || undefined);
						return success(id, "run_slash_command", {
							message: "Context compacted.",
						});
					}
					case "export": {
						const outputPath = await session.exportToHtml(arg || undefined);
						return success(id, "run_slash_command", {
							message: `Exported session: ${outputPath}`,
						});
					}
					case "copy": {
						const copyText = session.getLastAssistantText();
						return success(id, "run_slash_command", {
							message: copyText ? "Copied the last AXIOM response." : "No assistant response to copy yet.",
							copyText,
						});
					}
					case "new": {
						await runtimeHost.newSession();
						await rebindSession();
						return success(id, "run_slash_command", { message: "Started a new session." });
					}
					case "clone": {
						const leafId = session.sessionManager.getLeafId();
						if (!leafId)
							return error(id, "run_slash_command", "Cannot clone session: no current entry selected.");
						const result = await runtimeHost.fork(leafId, { position: "at" });
						if (!result.cancelled) await rebindSession();
						return success(id, "run_slash_command", {
							message: result.cancelled ? "Clone cancelled." : "Cloned the current session.",
						});
					}
					case "reload": {
						await session.reload();
						return success(id, "run_slash_command", {
							message: "Reloaded settings, extensions, skills, prompts, and themes.",
						});
					}
					case "name": {
						if (!arg) return error(id, "run_slash_command", "Usage: /name <session name>");
						session.setSessionName(arg);
						return success(id, "run_slash_command", { message: `Session renamed: ${arg}` });
					}
					case "session": {
						return success(id, "run_slash_command", {
							message: [
								`Session: ${session.sessionName ?? session.sessionId}`,
								`Messages: ${session.messages.length}`,
								`CWD: ${session.sessionManager.getCwd()}`,
								`Reasoning: ${session.thinkingLevel}`,
							].join("\n"),
						});
					}
					case "sessions":
					case "list_sessions": {
						const sessions = await SessionManager.listAll();
						const lines = sessions.slice(0, 12).map((item, index) => {
							const title = item.name || item.firstMessage || "Untitled session";
							const cwd = item.cwd ? ` — ${item.cwd}` : "";
							return `${index + 1}. ${title}${cwd}`;
						});
						return success(id, "run_slash_command", {
							message: lines.length > 0 ? `Recent sessions:\n${lines.join("\n")}` : "No saved sessions found.",
						});
					}
					case "reasoning": {
						const level = arg as typeof session.thinkingLevel;
						const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
						if (!allowed.includes(level)) {
							return success(id, "run_slash_command", {
								message: `Reasoning: ${session.thinkingLevel}\nUsage: /reasoning off|minimal|low|medium|high|xhigh`,
							});
						}
						session.setThinkingLevel(level);
						return success(id, "run_slash_command", { message: `Reasoning set to ${session.thinkingLevel}.` });
					}
					case "hotkeys":
						return success(id, "run_slash_command", {
							message: [
								"Desktop hotkeys:",
								"Enter sends. Shift+Enter inserts a new line.",
								"/ opens commands and skills while the caret is in the command token.",
								"Use the Goal and reasoning chips in the composer for persistent controls.",
							].join("\n"),
						});
					case "help":
						return success(id, "run_slash_command", {
							message: [
								"AXIOM desktop commands:",
								"/goal <text> sets the active working goal. /goal clear removes it.",
								"/reasoning off|minimal|low|medium|high|xhigh changes reasoning effort.",
								"/compact compacts this session context.",
								"/session shows the current session, message count, cwd, and reasoning level.",
								"/new starts a new session. /name <title> renames it.",
								"/copy copies the last AXIOM response. /export writes an HTML transcript.",
								"Skills appear as /skill:<name> in the same menu.",
							].join("\n"),
						});
					case "changelog":
						return success(id, "run_slash_command", {
							message:
								"Changelog is available from the project docs and release notes. Desktop inline changelog UI is not configured in this build.",
						});
					case "model":
					case "settings":
						return success(id, "run_slash_command", {
							message: `/${name} is controlled by the desktop UI here. Use the composer chip/menu instead.`,
						});
					case "import":
					case "share":
					case "fork":
					case "tree":
					case "login":
					case "logout":
					case "resume":
					case "scoped-models":
					case "steer":
					case "quit":
						return success(id, "run_slash_command", {
							message: `/${name} needs an interactive desktop picker or account flow. Use the matching Dashboard, session, model, or window control for now.`,
						});
					default:
						return success(id, "run_slash_command", {
							message: `/${name} was recognized, but this desktop build has no direct action for it yet.`,
						});
				}
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					backgroundGoal: session.getBackgroundGoal(),
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			case "get_active_tools": {
				return success(id, "get_active_tools", { toolNames: session.getActiveToolNames() });
			}

			case "get_all_tools": {
				return success(id, "get_all_tools", { toolNames: session.getAllTools().map((tool) => tool.name) });
			}

			case "set_active_tools": {
				session.setActiveToolsByName(command.toolNames);
				return success(id, "set_active_tools", { toolNames: session.getActiveToolNames() });
			}

			case "set_tool_permission_mode": {
				session.setToolPermissionMode(command.mode);
				return success(id, "set_tool_permission_mode", { mode: session.getToolPermissionMode() });
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			case "list_sessions": {
				const sessions = command.all
					? await SessionManager.listAll()
					: await SessionManager.list(session.sessionManager.getCwd(), session.sessionManager.getSessionDir());
				return success(id, "list_sessions", {
					sessions: sessions.map((item) => ({
						...item,
						created: item.created.toISOString(),
						modified: item.modified.toISOString(),
					})),
				});
			}

			case "get_history": {
				// Read the live session off runtimeHost rather than the closure's
				// `session` binding, so a resume that just rebound the session is
				// always reflected here regardless of rebind timing.
				const messages = runtimeHost.session.sessionManager
					.getBranch()
					.filter(
						(entry): entry is SessionMessageEntry =>
							entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
					)
					.map((entry) => {
						const message = entry.message as { role: "user" | "assistant"; content: unknown };
						return {
							role: message.role,
							content: message.content,
							time: entry.timestamp,
						};
					});
				return success(id, "get_history", { messages });
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];
				const builtinSourceInfo = createSyntheticSourceInfo("<builtin:slash-commands>", { source: "builtin" });

				for (const command of BUILTIN_SLASH_COMMANDS) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "builtin",
						sourceInfo: builtinSourceInfo,
					});
				}

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
