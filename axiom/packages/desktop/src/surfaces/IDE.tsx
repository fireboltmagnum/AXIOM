import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AxiomTreeNode, LspEvent } from "../bridge";
import { Chat } from "./Chat.tsx";
import {
	type LspDiagnostic,
	LspDiagnosticsStore,
	languageExtensions,
	lspLinter,
	pathToUri,
} from "./ide-lsp.ts";
import "./IDE.css";

type Node = AxiomTreeNode;

interface Tab {
	path: string;
	name: string;
	content: string;
	saved: string;
}

// --- File icon by extension ---
const EXT_ICONS: Record<string, string> = {
	ts: "TS", tsx: "TS", js: "JS", jsx: "JS", mjs: "JS", cjs: "JS",
	py: "PY", rs: "RS", go: "GO", java: "JV", c: "C", cpp: "C+", h: "H",
	json: "{}", md: "MD", yaml: "Y", yml: "Y", toml: "T",
	css: "CSS", scss: "SC", html: "<>", htm: "<>",
	sh: "$", bash: "$", zsh: "$",
	png: "IMG", jpg: "IMG", jpeg: "IMG", svg: "SVG", gif: "GIF", webp: "IMG",
	mp4: "VID", mov: "VID", mp3: "AUD", wav: "AUD",
	pdf: "PDF", txt: "TXT",
};

function fileIcon(name: string, isDir: boolean): string {
	if (isDir) return "▸";
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return EXT_ICONS[ext] ?? "•";
}

const langFor = languageExtensions;

function TreeRow({ node, depth, openPath, expanded, onOpen, onToggle }: {
	node: Node; depth: number; openPath: string | null;
	expanded: Set<string>; onOpen: (n: Node) => void; onToggle: (n: Node) => void;
}) {
	const isExpanded = expanded.has(node.path);
	const loading = node.dir && isExpanded && node.children === undefined;
	return (
		<div>
			<button
				type="button"
				className={`tree-row${openPath === node.path ? " active" : ""}${node.dir ? " dir" : ""}`}
				style={{ paddingLeft: 8 + depth * 14 }}
				onClick={() => node.dir ? onToggle(node) : onOpen(node)}
				aria-expanded={node.dir ? isExpanded : undefined}
				title={node.path}
			>
				<span className="tw-ic">{node.dir ? (isExpanded ? "▾" : "▸") : fileIcon(node.name, false)}</span>
				<span className="tw-name">{node.name}</span>
			</button>
			{loading && (
				<div className="tree-row tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>…</div>
			)}
			{node.dir && isExpanded && node.children?.map((child) => (
				<TreeRow key={child.path} node={child} depth={depth + 1} openPath={openPath} expanded={expanded} onOpen={onOpen} onToggle={onToggle} />
			))}
		</div>
	);
}

