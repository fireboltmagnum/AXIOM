import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentSessionInfo } from "./bridge.ts";
import { type SpaceHandoff, Surface } from "./shell/surfaces.tsx";
import { AxiomWordmark } from "./shell/Logo.tsx";
import { Settings } from "./shell/Settings.tsx";
import { Onboarding } from "./shell/Onboarding.tsx";
import { type SurfaceKind, SURFACES, type Tab, newTabId } from "./shell/types.ts";
import { loadWorkspaces, type Workspace, updateWorkspace } from "./store.ts";

const SURFACE_LABEL: Record<SurfaceKind, string> = {
	launcher: "New Tab",
	chat: "Chat",
	space: "Space",
	dashboard: "Dashboard",
	ide: "IDE",
};

export function App() {
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [tabs, setTabs] = useState<Tab[]>([
		{ id: newTabId(), kind: "chat", title: "Chat", projectId: "axiom" },
	]);
	const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
	const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
	const [sessionKey, setSessionKey] = useState("initial");
	const [spaceSessionKey, setSpaceSessionKey] = useState("initial");
	const [spaceHandoff, setSpaceHandoff] = useState<SpaceHandoff | undefined>();
	const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
	const [sessionQuery, setSessionQuery] = useState("");
	const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// null = still checking; true = show onboarding gate; false = configured.
	const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

	// Decide whether to show the first-run gate. "Done" = ANY working auth:
	// a Google login, a ChatGPT login, or any provider API key in ~/.axiom/.env.
	useEffect(() => {
		let cancelled = false;
		async function check() {
			try {
				const [env, gem, cdx] = await Promise.all([
					window.axiom.settings.read().catch(() => ({}) as Record<string, string>),
					window.axiom.settings.geminiOAuthStatus().catch(() => ({ loggedIn: false })),
					window.axiom.settings.codexOAuthStatus().catch(() => ({ loggedIn: false })),
				]);
				const hasKey = Object.entries(env).some(
					([k, v]) => k.endsWith("_API_KEY") && typeof v === "string" && v.trim() !== "",
				);
				const authed = gem.loggedIn || cdx.loggedIn || hasKey;
				if (!cancelled) setNeedsOnboarding(!authed);
			} catch {
				if (!cancelled) setNeedsOnboarding(false); // fail open — don't block the app
			}
		}
		void check();
		return () => { cancelled = true; };
	}, []);

	const refreshSessions = useCallback(async () => {
		try {
			setSessions(await window.axiom.agent.listSessions(true));
		} catch {
			setSessions([]);
		}
	}, []);

	useEffect(() => {
		void refreshSessions();
		const off = window.axiom?.agent.onEvent((event) => {
			if (event.type === "session_info_changed" || event.type === "agent_end") void refreshSessions();
		});
		return () => off?.();
	}, [refreshSessions]);

	const filteredSessions = useMemo(() => {
		const query = sessionQuery.trim().toLowerCase();
		if (!query) return sessions.slice(0, 30);
		return sessions.filter((session) =>
			[session.name, session.firstMessage, session.cwd].some((value) => value?.toLowerCase().includes(query)),
		).slice(0, 50);
	}, [sessions, sessionQuery]);

	function openTab(kind: SurfaceKind) {
		// If that surface kind is already open, just switch to it
		const existing = tabs.find((t) => t.kind === kind);
		if (existing) { setActiveId(existing.id); return; }
		const tab: Tab = {
			id: newTabId(),
			kind,
			title: SURFACE_LABEL[kind],
			projectId: kind === "launcher" ? null : "axiom",
		};
		setTabs((prev) => [...prev, tab]);
		setActiveId(tab.id);
	}

	function openSpaceWithHandoff(handoff?: { text: string }) {
		if (handoff?.text.trim()) {
			setSpaceHandoff({
				id: `chat_to_space_${Date.now()}`,
				text: handoff.text.trim(),
			});
		}
		openTab("space");
	}

	async function newChat() {
		try {
			await window.axiom.agent.newSession();
			const state = await window.axiom.agent.state().catch(() => undefined);
			const key = state?.sessionFile ?? `new_${Date.now()}`;
			setSessionKey(key);
			setSpaceSessionKey(key);
			await refreshSessions();
		} catch {
			const key = `local_${Date.now()}`;
			setSessionKey(key);
			setSpaceSessionKey(key);
		}
		openTab("chat");
	}

	async function switchSession(session: AgentSessionInfo) {
		try {
			await window.axiom.agent.switchSession(session.path);
			setSessionKey(`${session.path}_${Date.now()}`);
			setSpaceSessionKey(session.path);
			const workspace = loadWorkspaces().find((item) => item.path === session.cwd) ?? null;
			setActiveWorkspace(workspace);
			openTab("chat");
		} catch (error) {
			console.error("Could not switch AXIOM session", error);
		}
	}

	async function openWorkspace(workspace: Workspace, kind: SurfaceKind = "chat") {
		if (!workspace.path) {
			openTab("dashboard");
			return;
		}
		try {
			await window.axiom.agent.setFolder(workspace.path);
			await window.axiom.agent.newSession();
			const state = await window.axiom.agent.state().catch(() => undefined);
			const key = state?.sessionFile ?? `workspace_${workspace.id}_${Date.now()}`;
			const next = updateWorkspace(workspace.id, { lastOpenedAt: Date.now() }) ?? workspace;
			setActiveWorkspace(next);
			setSessionKey(key);
			setSpaceSessionKey(key);
			await refreshSessions();
			openTab(kind);
		} catch (error) {
			console.error("Could not open AXIOM workspace", error);
		}
	}

	// Space handed its board off to Chat: switch to the Chat tab and send the brief
	// (+ fit-to-all image) to the shared agent. Chat's event listener streams the
	// reply, so the coding model continues from the design.
	async function handleTransferSpace(handoff: { text: string; image?: { mimeType: string; data: string } }) {
		openTab("chat");
		try {
			const images = handoff.image ? [handoff.image] : undefined;
			await window.axiom.agent.prompt(handoff.text, images);
			await refreshSessions();
		} catch (error) {
			console.error("Could not transfer Space board to Chat", error);
		}
	}

	function closeTab(id: string) {
		setTabs((prev) => {
			const next = prev.filter((t) => t.id !== id);
			if (next.length === 0) {
				const fresh: Tab = { id: newTabId(), kind: "launcher", title: "New Tab", projectId: null };
				setActiveId(fresh.id);
				return [fresh];
			}
			if (id === activeId) setActiveId(next[next.length - 1].id);
			return next;
		});
	}

	function openFromLauncher(tabId: string, kind: Exclude<SurfaceKind, "launcher">) {
		setTabs((prev) =>
			prev.map((t) =>
				t.id === tabId ? { ...t, kind, title: SURFACE_LABEL[kind], projectId: "axiom" } : t,
			),
		);
	}

	return (
		<div className={`app sidebar-${sidebarOpen ? "open" : "closed"}`}>
			<header className="titlebar">
				<div className="window-brand no-drag">
					<button
						className="shell-icon"
						onClick={() => setSidebarOpen((open) => !open)}
						aria-label={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
						title={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
					>
						<span className="sidebar-glyph" aria-hidden="true" />
					</button>
					<AxiomWordmark className="axiom-wordmark" size={16} />
				</div>

				<div className="tabs no-drag" role="tablist" aria-label="Open AXIOM surfaces">
					{tabs.map((t) => (
						<div
							key={t.id}
							className={`tab${t.id === activeId ? " active" : ""}`}
							onClick={() => setActiveId(t.id)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") setActiveId(t.id);
							}}
							role="tab"
							tabIndex={0}
							aria-selected={t.id === activeId}
							aria-controls={`surface-${t.id}`}
							id={`tab-${t.id}`}
						>
							<span className="title">{t.title}</span>
							{tabs.length > 1 && (
								<button
									className="close"
									onClick={(event) => {
										event.stopPropagation();
										closeTab(t.id);
									}}
									aria-label="Close tab"
								>
									×
								</button>
							)}
						</div>
					))}
					<button className="icon-btn no-drag" onClick={() => openTab("launcher")} aria-label="New tab" title="New tab">
						+
					</button>
				</div>

				<div className="no-drag tb-right">
					<span className="runtime-state"><span /> Ready</span>
					<button
						className="shell-icon"
						onClick={() => setSettingsOpen(true)}
						aria-label="Settings"
						title="Settings"
					>
						<span className="settings-glyph" aria-hidden="true">⚙</span>
					</button>
				</div>
			</header>
			{settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
			{needsOnboarding === true && <Onboarding onDone={() => setNeedsOnboarding(false)} />}

			<div className="app-body">
				<aside className="shell-sidebar no-drag" aria-label="AXIOM navigation and sessions">
					<button className="new-task" onClick={() => void newChat()} title="New chat">
						<span className="new-task-icon">+</span>
						<span className="sidebar-copy"><b>New chat</b></span>
					</button>
					<button className="rail-action" onClick={() => setSessionSearchOpen((open) => !open)} title="Search chats">
						<span className="surface-icon" aria-hidden="true">⌕</span>
						<span className="sidebar-copy"><b>Search chats</b></span>
					</button>
					{sessionSearchOpen && sidebarOpen && (
						<input
							autoFocus
							className="session-search"
							placeholder="Search sessions"
							aria-label="Search sessions"
							value={sessionQuery}
							onChange={(event) => setSessionQuery(event.target.value)}
						/>
					)}
					<nav className="surface-nav">
						{SURFACES.map((surface) => {
							const active = tabs.some((tab) => tab.kind === surface.kind && tab.id === activeId);
							return (
								<button
									key={surface.kind}
									className={`surface-link${active ? " active" : ""}`}
									onClick={() => openTab(surface.kind)}
									title={sidebarOpen ? undefined : surface.label}
								>
									<span className="surface-icon" aria-hidden="true">{surface.glyph}</span>
									<span className="sidebar-copy">
										<b>{surface.label}</b>
										<small>{surface.desc}</small>
									</span>
								</button>
							);
						})}
					</nav>
					<div className="rail-recents">
						<div className="rail-section-label sidebar-copy">Recent sessions</div>
						{sidebarOpen && filteredSessions.length === 0 && <div className="rail-empty">No saved sessions match.</div>}
						{filteredSessions.map((session) => (
							<button
								key={session.path}
								className="session-link"
								onClick={() => void switchSession(session)}
								title={session.name || session.firstMessage || session.cwd}
							>
								<span className="session-glyph">◌</span>
								<span className="sidebar-copy"><b>{session.name || session.firstMessage || "Untitled session"}</b><small>{session.cwd || "AXIOM"}</small></span>
							</button>
						))}
					</div>
					<div className="sidebar-footer">
						<span className="agent-dot" />
						<span className="sidebar-copy">
							<b>Agent online</b>
							<small>Workspace connected</small>
						</span>
					</div>
				</aside>

				<main className="surface">
					{tabs.map((tab) => (
						<div
							key={tab.id}
							id={`surface-${tab.id}`}
							role="tabpanel"
							aria-labelledby={`tab-${tab.id}`}
							className={`surface-instance${tab.kind === "space" || tab.kind === "dashboard" ? " light-surface" : ""}`}
							style={{ display: tab.id === activeId ? "flex" : "none" }}
						>
							<Surface
								kind={tab.kind}
								onOpen={(kind) => openFromLauncher(tab.id, kind)}
								onOpenSpace={openSpaceWithHandoff}
								spaceHandoff={spaceHandoff}
								sessionKey={sessionKey}
								spaceSessionKey={spaceSessionKey}
								onSessionChanged={refreshSessions}
								activeWorkspace={activeWorkspace}
								onOpenWorkspace={openWorkspace}
								onOpenSession={switchSession}
								onTransferSpace={handleTransferSpace}
							/>
						</div>
					))}
				</main>
			</div>
		</div>
	);
}
