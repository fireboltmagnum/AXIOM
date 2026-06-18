// Google Code Assist provider (OAuth "Login with Google" path).
//
// Lets AXIOM use a personal Google account's FREE Code Assist tier (~1000
// req/day) instead of a metered GEMINI_API_KEY (20/day). It speaks the
// cloudcode-pa.googleapis.com `:generateContent` endpoint, which wraps the
// normal Gemini request in a `{ model, project, request: {...} }` envelope and
// returns the normal response nested under `.response`, and authenticates with
// an OAuth Bearer token (refreshed on demand) rather than an API key.
//
// We register it under a distinct api id ("google-code-assist") and reuse the
// shared Gemini message/tool conversion + response shaping so its behavior
// matches the API-key google provider. Credentials are written by the desktop
// app (Rust) to ~/.axiom/gemini-oauth.json.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleOptions } from "./google.ts";
import { convertMessages, isThinkingPart, mapStopReason, retainThoughtSignature } from "./google-shared.ts";

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
// Public installed-app credentials from the official gemini-cli (same as the
// desktop login flow uses).
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

interface OAuthTokens {
	access_token: string;
	refresh_token: string;
	expiry: number; // unix seconds
	email?: string;
}

function tokensPath(): string {
	return join(homedir(), ".axiom", "gemini-oauth.json");
}

function readTokens(): OAuthTokens | undefined {
	try {
		return JSON.parse(readFileSync(tokensPath(), "utf8")) as OAuthTokens;
	} catch {
		return undefined;
	}
}

function writeTokens(tokens: OAuthTokens): void {
	try {
		writeFileSync(tokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
	} catch {
		// best-effort cache; a failed write just means we refresh again next time
	}
}

/** Return a valid access token, refreshing it if it is expired or near expiry. */
async function getAccessToken(): Promise<string> {
	const tokens = readTokens();
	if (!tokens?.refresh_token) {
		throw new Error(
			"Not signed in with Google. Open AXIOM Settings → Account → Login with Google to use the free Gemini tier.",
		);
	}
	const now = Math.floor(Date.now() / 1000);
	if (tokens.access_token && tokens.expiry - 60 > now) {
		return tokens.access_token;
	}
	// Refresh.
	const body = new URLSearchParams({
		client_id: CLIENT_ID,
		client_secret: CLIENT_SECRET,
		refresh_token: tokens.refresh_token,
		grant_type: "refresh_token",
	});
	const resp = await fetch(TOKEN_URI, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!resp.ok) {
		throw new Error(`Google token refresh failed (${resp.status}). Re-login in AXIOM Settings.`);
	}
	const json = (await resp.json()) as { access_token: string; expires_in?: number };
	const refreshed: OAuthTokens = {
		...tokens,
		access_token: json.access_token,
		expiry: now + (json.expires_in ?? 3600),
	};
	writeTokens(refreshed);
	return refreshed.access_token;
}

// The Code Assist project id is discovered once via loadCodeAssist and cached.
let cachedProject: string | undefined;

async function getProject(accessToken: string): Promise<string | undefined> {
	if (cachedProject) return cachedProject;
	try {
		const resp = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
		});
		if (resp.ok) {
			const json = (await resp.json()) as { cloudaicompanionProject?: string };
			cachedProject = json.cloudaicompanionProject;
		}
	} catch {
		// fall through — some accounts work without an explicit project
	}
	return cachedProject;
}

/**
 * Down-convert a JSON-Schema tool parameter object to the OpenAPI 3 subset the
 * Code Assist endpoint accepts: anyOf/oneOf made purely of `const` values
 * collapse to a single `enum`; a lone `const` becomes a 1-value enum; unknown
 * JSON-Schema meta keywords are dropped. Recurses through properties/items.
 */
function toOpenApiSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(toOpenApiSchema);
	if (typeof node !== "object" || node === null) return node;
	const obj = node as Record<string, unknown>;

	// Collapse anyOf/oneOf of consts → enum. Code Assist's OpenAPI validator only
	// accepts STRING enums (numeric enum values 400 as "TYPE_STRING"), so for
	// numeric literal unions we drop the enum and keep a plain number type — the
	// constraint is advisory and the tool handler coerces the value anyway.
	for (const combiner of ["anyOf", "oneOf"] as const) {
		const variants = obj[combiner];
		if (Array.isArray(variants)) {
			const consts = variants
				.map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>).const : undefined))
				.filter((v) => v !== undefined);
			if (consts.length === variants.length && consts.length > 0) {
				const { [combiner]: _drop, ...rest } = obj;
				if (consts.every((c) => typeof c === "string")) {
					return { ...mapChildren(rest), type: "string", enum: consts };
				}
				return { ...mapChildren(rest), type: typeof consts[0] === "number" ? "number" : "string" };
			}
		}
	}
	// Lone const → single-value string enum, or plain typed value.
	if ("const" in obj) {
		const c = obj.const;
		const { const: _c, ...rest } = obj;
		if (typeof c === "string") return { ...mapChildren(rest), type: "string", enum: [c] };
		return { ...mapChildren(rest), type: typeof c === "number" ? "number" : "boolean" };
	}
	return mapChildren(obj);
}

