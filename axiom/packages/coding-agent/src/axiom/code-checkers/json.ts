import type { CodeCheckResult } from "./types.ts";

/**
 * Validate a JSON code block via the built-in parser. Catches the model
 * emitting malformed config/data — trailing commas, unquoted keys, broken
 * escapes. Sub-millisecond, no allocations beyond the parsed tree.
 *
 * Node's `JSON.parse` error message includes a character position ("position
 * N"); we convert that to (line, column) so the agent gets a precise pointer.
 */
export async function checkJSON(code: string, _timeoutMs: number): Promise<CodeCheckResult> {
	const trimmed = code.trim();
	if (trimmed.length === 0) {
		return { ok: true };
	}
	try {
		JSON.parse(trimmed);
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const pos = extractPosition(message);
		const location = pos !== undefined ? offsetToLineColumn(trimmed, pos) : undefined;
		return {
			ok: false,
			line: location?.line,
			column: location?.column,
			message,
			fixHint: "Fix the JSON parse error (check for trailing commas, unquoted keys, or unterminated strings).",
		};
	}
}

function extractPosition(message: string): number | undefined {
	const match = /position\s+(\d+)/.exec(message);
	if (!match) return undefined;
	const n = Number.parseInt(match[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { line, column };
}
