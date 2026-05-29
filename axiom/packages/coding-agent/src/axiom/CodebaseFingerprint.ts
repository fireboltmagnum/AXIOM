import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/**
 * Codebase fingerprint — a per-repo style profile injected into every
 * system prompt for that repo.
 *
 * Detects idioms by SAMPLING (not exhaustively walking): primary language,
 * naming case, comment density, test framework, package manager, indent
 * style, type-strictness, error-handling pattern, file-size norm. The output
 * is ~250 chars of plain prose: *"This repo is TypeScript with strict mode,
 * pnpm workspaces, vitest tests, snake_case files, tab indent, two-line
 * file docstrings, async/await throughout."* Drop-in for the agent's
 * pre-task context.
 *
 * Everything is deterministic — no LLM calls. Builds in ~50-200ms for
 * typical repos; cached on disk and only rebuilt when the repo's
 * `package.json` / `Cargo.toml` / `pyproject.toml` mtime changes.
 *
 * No PII / no source exfil: the fingerprint is *aggregate counters and
 * boolean flags*, never quoted code.
 */

const FINGERPRINT_VERSION = 1;
const MAX_SAMPLE_FILES = 30;
const SAMPLE_BYTES = 8000;
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"coverage",
	".turbo",
	".cache",
	"target",
	"vendor",
	".venv",
	"__pycache__",
	".idea",
	".vscode",
	".pytest_cache",
	".gradle",
	".axiom",
]);

const CODE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".rb",
	".php",
	".swift",
	".c",
	".cpp",
	".cs",
]);

export interface CodebaseFingerprintData {
	version: number;
	cwd: string;
	updatedAt: string;
	primaryLanguage: string;
	languages: Record<string, number>;
	packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "cargo" | "pip" | "poetry" | "go" | undefined;
	testFramework?: string;
	typecheck?: string;
	indent: "tabs" | "spaces" | "mixed";
	indentSize?: number;
	namingCase: {
		filesSnake: number;
		filesCamel: number;
		filesKebab: number;
		filesPascal: number;
	};
	asyncPattern: "async-await" | "promises" | "callbacks" | "mixed" | "n/a";
	strictTypes?: boolean;
	commentDensity: number;
	medianFileLines: number;
	manifestFingerprint: string;
}

export class CodebaseFingerprint {
	private readonly baseDir: string;
	private readonly cwd: string;
	private readonly diskPath: string;
	private cached: CodebaseFingerprintData | undefined;

	constructor(options: { cwd: string; baseDir?: string }) {
		this.cwd = resolvePath(options.cwd);
		this.baseDir = options.baseDir ?? join(homedir(), ".axiom", "agent", "fingerprints");
		const hash = createHash("sha256").update(this.cwd).digest("hex").slice(0, 16);
		this.diskPath = join(this.baseDir, `${hash}.json`);
	}

	/**
	 * Get the current fingerprint, rebuilding when the repo's manifest files
	 * have changed since the cached snapshot. First call after a repo edit
	 * does the rebuild; subsequent calls within the same session are pure
	 * cache hits.
	 */
	ensureFresh(): CodebaseFingerprintData | undefined {
		if (this.cached) {
			const currentFp = this.computeManifestFingerprint();
			if (currentFp === this.cached.manifestFingerprint) return this.cached;
		} else {
			const disk = this.loadFromDisk();
			if (disk) {
				const currentFp = this.computeManifestFingerprint();
				if (currentFp === disk.manifestFingerprint) {
					this.cached = disk;
					return disk;
				}
			}
		}
		try {
			this.cached = this.build();
			this.persist();
			return this.cached;
		} catch {
			return undefined;
		}
	}

	/**
	 * Render the fingerprint into a compact prose block for the system
	 * prompt. Hard-capped at ~280 chars. Empty when no data is collectable
	 * (e.g. the cwd has no code files yet).
	 */
	renderForPrompt(): string {
		const data = this.ensureFresh();
		if (!data) return "";
		const parts: string[] = [];
		parts.push(`Primary language: ${data.primaryLanguage}.`);
		if (data.packageManager) parts.push(`pkg: ${data.packageManager}.`);
		if (data.testFramework) parts.push(`tests: ${data.testFramework}.`);
		if (data.typecheck) parts.push(`typecheck: ${data.typecheck}.`);
		parts.push(`indent: ${data.indent}${data.indentSize ? ` (${data.indentSize})` : ""}.`);
		const topCase = topNamingCase(data.namingCase);
		if (topCase) parts.push(`file naming: ${topCase}.`);
		if (data.asyncPattern !== "n/a") parts.push(`async: ${data.asyncPattern}.`);
		if (data.strictTypes) parts.push(`strict types.`);
		parts.push(`median file: ${data.medianFileLines} lines.`);
		const out = `Codebase fingerprint — ${parts.join(" ")}`;
		return out.length <= 280 ? out : `${out.slice(0, 277)}...`;
	}

