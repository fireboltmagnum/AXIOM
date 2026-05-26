import { extname } from "node:path";
import type { AxiomFileUnderstanding, AxiomSymbolEntry } from "./RuntimeTypes.ts";

/**
 * Regex-based code analyzer.
 *
 * This is a deliberately shallow tool: it extracts the *shape* of a source
 * file — top-level functions, classes, types, imports, exports — without
 * building a real AST. The intent is to give AXIOM's Context Agent a
 * structured "fingerprint" of each file fast (<5ms typical) with no native
 * deps, so the agent can recall "what lives where" on future tasks without
 * re-reading the file.
 *
 * Real AST analysis (tree-sitter) is a future upgrade; this is what unblocks
 * the rest of the integration today.
 *
 * Caveats:
 *   - Nested classes / functions are not nested in the output; everything is
 *     flat. Line numbers are 1-indexed.
 *   - Heuristics will miss exotic declarations (e.g. `const Foo = class {}`)
 *     but catch the 90% case.
 *   - Language detection is by extension only.
 */

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "kotlin",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".hpp": "cpp",
	".cc": "cpp",
	".cs": "csharp",
};

export function languageForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	return LANGUAGE_BY_EXT[ext] ?? "unknown";
}

interface RawSymbol {
	kind: AxiomSymbolEntry["kind"];
	name: string;
	line: number;
	signature?: string;
	exported?: boolean;
}

/**
 * Walk the source line by line, applying language-specific regex matchers.
 * Returns the structured understanding plus the symbol list.
 */
export function analyzeFile(path: string, source: string): AxiomFileUnderstanding {
	const language = languageForPath(path);
	const lines = source.split(/\r?\n/);
	const symbols: RawSymbol[] = [];
	const imports = new Set<string>();
	const exports = new Set<string>();

	const collectSymbol = (s: RawSymbol) => symbols.push(s);
	const collectImport = (mod: string) => {
		if (mod) imports.add(mod);
	};
	const collectExport = (name: string) => {
		if (name) exports.add(name);
	};

	switch (language) {
		case "typescript":
		case "javascript":
			scanTsJs(lines, collectSymbol, collectImport, collectExport);
			break;
		case "python":
			scanPython(lines, collectSymbol, collectImport);
			break;
		case "go":
			scanGo(lines, collectSymbol, collectImport, collectExport);
			break;
		case "rust":
			scanRust(lines, collectSymbol, collectImport);
			break;
		case "java":
		case "kotlin":
		case "csharp":
			scanCFamilyClasses(lines, collectSymbol, collectImport);
			break;
		default:
			// Unknown languages: still capture line count + filename, but no symbols.
			break;
	}

	return {
		path,
		language,
		lineCount: lines.length,
		symbols: symbols.map((s) => ({ ...s, signature: s.signature ? truncateSignature(s.signature) : undefined })),
		imports: [...imports].sort(),
		exports: [...exports].sort(),
	};
}

