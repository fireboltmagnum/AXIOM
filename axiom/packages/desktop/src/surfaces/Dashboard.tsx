import { useEffect, useMemo, useState } from "react";
import type { AgentSessionInfo, AgentSessionStats, AppCfg, AxiomDataSummary } from "../bridge.ts";
import {
	addWorkspace,
	loadActivity,
	loadWorkspaces,
	relativeTime,
	removeWorkspace,
	type Workspace,
	updateWorkspace,
} from "../store.ts";
import { AxiomWordmark } from "../shell/Logo.tsx";
import "./Dashboard.css";

const NAV_TOP = ["Home", "Spaces", "Agents", "Memory", "Knowledge", "Search"] as const;
const NAV_MID = ["Checkpoints", "Cognitive Replay", "Metrics"] as const;
const NAV_BOT = ["Settings", "Integrations", "Billing", "Team"] as const;
type DashboardView = (typeof NAV_TOP)[number] | (typeof NAV_MID)[number] | (typeof NAV_BOT)[number];

const NAV_ICON: Record<DashboardView, string> = {
	Home: "⌂", Spaces: "◫", Agents: "◉", Memory: "❖", Knowledge: "✦", Search: "⌕",
	Checkpoints: "⚑", "Cognitive Replay": "↺", Metrics: "▤",
	Settings: "⚙", Integrations: "⧉", Billing: "▭", Team: "◎",
};

const EMPTY_SUMMARY: AxiomDataSummary = {
	sessions: 0,
	reflections: 0,
	skills: 0,
	memories: 0,
	knowledge: 0,
	documentIndexes: 0,
	codeGraphs: 0,
	flowGraphs: 0,
	understandings: 0,
	todos: 0,
	failureFingerprints: 0,
	contextLedgerFiles: 0,
	storedBytes: 0,
	activeTasks: [],
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat().format(value);
}

function Empty({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="dash-empty">
			<strong>{title}</strong>
			<span>{detail}</span>
		</div>
	);
}

