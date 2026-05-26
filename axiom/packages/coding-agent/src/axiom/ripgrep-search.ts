import { spawn } from "node:child_process";
import { ensureTool } from "../utils/tools-manager.ts";

/**
 * Lightweight ripgrep wrapper for AXIOM's internal lexical pre-flight passes
 * (TaskPrimer, auto-retrieval). Not user-facing — the agent-visible grep tool
 * lives in `core/tools/grep.ts` and has its own permissions/rendering layer.
 *
 * Two return shapes:
 *   - {@link rankFilesByLexicalMatches}: returns files ordered by hit density
 *   - {@link sampleLinesPerFile}: returns up to N lines per file with hits
 *
 * Both fall open: when ripgrep is missing or errors out we return `[]` rather
 * than throwing. The auto-retrieval pre-flight is best-effort context — if it
 * silently fails, the agent just falls back to its normal grep tool flow.
 */

export interface RipgrepFileHit {
	/** Repo-relative path. */
	file: string;
	/** Number of matching lines in this file. */
	matchCount: number;
}

export interface RipgrepLineHit {
	file: string;
	line: number;
	text: string;
}

interface RunResult {
	stdout: string;
	exitCode: number | null;
}

/**
 * Run `rg` non-interactively, capture stdout, enforce a wall-clock timeout.
 * Never rejects: returns `{ stdout: "", exitCode: null }` on missing binary,
 * spawn failure, or timeout. The two callers below then degrade to `[]`.
 */
async function runRipgrep(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
	const rgPath = await ensureTool("rg", true);
	if (!rgPath) return { stdout: "", exitCode: null };
	return await new Promise<RunResult>((resolve) => {
		let stdout = "";
		let settled = false;
		const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const settle = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				child.kill("SIGKILL");
			} catch {
				// already dead
			}
			resolve(result);
		};
		const timer = setTimeout(() => settle({ stdout, exitCode: null }), Math.max(50, timeoutMs));
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.on("error", () => settle({ stdout: "", exitCode: null }));
		child.on("close", (code) => settle({ stdout, exitCode: code }));
	});
}

/**
 * Rank files by how many lines match any of the given query terms. Terms are
 * OR-ed into a single ripgrep pattern (`term1|term2|...`). Results are sorted
 * by descending match count, ties broken by path lexicographically so output
 * is deterministic across runs.
 *
 * Hard-capped at `maxFiles` results. ripgrep itself runs with `--max-count`
 * per file to avoid pathological files dominating the ranking.
 */
export async function rankFilesByLexicalMatches(options: {
	cwd: string;
	terms: string[];
	maxFiles: number;
	timeoutMs?: number;
}): Promise<RipgrepFileHit[]> {
	const terms = options.terms.map((t) => t.trim()).filter(Boolean);
	if (terms.length === 0) return [];
	const pattern = terms.map(escapeRegex).join("|");
	// `--count-matches` would be more precise but is slower; `--count` is
	// counts-per-file, which is what we actually want for ranking.
	// `--smart-case` is the default friendly behavior. `--no-messages` and
	// `--no-config` keep output predictable across users.
	const args = [
		"--no-messages",
		"--no-config",
		"--smart-case",
		"--max-columns=2000",
		"--max-count",
		"50",
		"--count",
		"-e",
		pattern,
	];
	const { stdout } = await runRipgrep(args, options.cwd, options.timeoutMs ?? 1500);
	if (!stdout) return [];
	const hits: RipgrepFileHit[] = [];
	for (const line of stdout.split("\n")) {
		const idx = line.lastIndexOf(":");
		if (idx <= 0) continue;
		const file = line.slice(0, idx);
		const count = Number.parseInt(line.slice(idx + 1), 10);
		if (!file || !Number.isFinite(count) || count <= 0) continue;
		hits.push({ file, matchCount: count });
	}
	hits.sort((a, b) => b.matchCount - a.matchCount || a.file.localeCompare(b.file));
	return hits.slice(0, Math.max(0, options.maxFiles));
}

/**
 * For each file in `files`, sample up to `linesPerFile` matching lines with
 * their line numbers. Used by TaskPrimer to attach concrete evidence to the
 * top-ranked files in the structural brief.
 *
 * One ripgrep invocation total — we pass `--files-from` via stdin would be
 * ideal but ripgrep wants a file path; instead we pass paths as positional
 * args (capped at 32 to stay well under argv limits on every OS we target).
 */
export async function sampleLinesPerFile(options: {
	cwd: string;
	terms: string[];
	files: string[];
	linesPerFile: number;
	timeoutMs?: number;
}): Promise<RipgrepLineHit[]> {
	const terms = options.terms.map((t) => t.trim()).filter(Boolean);
	if (terms.length === 0) return [];
	const files = options.files.slice(0, 32).filter(Boolean);
	if (files.length === 0) return [];
	const pattern = terms.map(escapeRegex).join("|");
	const args = [
		"--no-messages",
		"--no-config",
		"--smart-case",
		"--max-columns=400",
		"--with-filename",
		"--line-number",
		"--max-count",
		String(Math.max(1, Math.min(20, options.linesPerFile))),
		"-e",
		pattern,
		"--",
		...files,
	];
	const { stdout } = await runRipgrep(args, options.cwd, options.timeoutMs ?? 1500);
	if (!stdout) return [];
	const out: RipgrepLineHit[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const m = /^(.+?):(\d+):(.*)$/.exec(line);
		if (!m) continue;
		out.push({ file: m[1], line: Number.parseInt(m[2], 10), text: m[3].slice(0, 200) });
	}
	return out;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