	private loadFromDisk(): CodebaseFingerprintData | undefined {
		if (!existsSync(this.diskPath)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(this.diskPath, "utf-8")) as CodebaseFingerprintData;
			if (parsed.version !== FINGERPRINT_VERSION || parsed.cwd !== this.cwd) return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	private persist(): void {
		if (!this.cached) return;
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			writeFileSync(this.diskPath, JSON.stringify(this.cached), "utf-8");
		} catch {
			// best-effort
		}
	}

	/**
	 * Cheap mtime-based digest over the repo's manifests. When any of these
	 * change we rebuild the fingerprint. Picks the SHALLOWEST manifests so we
	 * don't churn on package.json files inside node_modules-adjacent caches.
	 */
	private computeManifestFingerprint(): string {
		const manifests = [
			"package.json",
			"tsconfig.json",
			"pyproject.toml",
			"poetry.lock",
			"Cargo.toml",
			"go.mod",
			"composer.json",
			"Gemfile",
		];
		const parts: string[] = [];
		for (const name of manifests) {
			const path = join(this.cwd, name);
			try {
				const st = statSync(path);
				parts.push(`${name}:${st.mtimeMs}:${st.size}`);
			} catch {
				// missing
			}
		}
		return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
	}

	private build(): CodebaseFingerprintData {
		const sampledFiles: { path: string; bytes: number; ext: string }[] = [];
		this.sample(this.cwd, sampledFiles, 0);

		const languages: Record<string, number> = {};
		for (const f of sampledFiles) {
			const lang = extToLang(f.ext);
			languages[lang] = (languages[lang] ?? 0) + 1;
		}
		const primaryLanguage = topByValue(languages) ?? "unknown";

		const namingCase = computeNamingCase(sampledFiles.map((f) => baseName(f.path)));

		// Sample contents for indent + async + type strictness + comment density
		let tabCount = 0;
		let spaceCount = 0;
		let asyncAwait = 0;
		let promiseThen = 0;
		let callbackPattern = 0;
		let commentLines = 0;
		let totalLines = 0;
		const lineCounts: number[] = [];
		const indentWidths: number[] = [];

		for (const f of sampledFiles.slice(0, 20)) {
			let content: string;
			try {
				content = readFileSync(f.path, "utf-8").slice(0, SAMPLE_BYTES);
			} catch {
				continue;
			}
			const lines = content.split("\n");
			lineCounts.push(lines.length);
			for (const line of lines) {
				if (/^\s*(\/\/|#|--)\s/.test(line)) commentLines++;
				totalLines++;
			}
			if (/^\t/m.test(content)) tabCount++;
			const spaceMatch = content.match(/^( {2,8})\S/m);
			if (spaceMatch) {
				spaceCount++;
				indentWidths.push(spaceMatch[1].length);
			}
			if (/\b(?:async\s+function|async\s*\(|=>\s*\{[\s\S]*?await|await\s+\w)/.test(content)) asyncAwait++;
			if (/\.then\s*\(/.test(content)) promiseThen++;
			if (/function\s*\([^)]*\bcallback\b[^)]*\)|, *cb\)/.test(content)) callbackPattern++;
		}

		// Manifest-derived facts: package manager, test framework, typecheck script, strictTypes
		const manifests = this.readManifests();

		return {
			version: FINGERPRINT_VERSION,
			cwd: this.cwd,
			updatedAt: new Date().toISOString(),
			primaryLanguage,
			languages,
			packageManager: manifests.packageManager,
			testFramework: manifests.testFramework,
			typecheck: manifests.typecheck,
			indent: tabCount > spaceCount * 1.5 ? "tabs" : spaceCount > tabCount * 1.5 ? "spaces" : "mixed",
			indentSize: median(indentWidths),
			namingCase,
			asyncPattern: classifyAsync(asyncAwait, promiseThen, callbackPattern),
			strictTypes: manifests.strictTypes,
			commentDensity: totalLines === 0 ? 0 : Number((commentLines / totalLines).toFixed(3)),
			medianFileLines: median(lineCounts) ?? 0,
			manifestFingerprint: this.computeManifestFingerprint(),
		};
	}

	private sample(dir: string, out: { path: string; bytes: number; ext: string }[], depth: number): void {
		if (out.length >= MAX_SAMPLE_FILES) return;
		if (depth > 6) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
		} catch {
			return;
		}
		// Round-robin through files first, then recurse — gives breadth over depth.
		const childDirs: string[] = [];
		for (const entry of entries) {
			if (out.length >= MAX_SAMPLE_FILES) return;
			if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				childDirs.push(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const ext = extOf(entry.name);
			if (!CODE_EXTS.has(ext)) continue;
			const path = join(dir, entry.name);
			try {
				const st = statSync(path);
				if (st.size > 200_000) continue; // skip generated files
				out.push({ path, bytes: st.size, ext });
			} catch {
				// skip
			}
		}
		for (const child of childDirs) {
			if (out.length >= MAX_SAMPLE_FILES) return;
			this.sample(child, out, depth + 1);
		}
	}

	private readManifests(): {
		packageManager?: CodebaseFingerprintData["packageManager"];
		testFramework?: string;
		typecheck?: string;
		strictTypes?: boolean;
	} {
		const out: {
			packageManager?: CodebaseFingerprintData["packageManager"];
			testFramework?: string;
			typecheck?: string;
			strictTypes?: boolean;
		} = {};
		const pkgPath = join(this.cwd, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
					packageManager?: string;
					scripts?: Record<string, string>;
					dependencies?: Record<string, string>;
					devDependencies?: Record<string, string>;
				};
				const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
				if (pkg.packageManager?.startsWith("pnpm")) out.packageManager = "pnpm";
				else if (pkg.packageManager?.startsWith("yarn")) out.packageManager = "yarn";
				else if (pkg.packageManager?.startsWith("bun")) out.packageManager = "bun";
				else out.packageManager = "npm";
				for (const fwk of ["vitest", "jest", "mocha", "ava", "tap", "playwright"]) {
					if (deps[fwk] || deps[`@${fwk}`] || deps[`${fwk}/test`]) {
						out.testFramework = fwk;
						break;
					}
				}
				if (pkg.scripts?.typecheck || pkg.scripts?.["type-check"] || pkg.scripts?.tsc) {
					out.typecheck = "tsc";
				}
			} catch {
				// malformed package.json
			}
		}
		const tscPath = join(this.cwd, "tsconfig.json");
		if (existsSync(tscPath)) {
			try {
				const text = readFileSync(tscPath, "utf-8");
				// Tolerant detection — tsconfig may have // comments.
				if (/"strict"\s*:\s*true/.test(text)) out.strictTypes = true;
			} catch {
				// ignore
			}
		}
		const pyproject = join(this.cwd, "pyproject.toml");
		if (existsSync(pyproject)) {
			out.packageManager = out.packageManager ?? "poetry";
			try {
				const text = readFileSync(pyproject, "utf-8");
				if (/pytest/.test(text)) out.testFramework = out.testFramework ?? "pytest";
				if (/mypy|pyright/.test(text))
					out.typecheck = out.typecheck ?? (text.includes("pyright") ? "pyright" : "mypy");
			} catch {
				// ignore
			}
		}
		const cargo = join(this.cwd, "Cargo.toml");
		if (existsSync(cargo)) out.packageManager = "cargo";
		const gomod = join(this.cwd, "go.mod");
		if (existsSync(gomod)) out.packageManager = "go";
		return out;
	}
}

function extOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

function baseName(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

function extToLang(ext: string): string {
	if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "TypeScript";
	if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "JavaScript";
	if (ext === ".py") return "Python";
	if (ext === ".go") return "Go";
	if (ext === ".rs") return "Rust";
	if (ext === ".java") return "Java";
	if (ext === ".kt") return "Kotlin";
	if (ext === ".rb") return "Ruby";
	if (ext === ".php") return "PHP";
	if (ext === ".swift") return "Swift";
	if (ext === ".c") return "C";
	if (ext === ".cpp") return "C++";
	if (ext === ".cs") return "C#";
	return "other";
}

function topByValue(record: Record<string, number>): string | undefined {
	let best: string | undefined;
	let bestVal = -1;
	for (const [k, v] of Object.entries(record)) {
		if (v > bestVal) {
			bestVal = v;
			best = k;
		}
	}
	return best;
}

function median(numbers: number[]): number | undefined {
	if (numbers.length === 0) return undefined;
	const sorted = [...numbers].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function computeNamingCase(filenames: string[]): {
	filesSnake: number;
	filesCamel: number;
	filesKebab: number;
	filesPascal: number;
} {
	const counts = { filesSnake: 0, filesCamel: 0, filesKebab: 0, filesPascal: 0 };
	for (const name of filenames) {
		const stem = name.replace(/\.[^.]+$/, "");
		if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(stem)) counts.filesSnake++;
		else if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(stem)) counts.filesKebab++;
		else if (/^[a-z][a-z0-9]*[A-Z]/.test(stem)) counts.filesCamel++;
		else if (/^[A-Z][a-zA-Z0-9]+$/.test(stem)) counts.filesPascal++;
	}
	return counts;
}

function topNamingCase(counts: {
	filesSnake: number;
	filesCamel: number;
	filesKebab: number;
	filesPascal: number;
}): string | undefined {
	const entries: Array<[string, number]> = [
		["snake_case", counts.filesSnake],
		["kebab-case", counts.filesKebab],
		["camelCase", counts.filesCamel],
		["PascalCase", counts.filesPascal],
	];
	entries.sort((a, b) => b[1] - a[1]);
	const [name, value] = entries[0];
	return value > 0 ? name : undefined;
}

function classifyAsync(
	asyncAwait: number,
	promiseThen: number,
	callbacks: number,
): CodebaseFingerprintData["asyncPattern"] {
	const total = asyncAwait + promiseThen + callbacks;
	if (total === 0) return "n/a";
	if (asyncAwait >= total * 0.6) return "async-await";
	if (promiseThen >= total * 0.6) return "promises";
	if (callbacks >= total * 0.6) return "callbacks";
	return "mixed";
}