export function IDE({ initialPath, workspaceName }: { initialPath?: string; workspaceName?: string } = {}) {
	const [root, setRoot] = useState<{ name: string; path: string; tree: Node[] } | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [activeTab, setActiveTab] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const editorRef = useRef<HTMLDivElement>(null);

	// When opened for a workspace, load that folder directly (no picker, no freeze).
	useEffect(() => {
		if (!initialPath || root) return;
		void (async () => {
			try {
				const res = await window.axiom?.ide?.openPath(initialPath);
				if (res) {
					await window.axiom?.lsp?.setRoot(res.root);
					setRoot({ name: res.name || workspaceName || res.root, path: res.root, tree: res.tree });
					setExpanded(new Set());
				}
			} catch (err) {
				setSaveError(err instanceof Error ? err.message : String(err));
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialPath]);

	const tab = tabs[activeTab] ?? null;
	const dirty = tab !== null && tab.content !== tab.saved;

	// --- LSP: real language servers (diagnostics, hover, …) via the Tauri bridge.
	const lspStore = useMemo(() => new LspDiagnosticsStore(), []);
	const lspVersions = useRef<Map<string, number>>(new Map());
	const changeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const tabPathRef = useRef<string | null>(null);
	tabPathRef.current = tab?.path ?? null;
	const [diagCount, setDiagCount] = useState<{ errors: number; warnings: number }>({ errors: 0, warnings: 0 });
	// Per-path language-server id (null = no server). Drives the LSP status badge.
	const [lspLangs, setLspLangs] = useState<Map<string, string | null>>(new Map());
	const lspLang = tab?.path ? (lspLangs.get(tab.path) ?? null) : null;

	// Listen for server messages: record publishDiagnostics + refresh the count.
	useEffect(() => {
		const off = window.axiom?.lsp?.onEvent?.((e: LspEvent) => {
			const msg = e.message;
			if (msg.method === "textDocument/publishDiagnostics") {
				const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
				lspStore.set(params.uri, params.diagnostics ?? []);
				const activeUri = tabPathRef.current ? pathToUri(tabPathRef.current) : null;
				if (activeUri === params.uri) {
					const ds = params.diagnostics ?? [];
					setDiagCount({
						errors: ds.filter((d) => d.severity === 1).length,
						warnings: ds.filter((d) => d.severity === 2).length,
					});
				}
			}
		});
		return () => off?.();
	}, [lspStore]);

	// The linter extension reads diagnostics for whatever file is active.
	const linterExtension = useMemo(() => lspLinter(lspStore, () => (tabPathRef.current ? pathToUri(tabPathRef.current) : null)), [lspStore]);

	// Refresh the diagnostic count + language badge when switching tabs.
	useEffect(() => {
		const uri = tab?.path ? pathToUri(tab.path) : null;
		const ds = uri ? lspStore.get(uri) : [];
		setDiagCount({ errors: ds.filter((d) => d.severity === 1).length, warnings: ds.filter((d) => d.severity === 2).length });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeTab, tab?.path]);

	// Splice freshly-loaded children into the lazily-built tree at `path`.
	function setChildrenAt(nodes: Node[], path: string, children: Node[]): Node[] {
		return nodes.map((n) => {
			if (n.path === path) return { ...n, children };
			if (n.dir && n.children) return { ...n, children: setChildrenAt(n.children, path, children) };
			return n;
		});
	}

	async function openFolder() {
		const res = await window.axiom?.ide?.openFolder();
		if (!res) return;
		// New workspace: restart language servers against the new root.
		await window.axiom?.lsp?.shutdownAll();
		await window.axiom?.lsp?.setRoot(res.root);
		setRoot({ name: res.name, path: res.root, tree: res.tree });
		setExpanded(new Set());
		setTabs([]);
		setActiveTab(0);
		setSaveError("");
	}

	// Tell the language server a document opened; track its version for changes.
	async function lspOpenDoc(path: string, text: string): Promise<void> {
		try {
			lspVersions.current.set(path, 1);
			const lang = await window.axiom?.lsp?.didOpen(path, text);
			setLspLangs((m) => new Map(m).set(path, lang ?? null));
		} catch {
			// No server for this language / not installed — highlighting still works.
		}
	}

	async function refreshTree() {
		if (!root) return;
		// Re-list the root only; expanded subdirs collapse and reload on demand.
		const children = await window.axiom?.ide?.listDir(root.path);
		if (children) setRoot({ ...root, tree: children });
		setExpanded(new Set());
	}

	// Toggle a directory open/closed. On first expand, lazily fetch its children
	// (the Rust side returns directories with no children until asked) so we
	// never walk the whole repo up front.
	async function toggleDir(node: Node) {
		const isOpen = expanded.has(node.path);
		setExpanded((s) => { const n = new Set(s); isOpen ? n.delete(node.path) : n.add(node.path); return n; });
		if (isOpen || node.children) return; // collapsing, or already loaded
		try {
			const children = await window.axiom?.ide?.listDir(node.path);
			setRoot((r) => (r ? { ...r, tree: setChildrenAt(r.tree, node.path, children ?? []) } : r));
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		}
	}

	async function openFile(node: Node) {
		// If already open, just switch to it
		const existing = tabs.findIndex((t) => t.path === node.path);
		if (existing >= 0) { setActiveTab(existing); return; }
		try {
			const content = await window.axiom.ide.readFile(node.path);
			const tab: Tab = { path: node.path, name: node.name, content, saved: content };
			setTabs((ts) => {
				const next = [...ts, tab];
				setActiveTab(next.length - 1);
				return next;
			});
			setSaveError("");
			void lspOpenDoc(node.path, content);
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		}
	}

	function closeTab(i: number, e: React.MouseEvent) {
		e.stopPropagation();
		const closing = tabs[i];
		if (closing) {
			void window.axiom?.lsp?.didClose(closing.path);
			lspStore.clear(pathToUri(closing.path));
			lspVersions.current.delete(closing.path);
			setLspLangs((m) => { const n = new Map(m); n.delete(closing.path); return n; });
		}
		setTabs((ts) => {
			const next = ts.filter((_, j) => j !== i);
			setActiveTab((a) => Math.min(a, Math.max(0, next.length - 1)));
			return next;
		});
	}

	function updateContent(value: string) {
		setTabs((ts) => ts.map((t, i) => i === activeTab ? { ...t, content: value } : t));
		// Debounced full-document sync to the language server.
		const path = tabPathRef.current;
		if (!path) return;
		const timers = changeTimers.current;
		const existing = timers.get(path);
		if (existing) clearTimeout(existing);
		timers.set(
			path,
			setTimeout(() => {
				timers.delete(path);
				const version = (lspVersions.current.get(path) ?? 1) + 1;
				lspVersions.current.set(path, version);
				void window.axiom?.lsp?.didChange(path, value, version);
			}, 350),
		);
	}

	const save = useCallback(async () => {
		if (!tab || !dirty || saving) return;
		setSaving(true);
		setSaveError("");
		try {
			await window.axiom.ide.writeFile(tab.path, tab.content);
			setTabs((ts) => ts.map((t, i) => i === activeTab ? { ...t, saved: t.content } : t));
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [tab, dirty, saving, activeTab]);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
			if ((e.metaKey || e.ctrlKey) && e.key === "w") { e.preventDefault(); if (tabs.length > 0) closeTab(activeTab, { stopPropagation: () => {} } as React.MouseEvent); }
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [save, tabs.length, activeTab]);

	return (
		<div className="ide">
			{/* File tree */}
			<aside className="ide-tree">
				<div className="ide-tree-head">
					<span className="ide-tree-label">{root ? root.name.toUpperCase() : "EXPLORER"}</span>
					<div className="ide-tree-actions">
						{root && <button className="ide-icon-btn" title="Refresh tree" onClick={() => void refreshTree()}>↻</button>}
						<button className="ide-open" onClick={() => void openFolder()}>{root ? "Change" : "Open"}</button>
					</div>
				</div>
				<div className="ide-tree-body">
					{root ? (
						root.tree.map((n) => (
							<TreeRow key={n.path} node={n} depth={0} openPath={tab?.path ?? null} expanded={expanded} onOpen={openFile} onToggle={toggleDir} />
						))
					) : (
						<div className="ide-empty">
							<div className="ide-empty-icon">▤</div>
							<div>Open a folder to start</div>
							<button className="ide-open-cta" onClick={() => void openFolder()}>Open folder</button>
						</div>
					)}
				</div>
			</aside>

			{/* Editor area */}
			<div className="ide-editor">
				{/* Tab bar */}
				{tabs.length > 0 ? (
					<>
						<div className="ide-tabbar">
							<div className="ide-tabs">
								{tabs.map((t, i) => (
									<button
										key={t.path}
										className={`ide-tab${i === activeTab ? " active" : ""}`}
										onClick={() => setActiveTab(i)}
										title={t.path}
									>
										<span className="ide-tab-name">{t.name}</span>
										{t.content !== t.saved && <span className="dirty-dot" />}
										<span className="ide-tab-close" onClick={(e) => closeTab(i, e)}>×</span>
									</button>
								))}
							</div>
							<div className="ide-file-actions">
								{saveError && <span className="ide-save-error" title={saveError}>{saveError}</span>}
								<span className="ide-shortcut">⌘S to save</span>
								<button className="ide-save" onClick={() => void save()} disabled={!dirty || saving}>
									{saving ? "Saving…" : dirty ? "Save" : "Saved"}
								</button>
							</div>
						</div>
						<div className="ide-cm-wrap" ref={editorRef}>
							{tab && (
								<CodeMirror
									key={tab.path}
									value={tab.content}
									height="100%"
									theme="dark"
									extensions={[...langFor(tab.path), linterExtension]}
									onChange={updateContent}
									style={{ height: "100%" }}
									basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: true }}
								/>
							)}
						</div>
						<div className="ide-statusbar">
							<span>{tab ? tab.path : ""}</span>
							<span className="ide-status-right">
								{(diagCount.errors > 0 || diagCount.warnings > 0) && (
									<span className="ide-diag" title="Language server diagnostics">
										{diagCount.errors > 0 && <span className="diag-err">⨯ {diagCount.errors}</span>}
										{diagCount.warnings > 0 && <span className="diag-warn">⚠ {diagCount.warnings}</span>}
									</span>
								)}
								{lspLang && <span className="ide-lsp-badge" title={`Language server: ${lspLang}`}>LSP: {lspLang}</span>}
								<span>{tab ? (langFor(tab.path).length > 0 ? tab.path.split(".").pop()?.toUpperCase() : "Plain Text") : ""}</span>
							</span>
						</div>
					</>
				) : (
					<div className="ide-welcome">
						<div className="iw-glyph">▤</div>
						<div className="iw-title">{root ? "Select a file from the tree" : "Open a project folder"}</div>
						<div className="iw-sub">{root ? "Cmd+S to save · Cmd+W to close tab" : "Browse, edit, diagnose, and save real workspace files."}</div>
						{!root && <button className="btn-open" onClick={() => void openFolder()}>Open a folder</button>}
					</div>
				)}
			</div>

			{/* Docked chat */}
			<aside className="ide-chat">
				<Chat />
			</aside>
		</div>
	);
}
