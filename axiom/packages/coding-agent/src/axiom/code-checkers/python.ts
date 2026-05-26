import { runWithStdin } from "./subprocess.ts";
import type { CodeCheckResult } from "./types.ts";

/**
 * Validate a Python code block by piping it into `python3 -c "ast.parse(...)"`.
 * Only the parse stage runs — nothing is executed. Errors come back on stderr
 * in the form:
 *
 *     File "<stdin>", line N
 *       offending line
 *               ^
 *     SyntaxError: explanation
 *
 * We extract the line number and the explanation. Typical latency 80-200ms
 * on first invocation (cold interpreter start), 30-80ms warm.
 *
 * Falls open if `python3` isn't on PATH.
 */
const PARSE_SCRIPT = "import ast, sys; ast.parse(sys.stdin.read())";

export async function checkPython(code: string, timeoutMs: number): Promise<CodeCheckResult> {
	const result = await runWithStdin("python3", ["-c", PARSE_SCRIPT], code, timeoutMs);
	if (result.timedOut) {
		return {
			ok: false,
			message: `python3 ast.parse exceeded ${timeoutMs}ms.`,
			fixHint: "Reduce the size or complexity of the Python block.",
		};
	}
	if (result.ok) return { ok: true };
	const line = extractPythonErrorLine(result.stderr);
	const message = extractPythonErrorSummary(result.stderr) || `python3 exited with code ${result.exitCode}`;
	return {
		ok: false,
		line,
		message,
		fixHint: "Fix the Python syntax error at the indicated line.",
	};
}

function extractPythonErrorLine(stderr: string): number | undefined {
	const match = /File "<stdin>", line (\d+)/.exec(stderr);
	if (!match) return undefined;
	const n = Number.parseInt(match[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

function extractPythonErrorSummary(stderr: string): string | undefined {
	const lines = stderr.split(/\r?\n/).map((s) => s.trim());
	// The final non-empty stderr line is the error class + message.
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]) return lines[i];
	}
	return undefined;
}