function DataRow({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
	return (
		<div className="data-row">
			<div><strong>{label}</strong>{detail && <span>{detail}</span>}</div>
			<b>{value}</b>
		</div>
	);
}

function SessionRows({
	sessions,
	onOpen,
}: {
	sessions: AgentSessionInfo[];
	onOpen: (session: AgentSessionInfo) => void;
}) {
	if (sessions.length === 0) {
		return <Empty title="No saved sessions" detail="Start a chat and AXIOM will persist it here automatically." />;
	}
	return (
		<div className="data-list">
			{sessions.map((session) => (
				<button key={session.path} className="session-row" onClick={() => onOpen(session)}>
					<span className="session-state" />
					<span className="session-copy">
						<strong>{session.name || session.firstMessage || "Untitled session"}</strong>
						<small>{session.cwd || "AXIOM"}</small>
					</span>
					<span className="session-meta">{session.messageCount} messages · {relativeTime(Date.parse(session.modified))}</span>
				</button>
			))}
		</div>
	);
}

export function Dashboard({
	onOpenWorkspace,
	onOpenSession,
}: {
	onOpenWorkspace: (workspace: Workspace) => void;
	onOpenSession: (session: AgentSessionInfo) => void;
}) {
	const [workspaces, setWorkspaces] = useState<Workspace[]>(() => loadWorkspaces());
	const [activity, setActivity] = useState(() => loadActivity());
	const [view, setView] = useState<DashboardView>("Home");
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftFolder, setDraftFolder] = useState<{ root: string; name: string } | null>(null);
	const [summary, setSummary] = useState<AxiomDataSummary>(EMPTY_SUMMARY);
	const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
	const [stats, setStats] = useState<AgentSessionStats | null>(null);
	const [config, setConfig] = useState<AppCfg | null>(null);
	const [dataError, setDataError] = useState("");
	const [compactTools, setCompactTools] = useState(() => localStorage.getItem("axiom.ui.compactTools") === "1");
	const [reducedMotion, setReducedMotion] = useState(() => localStorage.getItem("axiom.ui.reducedMotion") === "1");

	async function refreshRuntime(): Promise<void> {
		const results = await Promise.allSettled([
			window.axiom.config(),
			window.axiom.dashboard.summary(),
			window.axiom.agent.listSessions(true),
			window.axiom.agent.stats(),
		]);
		if (results[0].status === "fulfilled") setConfig(results[0].value);
		if (results[1].status === "fulfilled") setSummary(results[1].value);
		if (results[2].status === "fulfilled") setSessions(results[2].value);
		if (results[3].status === "fulfilled") setStats(results[3].value);
		const failed = results.find((result) => result.status === "rejected");
		setDataError(failed?.status === "rejected" ? String(failed.reason) : "");
	}

	useEffect(() => {
		void refreshRuntime();
		const off = window.axiom.agent.onEvent((event) => {
			if (event.type === "agent_end" || event.type === "session_info_changed") void refreshRuntime();
		});
		return () => off();
	}, []);

	useEffect(() => {
		document.documentElement.dataset.compactTools = compactTools ? "true" : "false";
		localStorage.setItem("axiom.ui.compactTools", compactTools ? "1" : "0");
	}, [compactTools]);

	useEffect(() => {
		document.documentElement.dataset.reducedMotion = reducedMotion ? "true" : "false";
		localStorage.setItem("axiom.ui.reducedMotion", reducedMotion ? "1" : "0");
	}, [reducedMotion]);

	function refreshLocal(): void {
		setWorkspaces(loadWorkspaces());
		setActivity(loadActivity());
	}

	async function chooseWorkspaceFolder(existing?: Workspace): Promise<void> {
		const folder = await window.axiom.ide.openFolder();
		if (!folder) return;
		if (existing) {
			updateWorkspace(existing.id, { path: folder.root, name: existing.name || folder.name, lastOpenedAt: Date.now() });
			refreshLocal();
			return;
		}
		setDraftFolder({ root: folder.root, name: folder.name });
		setDraftName(folder.name);
		setCreating(true);
	}

	function commitCreate(): void {
		if (!draftFolder) return;
		addWorkspace(draftName.trim() || draftFolder.name, draftFolder.root);
		setDraftName("");
		setDraftFolder(null);
		setCreating(false);
		refreshLocal();
	}

	const workspaceSessions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of sessions) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
		return counts;
	}, [sessions]);

	const searchResults = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return { workspaces, sessions: sessions.slice(0, 20), tasks: summary.activeTasks.slice(0, 20) };
		return {
			workspaces: workspaces.filter((item) => `${item.name} ${item.path ?? ""}`.toLowerCase().includes(needle)),
			sessions: sessions.filter((item) => `${item.name ?? ""} ${item.firstMessage} ${item.cwd}`.toLowerCase().includes(needle)).slice(0, 30),
			tasks: summary.activeTasks.filter((item) => item.text.toLowerCase().includes(needle)).slice(0, 30),
		};
	}, [query, sessions, summary.activeTasks, workspaces]);

	function workspaceGrid(): React.ReactNode {
		if (workspaces.length === 0) {
			return <Empty title="No workspaces yet" detail="Choose a real folder to create a workspace AXIOM can inspect and edit." />;
		}
		return (
			<div className="workspace-list">
				{workspaces.map((workspace) => (
					<div key={workspace.id} className="workspace-row">
						<span className="workspace-mark" style={{ background: workspace.color }} />
						<div className="workspace-copy">
							<strong>{workspace.name}</strong>
							<small>{workspace.path ?? "Folder not connected"}</small>
						</div>
						<span className="workspace-stat">{workspace.path ? `${workspaceSessions.get(workspace.path) ?? 0} sessions` : "Needs folder"}</span>
						{workspace.path ? (
							<button className="row-action primary" onClick={() => onOpenWorkspace(workspace)}>Open</button>
						) : (
							<button className="row-action primary" onClick={() => void chooseWorkspaceFolder(workspace)}>Connect folder</button>
						)}
						<button className="row-icon" aria-label={`Delete ${workspace.name}`} onClick={() => { removeWorkspace(workspace.id); refreshLocal(); }}>×</button>
					</div>
				))}
			</div>
		);
	}

	function content(): React.ReactNode {
		switch (view) {
			case "Home":
				return (
					<>
						<section className="dash-section">
							<div className="section-head"><div><h2>Workspaces</h2><p>Folder-backed environments the agent can operate in.</p></div><button className="text-action" onClick={() => setView("Spaces")}>View all</button></div>
							{workspaceGrid()}
						</section>
						<div className="dash-columns">
							<section className="dash-section grow">
								<div className="section-head"><div><h2>Active tasks</h2><p>Persisted TODO items from real AXIOM sessions.</p></div><b>{summary.activeTasks.length}</b></div>
								{summary.activeTasks.length ? <div className="data-list">{summary.activeTasks.slice(0, 8).map((task, index) => <DataRow key={`${task.sessionId}_${index}`} label={task.text} value={task.status.replaceAll("_", " ")} detail={task.updatedAt ? relativeTime(Date.parse(task.updatedAt)) : undefined} />)}</div> : <Empty title="No active tasks" detail="Tasks created by the agent with todo_list will appear here." />}
							</section>
							<section className="dash-section side">
								<div className="section-head"><div><h2>Recent activity</h2><p>Local workspace events.</p></div></div>
								{activity.length ? <div className="activity-list">{activity.slice(0, 8).map((event) => <div key={event.id}><time>{relativeTime(event.time)}</time><span>{event.message}</span></div>)}</div> : <Empty title="No activity yet" detail="Workspace and agent actions will be recorded here." />}
							</section>
						</div>
						<section className="dash-section">
							<div className="section-head"><div><h2>Runtime snapshot</h2><p>Current session plus persisted AXIOM stores.</p></div><button className="text-action" onClick={() => void refreshRuntime()}>Refresh</button></div>
							<div className="metric-strip">
								<DataRow label="Sessions" value={summary.sessions || sessions.length} />
								<DataRow label="Tool calls" value={stats?.toolCalls ?? 0} />
								<DataRow label="Tokens" value={formatNumber(stats?.tokens.total ?? 0)} />
								<DataRow label="Stored context" value={formatBytes(summary.storedBytes)} />
							</div>
						</section>
					</>
				);
			case "Spaces":
				return <section className="dash-section"><div className="section-head"><div><h2>Workspaces</h2><p>Every workspace is bound to an actual folder.</p></div><button className="btn-primary" onClick={() => void chooseWorkspaceFolder()}>Choose folder</button></div>{workspaceGrid()}</section>;
			case "Agents":
				return <section className="dash-section"><div className="section-head"><div><h2>Local agent</h2><p>The same AXIOM runtime powers Chat, IDE, and Space.</p></div><span className="status-good">Ready</span></div><div className="data-list"><DataRow label="Model" value={config?.agentModel ?? "Configured model"} /><DataRow label="Current session" value={stats?.sessionId ?? "Not started"} /><DataRow label="Messages" value={stats?.totalMessages ?? 0} /><DataRow label="Tool calls" value={stats?.toolCalls ?? 0} /></div></section>;
			case "Memory":
				return <section className="dash-section"><div className="section-head"><div><h2>Context Agent memory</h2><p>Real entries persisted under the AXIOM agent data directory.</p></div></div><div className="data-list"><DataRow label="Reflections" value={summary.reflections} /><DataRow label="Skills" value={summary.skills} /><DataRow label="Memory records" value={summary.memories} /><DataRow label="Code understandings" value={summary.understandings} /><DataRow label="Context ledger files" value={summary.contextLedgerFiles} /></div></section>;
			case "Knowledge":
				return <section className="dash-section"><div className="section-head"><div><h2>Knowledge stores</h2><p>Inspectable indexes and graphs created by AXIOM tools.</p></div></div><div className="data-list"><DataRow label="Knowledge graph files" value={summary.knowledge} /><DataRow label="SparseTreeGrep indexes" value={summary.documentIndexes} /><DataRow label="Code graphs" value={summary.codeGraphs} /><DataRow label="Flow graphs" value={summary.flowGraphs} /><DataRow label="Failure fingerprints" value={summary.failureFingerprints} /></div></section>;
			case "Search":
				return <><section className="dash-section"><div className="section-head"><div><h2>Search AXIOM</h2><p>Search saved sessions, workspaces, and active tasks.</p></div></div><input className="dash-query" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, prompts, folders, and tasks" /></section><section className="dash-section"><h2>Workspaces</h2>{searchResults.workspaces.length ? <div className="data-list">{searchResults.workspaces.map((workspace) => <button className="search-hit" key={workspace.id} onClick={() => workspace.path ? onOpenWorkspace(workspace) : void chooseWorkspaceFolder(workspace)}><strong>{workspace.name}</strong><span>{workspace.path ?? "Connect a folder"}</span></button>)}</div> : <Empty title="No workspace matches" detail="Try a folder name or path." />}</section><section className="dash-section"><h2>Sessions</h2><SessionRows sessions={searchResults.sessions} onOpen={onOpenSession} /></section></>;
			case "Checkpoints":
				return <section className="dash-section"><div className="section-head"><div><h2>Saved sessions</h2><p>Durable checkpoints written by the agent runtime.</p></div><b>{sessions.length}</b></div><SessionRows sessions={sessions.slice(0, 50)} onOpen={onOpenSession} /></section>;
			case "Cognitive Replay":
				return <section className="dash-section"><div className="section-head"><div><h2>Cognitive replay</h2><p>Resume a prior branch with its messages and working directory intact.</p></div></div><SessionRows sessions={sessions.slice(0, 50)} onOpen={onOpenSession} /></section>;
			case "Metrics":
				return <section className="dash-section"><div className="section-head"><div><h2>Measured runtime data</h2><p>Provider-reported current-session usage and local store sizes.</p></div></div><div className="data-list"><DataRow label="Input tokens" value={formatNumber(stats?.tokens.input ?? 0)} /><DataRow label="Output tokens" value={formatNumber(stats?.tokens.output ?? 0)} /><DataRow label="Cache reads" value={formatNumber(stats?.tokens.cacheRead ?? 0)} /><DataRow label="Tool calls" value={stats?.toolCalls ?? 0} /><DataRow label="Current cost" value={`$${(stats?.cost ?? 0).toFixed(4)}`} /><DataRow label="Persisted data" value={formatBytes(summary.storedBytes)} /></div></section>;
			case "Settings":
				return <section className="dash-section"><div className="section-head"><div><h2>Interface settings</h2><p>Saved locally and applied immediately.</p></div></div><label className="setting-row"><span><strong>Compact tool activity</strong><small>Reduce vertical space used by expanded chat tool logs.</small></span><input type="checkbox" checked={compactTools} onChange={(event) => setCompactTools(event.target.checked)} /></label><label className="setting-row"><span><strong>Reduce motion</strong><small>Disable nonessential interface animation.</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /></label><DataRow label="Default theme" value="Dark workbench" detail="Space and Dashboard remain light work surfaces." /></section>;
			case "Integrations":
				return <section className="dash-section"><div className="section-head"><div><h2>Runtime integrations</h2><p>Configuration reported by the running desktop process.</p></div></div><div className="data-list"><DataRow label="Agent model" value={config?.agentModel ?? "Not reported"} /><DataRow label="Space model" value={config?.spaceModel ?? "Not reported"} /><DataRow label="Agent RPC" value={dataError ? "Unavailable" : "Connected"} /><DataRow label="Working directory" value={config?.cwd ?? "Not reported"} /></div>{dataError && <div className="inline-error">{dataError}</div>}</section>;
			case "Billing":
				return <section className="dash-section"><div className="section-head"><div><h2>Usage</h2><p>AXIOM does not invent account billing data; these values come from the active session.</p></div></div><div className="data-list"><DataRow label="Provider-reported cost" value={`$${(stats?.cost ?? 0).toFixed(4)}`} /><DataRow label="Total tokens" value={formatNumber(stats?.tokens.total ?? 0)} /><DataRow label="Cache reads" value={formatNumber(stats?.tokens.cacheRead ?? 0)} /></div></section>;
			case "Team":
				return <section className="dash-section"><div className="section-head"><div><h2>Local operator</h2><p>This build is a single-user local runtime; no remote team service is configured.</p></div><span className="status-neutral">Local</span></div><div className="data-list"><DataRow label="Workspaces" value={workspaces.length} /><DataRow label="Saved sessions" value={sessions.length} /><DataRow label="Platform" value={config?.platform ?? navigator.platform} /></div></section>;
		}
	}

	return (
		<div className="dash">
			<aside className="dash-nav">
				<div className="dash-brand"><AxiomWordmark size={22} dark /></div>
				<nav aria-label="Dashboard sections">
					{[NAV_TOP, NAV_MID, NAV_BOT].map((group, index) => (
						<div key={group[0]} className={index ? "nav-group divided" : "nav-group"}>
							{group.map((item) => <button key={item} className={`nav-item${view === item ? " active" : ""}`} onClick={() => setView(item)}><span className="ni">{NAV_ICON[item]}</span><span>{item}</span></button>)}
						</div>
					))}
				</nav>
				<div className="nav-foot"><div className="runtime"><div className="rt-head"><span className="led" /> AXIOM Runtime <span className="rt-state">{dataError ? "Check" : "Ready"}</span></div><div className="rt-sub">{config?.agentModel ?? "Loading runtime…"}</div></div></div>
			</aside>

			<main className="dash-main">
				<header className="dash-top">
					<div><div className="dt-title">{view}</div><div className="dt-sub">Command Center</div></div>
					<label className="dt-search">⌕<input value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value) setView("Search"); }} placeholder="Search sessions, workspaces, tasks" /></label>
					<button className="btn-primary" onClick={() => void chooseWorkspaceFolder()}>New workspace</button>
				</header>

				{creating && draftFolder && (
					<section className="workspace-create">
						<div><strong>Create workspace</strong><span>{draftFolder.root}</span></div>
						<input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitCreate(); if (event.key === "Escape") setCreating(false); }} aria-label="Workspace name" />
						<button className="btn-primary" onClick={commitCreate}>Create</button>
						<button className="row-action" onClick={() => { setCreating(false); setDraftFolder(null); }}>Cancel</button>
					</section>
				)}

				<div className="dash-content">{content()}</div>
				<footer className="dash-foot"><span>AXIOM Desktop</span><span>Real local data · no seeded metrics</span></footer>
			</main>
		</div>
	);
}
