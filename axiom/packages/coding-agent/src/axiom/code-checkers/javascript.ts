import vm from "node:vm";
import type { CodeCheckResult } from "./types.ts";

/**
 * Parse-time check for JavaScript code blocks (NOT TypeScript).
 *
 * Node's `vm.Script` constructor parses the source eagerly and throws a
 * `SyntaxError` with line/column attached — no actual execution happens.
 * Typically sub-millisecond, fully in-process, no deps.
 *
 * TypeScript routing: `pickCheckerForLanguage` deliberately sends `.ts`/`.tsx`
 * blocks to the balanced-delimiter checker, NOT here. Any regex-based stripper
 * that tries to make TS look like JS inevitably corrupts valid object literals
 * (`{ a: bar, b: 2 }` etc.), so we don't attempt it. Real TS validation belongs
 * in a separate path with a proper parser; the streaming gate only cares about
 * catastrophic syntax breakage and the balanced-delimiter check covers that.
 */
export async function checkJavaScript(code: string, _timeoutMs: number): Promise<CodeCheckResult> {
	try {
		new vm.Script(code, { filename: "axiom-stream-check.js" });
		return { ok: true };
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			// Defensive: vm.Script can throw non-syntax errors for unusual inputs
			// (e.g. compilation-time RangeError). Treat as a soft fail so the
			// agent retries instead of silently passing.
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
				fixHint: "Review the code block for malformed structure.",
			};
		}
		const { line, column } = parseNodeSyntaxErrorLocation(error);
		return {
			ok: false,
			line,
			column,
			message: error.message,
			fixHint: "Fix the syntax error at the indicated position; do not re-emit the broken block.",
		};
	}
}

interface NodeSyntaxErrorLocation {
	line?: number;
	column?: number;
}

/**
 * Node attaches line/column info to syntax errors in a few different shapes
 * depending on version. This handles `error.lineNumber` / `error.columnNumber`
 * (older) and the `stack` "filename:LINE" format (newer).
 */
function parseNodeSyntaxErrorLocation(error: SyntaxError): NodeSyntaxErrorLocation {
	const anyErr = error as SyntaxError & { lineNumber?: number; columnNumber?: number; stack?: string };
	if (typeof anyErr.lineNumber === "number") {
		return { line: anyErr.lineNumber, column: anyErr.columnNumber };
	}
	const stack = anyErr.stack ?? "";
	const match = /axiom-stream-check\.js:(\d+)(?::(\d+))?/.exec(stack);
	if (match) {
		return {
			line: Number.parseInt(match[1], 10),
			column: match[2] ? Number.parseInt(match[2], 10) : undefined,
		};
	}
	return {};
}