const DROP_KEYS = new Set(["$schema", "$id", "additionalProperties", "examples", "default", "title"]);

function mapChildren(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (DROP_KEYS.has(k)) continue;
		out[k] = toOpenApiSchema(v);
	}
	return out;
}

/**
 * Build the inner Gemini request body. Code Assist's `request` object mirrors
 * the REST GenerateContentRequest: `contents`, `systemInstruction`, and `tools`
 * are TOP-LEVEL fields; only sampling params go inside `generationConfig`.
 * (Putting systemInstruction/tools in generationConfig => 400 "Cannot find field".)
 */
function buildInnerRequest(model: Model<"google-code-assist">, context: Context, options: GoogleOptions) {
	const contents = convertMessages(model as unknown as Model<"google-generative-ai">, context);
	const request: Record<string, unknown> = { contents };
	if (context.systemPrompt) {
		request.systemInstruction = { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] };
	}
	if (context.tools && context.tools.length > 0) {
		// Code Assist v1internal needs `parameters` as OpenAPI 3 Schema. It rejects
		// raw JSON-Schema keywords (`const`, `anyOf`, `$schema`, …) that TypeBox
		// emits for literal unions, so we down-convert to OpenAPI here (anyOf/oneOf
		// of consts → enum; strip unsupported meta). Without this the tool
		// declarations 400 and the model never function-calls (Space draws text).
		request.tools = [
			{
				functionDeclarations: context.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: toOpenApiSchema(tool.parameters),
				})),
			},
		];
	}
	const generationConfig: Record<string, unknown> = {};
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
	return request;
}

export const streamGoogleCodeAssist: StreamFunction<"google-code-assist", GoogleOptions> = (
	model: Model<"google-code-assist">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const accessToken = await getAccessToken();
			const project = await getProject(accessToken);
			const request = buildInnerRequest(model, context, options ?? {});

			const envelope = {
				model: model.id,
				...(project ? { project } : {}),
				request,
			};

			const resp = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(envelope),
				signal: options?.signal,
			});

			if (!resp.ok || !resp.body) {
				const text = await resp.text().catch(() => "");
				throw new Error(`Code Assist error (${resp.status}): ${text.slice(0, 300)}`);
			}

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blockIndex = () => output.content.length - 1;

			// Parse the SSE stream. Each `data:` line carries a chunk whose payload
			// is nested under `.response` (the Code Assist envelope).
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				// Honor Stop: cancel the in-flight stream the instant the user aborts.
				if (options?.signal?.aborted) {
					await reader.cancel().catch(() => {});
					break;
				}
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE events are separated by blank lines; data lines start with "data:".
				while (true) {
					const nl = buffer.indexOf("\n");
					if (nl === -1) break;
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;
					let chunk: any;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}
					const response = chunk.response ?? chunk;
					const candidate = response.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text === undefined) continue;
							const isThinking = isThinkingPart(part);
							const wantType = isThinking ? "thinking" : "text";
							if (!currentBlock || currentBlock.type !== wantType) {
								if (currentBlock) {
									stream.push({
										type: currentBlock.type === "text" ? "text_end" : "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.type === "text" ? currentBlock.text : currentBlock.thinking,
										partial: output,
									} as any);
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}
						// Tool/function calls.
						for (const part of candidate.content.parts) {
							if (!part.functionCall) continue;
							const call: ToolCall = {
								type: "toolCall",
								id: part.functionCall.id ?? `call_${Date.now()}_${output.content.length}`,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};
							output.content.push(call);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(call.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall: call, partial: output });
						}
					}
					if (candidate?.finishReason) {
						output.stopReason = mapStopReason(candidate.finishReason);
					}
					const um = response.usageMetadata;
					if (um) {
						output.usage.input = um.promptTokenCount ?? output.usage.input;
						output.usage.output = um.candidatesTokenCount ?? output.usage.output;
						output.usage.totalTokens = um.totalTokenCount ?? output.usage.totalTokens;
					}
				}
			}

			if (currentBlock) {
				stream.push({
					type: currentBlock.type === "text" ? "text_end" : "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.type === "text" ? currentBlock.text : currentBlock.thinking,
					partial: output,
				} as any);
			}

			// Code Assist returns finishReason "STOP" even when the turn contains a
			// function call, which maps to stopReason "stop" — so the agent loop
			// thinks the turn is done and NEVER executes the tool (Space draws
			// nothing, then 90s no-progress timeout). If we emitted any toolCall,
			// force "tool_use" so the loop runs the tool and continues.
			if (output.content.some((c) => c.type === "toolCall")) {
				output.stopReason = "toolUse";
			}

			output.usage.cost = calculateCost(model, output.usage);
			stream.end(output);
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: output });
			stream.end(output);
		}
	})();

	return stream;
};

export const streamSimpleGoogleCodeAssist: StreamFunction<"google-code-assist", SimpleStreamOptions> = (
	model,
	context,
	options,
) => streamGoogleCodeAssist(model as Model<"google-code-assist">, context, options as GoogleOptions);
