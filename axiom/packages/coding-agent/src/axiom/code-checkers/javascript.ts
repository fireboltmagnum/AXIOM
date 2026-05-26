import vm from "node:vm";
import type { CodeCheckResult } from "./types.ts";

/**
 * Parse-time check for JavaScript and (best-effort) TypeScript code blocks.
 *
 * Node's `vm.Script` constructor parses the source eagerly and throws a
 * `SyntaxError` with line/column attached as numeric properties (when
 * available) — no actual execution happens. This is the cheapest possible
 * syntax gate: typically sub-millisecond, fully in-process, no deps.
 *
 * TypeScript is parsed as JavaScript, which means type annotations,
 * `interface` / `type` aliases, and other TS-only syntax will be flagged as
 * "syntax errors" by this checker. That is the WRONG behavior, so for `.ts`
 * blocks we strip the most common TS-only constructs before parsing. Real
 * TS type-checking belongs in a separate, much slower path (tsgo); the
 * streaming validator only cares about catastrophic syntax breakage.
 */
export async function checkJavaScript(code: string, _timeoutMs: number): Promise<CodeCheckResult> {
	const stripped = stripTypeScriptOnlyConstructs(code);
	try {
		new vm.Script(stripped, { filename: "axiom-stream-check.js" });
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

/**
 * Strip the TS-only constructs that would otherwise cause a `vm.Script`
 * SyntaxError. This is heuristic — we deliberately do NOT attempt a real TS
 * transform. The intent is to keep the parser focused on actual syntax bugs
 * (unbalanced braces, broken function signatures) without flagging valid TS.
 */
function stripTypeScriptOnlyConstructs(code: string): string {
	let out = code;
	// Remove `interface Name { ... }` blocks (single-level braces only).
	out = out.replace(/\binterface\s+[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*(extends[^{]+)?\{[^}]*\}/g, "");
	// Remove `type Alias = ...;` declarations.
	out = out.replace(/\btype\s+[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*=\s*[^;]+;/g, "");
	// Strip parameter / return type annotations: `: Type` after `)` or before `=>`.
	out = out.replace(/:\s*[A-Za-z_$][\w$.<>,\s|&[\]?]*?(?=[=,){])/g, "");
	// Strip `as Type` casts.
	out = out.replace(/\s+as\s+[A-Za-z_$][\w$.<>,\s|&[\]?]*/g, "");
	// Strip generic type arguments at call sites: `foo<Bar>(` → `foo(`.
	out = out.replace(/([A-Za-z_$][\w$]*)<[^<>()]*>(\s*\()/g, "$1$2");
	return out;
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
