/**
 * Programmatic Tool Calling (CodeAct).
 *
 * Hermes-style "execute_code collapses multi-step pipelines into a single
 * inference call": instead of the model emitting one tool call, reading the
 * result, emitting the next, and so on across many turns, it writes ONE snippet
 * that calls tools programmatically — looping, branching, filtering, and
 * combining results in code. For a small model this is a big agentic win: the
 * orchestration logic lives in deterministic code, not in fragile multi-turn
 * tool-call chains, and one inference replaces N round-trips.
 *
 * This runtime is the deterministic, injectable core. It executes a snippet with
 * a `tools` object (each AXIOM tool exposed as an async function) and a captured
 * `console`, records every tool call in order, bounds output, and enforces a
 * wall-clock timeout. It is fully unit-testable with fake tools — no model, no
 * fs. The `execute_code` tool wires the real AXIOM tools in as `tools`.
 *
 * Trust model: the snippet runs in-process via an async Function (same trust
 * level the agent already has through the `bash` tool). It is NOT a security
 * sandbox; gate it behind the same approval/permission the agent uses for bash.
 * A pathological *synchronous* infinite loop cannot be interrupted in-process —
 * the timeout covers awaited/async work (the realistic case: slow tool chains).
 */

export type CodeActTool = (args?: unknown) => unknown | Promise<unknown>;

export interface CodeActOptions {
	/** Wall-clock budget for awaited work, ms. Default 30000. */
	timeoutMs?: number;
	/** Max captured console/return bytes before truncation. Default 100000. */
	maxOutputBytes?: number;
}

export interface CodeActToolCall {
	name: string;
	args: unknown;
	/** True if the tool threw. */
	failed?: boolean;
}

export interface CodeActResult {
	ok: boolean;
	/** Captured console output plus a serialized tail of the return value. */
	output: string;
	/** Every tool call the snippet made, in order. */
	toolCalls: CodeActToolCall[];
	/** Resolved value of the snippet (if it returned one). */
	returnValue?: unknown;
	error?: string;
	timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

export class CodeActRuntime {
	async run(code: string, tools: Record<string, CodeActTool>, options: CodeActOptions = {}): Promise<CodeActResult> {
		const timeoutMs = Math.max(50, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		const maxOutputBytes = Math.max(1_000, Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));

		const toolCalls: CodeActToolCall[] = [];
		let output = "";
		const append = (text: string) => {
			if (output.length >= maxOutputBytes) return;
			output += output.length + text.length > maxOutputBytes ? text.slice(0, maxOutputBytes - output.length) : text;
		};

		// Wrap every tool so calls are recorded and failures attributed.
		const wrappedTools: Record<string, CodeActTool> = {};
		for (const [name, fn] of Object.entries(tools)) {
			wrappedTools[name] = async (args?: unknown) => {
				const record: CodeActToolCall = { name, args };
				toolCalls.push(record);
				try {
					return await fn(args);
				} catch (err) {
					record.failed = true;
					throw err instanceof Error ? err : new Error(String(err));
				}
			};
		}

		const sandboxConsole = {
			log: (...parts: unknown[]) => append(`${parts.map(stringify).join(" ")}\n`),
			error: (...parts: unknown[]) => append(`${parts.map(stringify).join(" ")}\n`),
			warn: (...parts: unknown[]) => append(`${parts.map(stringify).join(" ")}\n`),
			info: (...parts: unknown[]) => append(`${parts.map(stringify).join(" ")}\n`),
		};

		let runner: (tools: Record<string, CodeActTool>, console: typeof sandboxConsole) => Promise<unknown>;
		try {
			// Wrap in an async IIFE so the snippet may use await and `return`.
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const factory = new Function("tools", "console", `"use strict"; return (async () => {\n${code}\n})();`) as (
				tools: Record<string, CodeActTool>,
				console: typeof sandboxConsole,
			) => Promise<unknown>;
			runner = factory;
		} catch (err) {
			return {
				ok: false,
				output,
				toolCalls,
				error: `Syntax error: ${err instanceof Error ? err.message : String(err)}`,
				timedOut: false,
			};
		}

		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`execute_code exceeded ${timeoutMs}ms`));
			}, timeoutMs);
		});

		try {
			const returnValue = await Promise.race([runner(wrappedTools, sandboxConsole), timeout]);
			if (returnValue !== undefined) {
				append(`\n=> ${stringify(returnValue)}`);
			}
			return { ok: true, output, toolCalls, returnValue, timedOut: false };
		} catch (err) {
			return {
				ok: false,
				output,
				toolCalls,
				error: err instanceof Error ? err.message : String(err),
				timedOut,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
