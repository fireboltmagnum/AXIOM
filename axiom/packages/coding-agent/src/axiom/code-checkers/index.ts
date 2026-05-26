import { checkBalancedDelimiters } from "./balanced.ts";
import { checkBash } from "./bash.ts";
import { checkJavaScript } from "./javascript.ts";
import { checkJSON } from "./json.ts";
import { checkPython } from "./python.ts";
import type { CodeChecker, CodeCheckResult } from "./types.ts";

export type { CodeChecker, CodeCheckResult, FencedCodeBlock } from "./types.ts";

/**
 * Normalize whatever the model wrote after the opening ``` to a canonical
 * language family. Returns empty string when the fence had no tag.
 */
function normalizeLanguage(rawLang: string): string {
	const lang = rawLang.trim().toLowerCase();
	// strip leading dots that show up when the model wrote `.ts` etc.
	return lang.replace(/^\.+/, "");
}

/**
 * Map a normalized language tag to the dedicated checker. Unknown languages
 * fall back to the balanced-delimiter check so we still catch the worst
 * structural breakage even on Rust/Go/Java/etc.
 */
export function pickCheckerForLanguage(rawLanguage: string): { checker: CodeChecker; resolvedLang: string } {
	const lang = normalizeLanguage(rawLanguage);
	switch (lang) {
		case "js":
		case "javascript":
		case "jsx":
		case "mjs":
		case "cjs":
			return { checker: checkJavaScript, resolvedLang: "javascript" };
		case "ts":
		case "typescript":
		case "tsx":
			// vm.Script cannot parse TS-only syntax (type annotations, generics, etc.)
			// and any regex-based pre-stripper inevitably corrupts valid JS-shaped TS
			// (e.g. it eats `: bar` in object literals). Until we ship a real TS parser
			// we route TS/TSX through the language-agnostic balanced-delimiter check,
			// which catches the catastrophic structural breakage (unclosed braces,
			// unterminated strings) without producing false positives on annotations.
			return { checker: checkBalancedDelimiters, resolvedLang: "typescript" };
		case "json":
		case "jsonc":
		case "json5":
			return { checker: checkJSON, resolvedLang: "json" };
		case "bash":
		case "sh":
		case "shell":
		case "zsh":
			return { checker: checkBash, resolvedLang: "bash" };
		case "py":
		case "python":
		case "python3":
			return { checker: checkPython, resolvedLang: "python" };
		default:
			return { checker: checkBalancedDelimiters, resolvedLang: lang || "unknown" };
	}
}

/**
 * Run the checker with a hard upper bound, regardless of what it does
 * internally. If the timeout fires first we return `ok: true` so a misbehaving
 * checker can never block the agent — the user-visible budget is 1000ms and
 * we'd rather miss a real error than freeze the UI.
 */
export async function runChecker(checker: CodeChecker, code: string, timeoutMs: number): Promise<CodeCheckResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutPromise = new Promise<CodeCheckResult>((resolve) => {
			timer = setTimeout(() => resolve({ ok: true }), Math.max(50, timeoutMs));
		});
		return await Promise.race([checker(code, timeoutMs), timeoutPromise]);
	} catch (error) {
		return {
			ok: false,
			message: `Checker threw: ${error instanceof Error ? error.message : String(error)}`,
			fixHint: "Internal checker error; re-emit the block more carefully.",
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
