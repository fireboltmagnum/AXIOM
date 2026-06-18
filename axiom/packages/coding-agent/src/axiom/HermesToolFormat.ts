/**
 * Hermes function-calling format (Nous Research).
 *
 * Open models in the Hermes / Gemma family are trained to call tools in a
 * specific XML+JSON convention rather than a provider-native tool API:
 *
 *   - Tool signatures are listed in the system prompt inside <tools>…</tools>
 *     as an array of JSON-schema function definitions.
 *   - The model emits a call as <tool_call>{"name":…,"arguments":{…}}</tool_call>.
 *   - The tool result is fed back as <tool_response>{…}</tool_response>.
 *
 * Using the format the model was trained on materially improves tool-call
 * reliability for a small model (Hermes 2 Pro reported ~90% vs ~60-70% for
 * generic prompting). This module is the pure, dependency-free codec: build the
 * <tools> preamble, parse <tool_call> blocks tolerantly, and render
 * <tool_response> blocks. Wiring it into a provider/runtime is a thin adapter on
 * top; the codec is what carries the correctness, so it is unit-tested directly.
 */

export interface HermesToolDef {
	name: string;
	description?: string;
	/** JSON-schema for the arguments object. */
	parameters?: unknown;
}

export interface HermesToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface HermesParseResult {
	calls: HermesToolCall[];
	/** Human-readable notes for blocks that could not be parsed. */
	errors: string[];
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Build the system-prompt preamble that teaches the model the format and lists
 * the available tools as JSON-schema function definitions.
 */
export function formatHermesToolsBlock(tools: HermesToolDef[]): string {
	const functions = tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? { type: "object", properties: {} },
		},
	}));
	return [
		"You are a function-calling AI. You are given function signatures inside <tools></tools>.",
		"To call a function, emit a JSON object with its name and arguments inside <tool_call></tool_call>:",
		'<tool_call>{"name": "<function-name>", "arguments": {<args>}}</tool_call>',
		"You may emit multiple <tool_call> blocks. Do not invent functions that are not listed.",
		"",
		"<tools>",
		JSON.stringify(functions, null, 2),
		"</tools>",
	].join("\n");
}

/**
 * Extract every <tool_call> from model output. Tolerant: skips malformed blocks
 * (recording why), accepts `arguments` as an object OR a JSON string, and
 * defaults missing arguments to `{}`.
 */
export function parseHermesToolCalls(text: string): HermesParseResult {
	const calls: HermesToolCall[] = [];
	const errors: string[] = [];
	if (!text) return { calls, errors };

	for (const match of text.matchAll(TOOL_CALL_RE)) {
		const raw = match[1].trim();
		if (!raw) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			errors.push(`unparseable tool_call: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!parsed || typeof parsed !== "object") {
			errors.push("tool_call was not a JSON object");
			continue;
		}
		const obj = parsed as { name?: unknown; arguments?: unknown };
		if (typeof obj.name !== "string" || !obj.name) {
			errors.push("tool_call missing a string `name`");
			continue;
		}
		calls.push({ name: obj.name, arguments: normalizeArgs(obj.arguments) });
	}
	return { calls, errors };
}

/** Render a tool result for feedback to the model. */
export function formatHermesToolResponse(name: string, content: unknown): string {
	const body = typeof content === "string" ? content : safeStringify(content);
	return `<tool_response>\n${safeStringify({ name, content: body })}\n</tool_response>`;
}

/** Remove all <tool_call> blocks, leaving the model's natural-language prose. */
export function stripHermesToolCalls(text: string): string {
	return text
		.replace(TOOL_CALL_RE, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

function normalizeArgs(args: unknown): Record<string, unknown> {
	if (args === undefined || args === null) return {};
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	if (typeof args === "object") return args as Record<string, unknown>;
	return {};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
