// IDE language support: broad syntax highlighting + an LSP-backed diagnostics
// bridge for CodeMirror 6.
//
// Highlighting comes from CodeMirror language packages (and legacy stream modes
// for the long tail). Diagnostics come from real language servers via the Tauri
// `lsp` bridge: we keep the latest publishDiagnostics per file and expose them to
// a CodeMirror `linter` source.

import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
// Legacy stream-parser modes cover languages without a dedicated Lezer package.
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { type Diagnostic, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";

/** Extension (lowercase, no dot) → CodeMirror language extension factory. */
function highlightFor(ext: string): Extension[] {
	switch (ext) {
		case "ts":
		case "tsx":
		case "mts":
		case "cts":
			return [javascript({ jsx: ext === "tsx", typescript: true })];
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return [javascript({ jsx: true })];
		case "py":
		case "pyi":
			return [python()];
		case "rs":
			return [rust()];
		case "go":
			return [go()];
		case "c":
		case "h":
		case "cpp":
		case "cc":
		case "cxx":
		case "hpp":
			return [cpp()];
		case "java":
			return [java()];
		case "php":
			return [php()];
		case "json":
		case "jsonc":
			return [json()];
		case "html":
		case "htm":
			return [html()];
		case "css":
		case "scss":
		case "less":
			return [css()];
		case "xml":
		case "svg":
			return [xml()];
		case "sql":
			return [sql()];
		case "yaml":
		case "yml":
			return [yaml()];
		case "vue":
			return [vue()];
		case "md":
		case "markdown":
			return [markdown()];
		case "sh":
		case "bash":
		case "zsh":
			return [StreamLanguage.define(shell)];
		case "rb":
			return [StreamLanguage.define(ruby)];
		case "lua":
			return [StreamLanguage.define(lua)];
		case "pl":
		case "pm":
			return [StreamLanguage.define(perl)];
		case "swift":
			return [StreamLanguage.define(swift)];
		case "cs":
			return [StreamLanguage.define(csharp)];
		case "clj":
		case "cljs":
			return [StreamLanguage.define(clojure)];
		case "toml":
			return [StreamLanguage.define(toml)];
		case "dockerfile":
			return [StreamLanguage.define(dockerFile)];
		default:
			return [];
	}
}

export function languageExtensions(path: string): Extension[] {
	const base = path.split("/").pop() ?? path;
	const ext = base.toLowerCase() === "dockerfile" ? "dockerfile" : (base.split(".").pop()?.toLowerCase() ?? "");
	return highlightFor(ext);
}

// ---------------------------------------------------------------------------
// LSP diagnostics bridge
// ---------------------------------------------------------------------------

/** LSP diagnostic severity → CodeMirror severity. */
function severityOf(sev: number | undefined): Diagnostic["severity"] {
	switch (sev) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		default:
			return "info";
	}
}

interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}
interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	message: string;
	source?: string;
	code?: string | number;
}

/** Convert an LSP (line, character) position to a CodeMirror document offset. */
function offsetAt(
	doc: { line: (n: number) => { from: number; length: number }; lines: number },
	line: number,
	character: number,
): number {
	const lineNumber = Math.min(Math.max(line + 1, 1), doc.lines);
	const lineObj = doc.line(lineNumber);
	return lineObj.from + Math.min(character, lineObj.length);
}

/**
 * Holds the most recent diagnostics per file URI and bridges them to a CodeMirror
 * linter. A single store is shared by the editor; the active file's diagnostics
 * are the ones rendered.
 */
export class LspDiagnosticsStore {
	private byUri = new Map<string, LspDiagnostic[]>();
	private listeners = new Set<() => void>();

	set(uri: string, diagnostics: LspDiagnostic[]): void {
		this.byUri.set(uri, diagnostics);
		for (const l of this.listeners) l();
	}

	get(uri: string): LspDiagnostic[] {
		return this.byUri.get(uri) ?? [];
	}

	clear(uri: string): void {
		this.byUri.delete(uri);
		for (const l of this.listeners) l();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
}

/** Build a CodeMirror linter that reads diagnostics for `getUri()` from the store. */
export function lspLinter(store: LspDiagnosticsStore, getUri: () => string | null): Extension {
	return linter((view) => {
		const uri = getUri();
		if (!uri) return [];
		const doc = view.state.doc;
		const out: Diagnostic[] = [];
		for (const d of store.get(uri)) {
			try {
				const from = offsetAt(doc, d.range.start.line, d.range.start.character);
				const to = Math.max(from, offsetAt(doc, d.range.end.line, d.range.end.character));
				out.push({
					from,
					to,
					severity: severityOf(d.severity),
					message: d.source ? `${d.message} (${d.source}${d.code != null ? ` ${d.code}` : ""})` : d.message,
				});
			} catch {
				// Skip diagnostics that don't map onto the current document.
			}
		}
		return out;
	});
}

/** Convert a local absolute path to the same file URI the Rust side emits. */
export function pathToUri(path: string): string {
	const encoded = path.replace(/ /g, "%20");
	return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

export type { LspDiagnostic };
