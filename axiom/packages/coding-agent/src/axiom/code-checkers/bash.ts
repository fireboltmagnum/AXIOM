import { runWithStdin } from "./subprocess.ts";
import type { CodeCheckResult } from "./types.ts";

/**
 * Validate a bash/sh code block by running `bash -n` (no-exec syntax check).
 * Bash reports errors in the form `bash: line N: ...`, which we parse for a
 * line number. ~10-30ms for typical blocks.
 *
 * Falls open (returns ok) when bash is not installed — see runWithStdin's
 * ENOENT handling. The intent is to catch broken scripts on Unixy systems,
 * not to require a specific shell on the user's machine.
 */
export async function checkBash(code: string, timeoutMs: number): Promise<CodeCheckResult> {
	const result = await runWithStdin("bash", ["-n", "/dev/stdin"], code, timeoutMs);
	if (result.timedOut) {
		return {
			ok: false,
			message: `bash -n exceeded ${timeoutMs}ms; the block may contain a pathological construct.`,
			fixHint: "Simplify or split the script into smaller blocks.",
		};
	}
	if (result.ok) return { ok: true };
	const line = extractBashErrorLine(result.stderr);
	return {
		ok: false,
		line,
		message: cleanErrorMessage(result.stderr) || `bash exited with code ${result.exitCode}`,
		fixHint: "Fix the shell syntax error at the indicated line.",
	};
}

function extractBashErrorLine(stderr: string): number | undefined {
	const match = /(?:^|\n)[^:]*:\s*line\s+(\d+)/.exec(stderr);
	if (!match) return undefined;
	const n = Number.parseInt(match[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

function cleanErrorMessage(stderr: string): string {
	return stderr
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join(" | ");
}
