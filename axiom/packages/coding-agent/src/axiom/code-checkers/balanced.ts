import type { CodeCheckResult } from "./types.ts";

/**
 * Language-agnostic structural sanity check: do `()`, `[]`, `{}` balance, and
 * are all string/template literals closed? This is the fallback for any
 * fenced block whose language we don't have a dedicated parser for (Rust, Go,
 * C, Java, Kotlin, Swift, …). It will not catch real syntax errors — only
 * the catastrophic ones where the model truncated mid-block or fumbled a
 * brace pair.
 *
 * Comments and strings are tracked so a delimiter inside `"foo)"` doesn't
 * count. Single-char comment families covered: `//`, `#`, and `/* ... *​/`.
 */
export async function checkBalancedDelimiters(code: string, _timeoutMs: number): Promise<CodeCheckResult> {
	const stack: { ch: string; line: number; column: number }[] = [];
	const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
	const opens = new Set(["(", "[", "{"]);

	let line = 1;
	let column = 1;
	let i = 0;
	let inString: '"' | "'" | "`" | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	const advance = (n: number) => {
		for (let k = 0; k < n; k++) {
			if (i + k >= code.length) break;
			if (code[i + k] === "\n") {
				line++;
				column = 1;
			} else {
				column++;
			}
		}
		i += n;
	};

	while (i < code.length) {
		const ch = code[i];
		const next = code[i + 1];

		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			advance(1);
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				advance(2);
				continue;
			}
			advance(1);
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				advance(2);
				continue;
			}
			if (ch === inString) inString = null;
			advance(1);
			continue;
		}

		if (ch === "/" && next === "/") {
			inLineComment = true;
			advance(2);
			continue;
		}
		if (ch === "#") {
			inLineComment = true;
			advance(1);
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			advance(2);
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch as '"' | "'" | "`";
			advance(1);
			continue;
		}
		if (opens.has(ch)) {
			stack.push({ ch, line, column });
			advance(1);
			continue;
		}
		if (ch in pairs) {
			const top = stack.pop();
			if (!top || top.ch !== pairs[ch]) {
				return {
					ok: false,
					line,
					column,
					message: `Unbalanced delimiter: '${ch}' has no matching opener${top ? ` (top of stack was '${top.ch}' at ${top.line}:${top.column})` : ""}.`,
					fixHint: "Match opening and closing brackets, or finish the block before closing it.",
				};
			}
			advance(1);
			continue;
		}
		advance(1);
	}

	if (inString) {
		return {
			ok: false,
			line,
			column,
			message: `Unterminated string literal (opened with ${inString}).`,
			fixHint: "Close the string before ending the code block.",
		};
	}
	if (inBlockComment) {
		return {
			ok: false,
			line,
			column,
			message: "Unterminated block comment (no closing */).",
			fixHint: "Close the block comment before ending the code block.",
		};
	}
	if (stack.length > 0) {
		const unmatched = stack[stack.length - 1];
		return {
			ok: false,
			line: unmatched.line,
			column: unmatched.column,
			message: `Unclosed '${unmatched.ch}' (opened at ${unmatched.line}:${unmatched.column}).`,
			fixHint: "Close every opening bracket inside the block.",
		};
	}

	return { ok: true };
}