function truncateSignature(sig: string): string {
	const trimmed = sig.trim().replace(/\s+/g, " ");
	return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157)}…`;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function scanTsJs(
	lines: string[],
	add: (s: RawSymbol) => void,
	addImport: (m: string) => void,
	addExport: (n: string) => void,
): void {
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (!line || line.startsWith("//") || line.startsWith("*")) continue;
		const lineNum = i + 1;

		// import ... from "module"
		const importMatch = /^import\s+(?:[^"';]+\s+from\s+)?["']([^"']+)["']/.exec(line);
		if (importMatch) {
			addImport(importMatch[1]);
			continue;
		}

		const exported = /^export\b/.test(line);
		const stripped = line.replace(/^export\s+(?:default\s+)?(?:async\s+)?/, "");

		// function name(...)
		let m: RegExpExecArray | null = /^function\s+([A-Za-z_$][\w$]*)\s*[<(]/.exec(stripped);
		if (m) {
			add({ kind: "function", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		// class Name
		m = /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(stripped);
		if (m) {
			add({ kind: "class", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		// interface Name
		m = /^interface\s+([A-Za-z_$][\w$]*)/.exec(stripped);
		if (m) {
			add({ kind: "interface", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		// type Alias =
		m = /^type\s+([A-Za-z_$][\w$]*)\s*[=<]/.exec(stripped);
		if (m) {
			add({ kind: "type", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		// enum Name
		m = /^(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(stripped);
		if (m) {
			add({ kind: "enum", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		// const/let/var Name = ...
		m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(stripped);
		if (m) {
			add({ kind: "const", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}

		// export { a, b }  or  export { a as b }
		const reExport = /^export\s*\{([^}]+)\}/.exec(line);
		if (reExport) {
			for (const part of reExport[1].split(",")) {
				const name = part
					.trim()
					.split(/\s+as\s+/)
					.pop()
					?.trim();
				if (name) addExport(name);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function scanPython(lines: string[], add: (s: RawSymbol) => void, addImport: (m: string) => void): void {
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const stripped = raw.replace(/^\s+/, "");
		const indent = raw.length - stripped.length;
		const lineNum = i + 1;
		if (!stripped || stripped.startsWith("#")) continue;

		// import X / from X import ...
		let m: RegExpExecArray | null = /^from\s+([\w.]+)\s+import/.exec(stripped);
		if (m) {
			addImport(m[1]);
			continue;
		}
		m = /^import\s+([\w.]+)/.exec(stripped);
		if (m) {
			addImport(m[1]);
			continue;
		}
		// def name(  /  class Name
		m = /^def\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({
				kind: indent === 0 ? "function" : "method",
				name: m[1],
				line: lineNum,
				signature: raw,
				exported: indent === 0 && !m[1].startsWith("_"),
			});
			continue;
		}
		m = /^class\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({
				kind: "class",
				name: m[1],
				line: lineNum,
				signature: raw,
				exported: indent === 0 && !m[1].startsWith("_"),
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function scanGo(
	lines: string[],
	add: (s: RawSymbol) => void,
	addImport: (m: string) => void,
	addExport: (n: string) => void,
): void {
	let inImportBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		const lineNum = i + 1;
		if (!line || line.startsWith("//")) continue;

		if (inImportBlock) {
			if (line === ")") {
				inImportBlock = false;
				continue;
			}
			const m = /["`]([^"`]+)["`]/.exec(line);
			if (m) addImport(m[1]);
			continue;
		}
		if (/^import\s*\(/.test(line)) {
			inImportBlock = true;
			continue;
		}
		const single = /^import\s+(?:[A-Za-z_]+\s+)?["`]([^"`]+)["`]/.exec(line);
		if (single) {
			addImport(single[1]);
			continue;
		}

		let m: RegExpExecArray | null = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/.exec(line);
		if (m) {
			const exported = /^[A-Z]/.test(m[1]);
			add({ kind: "function", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
			continue;
		}
		m = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface)/.exec(line);
		if (m) {
			const exported = /^[A-Z]/.test(m[1]);
			add({ kind: m[2] === "struct" ? "struct" : "interface", name: m[1], line: lineNum, signature: raw, exported });
			if (exported) addExport(m[1]);
		}
	}
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function scanRust(lines: string[], add: (s: RawSymbol) => void, addImport: (m: string) => void): void {
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		const lineNum = i + 1;
		if (!line || line.startsWith("//")) continue;

		const useMatch = /^(?:pub\s+)?use\s+([\w:{},\s*]+);/.exec(line);
		if (useMatch) {
			addImport(useMatch[1].trim());
			continue;
		}
		const exported = /^pub(\(|\s)/.test(line);
		const stripped = line.replace(/^pub(?:\([^)]*\))?\s*/, "");

		let m: RegExpExecArray | null = /^(?:async\s+)?fn\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({ kind: "function", name: m[1], line: lineNum, signature: raw, exported });
			continue;
		}
		m = /^struct\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({ kind: "struct", name: m[1], line: lineNum, signature: raw, exported });
			continue;
		}
		m = /^enum\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({ kind: "enum", name: m[1], line: lineNum, signature: raw, exported });
			continue;
		}
		m = /^trait\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({ kind: "trait", name: m[1], line: lineNum, signature: raw, exported });
			continue;
		}
		m = /^type\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (m) {
			add({ kind: "type", name: m[1], line: lineNum, signature: raw, exported });
		}
	}
}

// ---------------------------------------------------------------------------
// Java / Kotlin / C#
// ---------------------------------------------------------------------------

function scanCFamilyClasses(lines: string[], add: (s: RawSymbol) => void, addImport: (m: string) => void): void {
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		const lineNum = i + 1;
		if (!line || line.startsWith("//")) continue;

		const imp = /^import\s+([\w.]+)\s*;?/.exec(line);
		if (imp) {
			addImport(imp[1]);
			continue;
		}
		const visibility = /^(public|private|protected|internal)\s+/.test(line);
		const stripped = line.replace(/^(public|private|protected|internal|static|final|abstract|sealed)\s+/g, "");
		const cls = /^class\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (cls) {
			add({ kind: "class", name: cls[1], line: lineNum, signature: raw, exported: visibility });
			continue;
		}
		const iface = /^interface\s+([A-Za-z_][\w]*)/.exec(stripped);
		if (iface) {
			add({ kind: "interface", name: iface[1], line: lineNum, signature: raw, exported: visibility });
		}
	}
}
