import { Chat } from "../surfaces/Chat.tsx";
import { Dashboard } from "../surfaces/Dashboard.tsx";
import { IDE } from "../surfaces/IDE.tsx";
import { Space } from "../surfaces/Space.tsx";
import type { AgentSessionInfo } from "../bridge.ts";
import { loadWorkspaces, relativeTime, type Workspace } from "../store.ts";
import type { SurfaceKind } from "./types.ts";
import { SURFACES } from "./types.ts";
import { AxiomWordmark } from "./Logo.tsx";

export interface SpaceHandoff {
	id: string;
	text: string;
}

export function Launcher({
	onOpen,
	onOpenWorkspace,
}: {
	onOpen: (kind: Exclude<SurfaceKind, "launcher">) => void;
	onOpenWorkspace: (workspace: Workspace, kind?: SurfaceKind) => void;
}) {
	const recents = loadWorkspaces()
		.slice()
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, 6);
	return (
		<div className="launcher">
			<div className="launcher-inner">
				<div className="brand"><AxiomWordmark size={34} /></div>

				<div className="label">Open a surface</div>
				<div className="cards">
					{SURFACES.map((s) => (
						<button key={s.kind} className="card" onClick={() => onOpen(s.kind)}>
							<span className="c-icon" style={{ background: `${s.color}22`, color: s.color }}>
								{s.glyph}
							</span>
							<span className="c-name">{s.label}</span>
							<span className="c-desc">{s.desc}</span>
						</button>
					))}
				</div>

				<div className="label">Recent workspaces</div>
				{recents.length === 0 ? (
					<div className="recents-empty">Create a workspace from Dashboard to reopen its folder here.</div>
				) : (
					<div className="recents">
						{recents.map((r) => (
							<button key={r.id} className="row" onClick={() => onOpenWorkspace(r)}>
								<span style={{ color: r.color }}>◫</span>
								<span>{r.name}</span>
								<span className="meta">{relativeTime(r.lastOpenedAt ?? r.createdAt)}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export function Surface({
	kind,
	onOpen,
	onOpenSpace,
	spaceHandoff,
	sessionKey,
	spaceSessionKey,
	onSessionChanged,
	activeWorkspace,
	onOpenWorkspace,
	onOpenSession,
	onTransferSpace,
}: {
	kind: SurfaceKind;
	onOpen: (kind: Exclude<SurfaceKind, "launcher">) => void;
	onOpenSpace: (handoff?: { text: string }) => void;
	spaceHandoff?: SpaceHandoff;
	sessionKey: string;
	spaceSessionKey: string;
	onSessionChanged: () => void;
	activeWorkspace: Workspace | null;
	onOpenWorkspace: (workspace: Workspace, kind?: SurfaceKind) => void;
	onOpenSession: (session: AgentSessionInfo) => void;
	onTransferSpace: (handoff: { text: string; image?: { mimeType: string; data: string } }) => void;
}) {
	switch (kind) {
		case "launcher":
			return <Launcher onOpen={onOpen} onOpenWorkspace={onOpenWorkspace} />;
		case "chat":
			return <Chat onOpenSpace={onOpenSpace} sessionKey={sessionKey} onSessionChanged={onSessionChanged} workspaceName={activeWorkspace?.name} />;
		case "dashboard":
			return <Dashboard onOpenWorkspace={onOpenWorkspace} onOpenSession={onOpenSession} />;
		case "space":
			return <Space sessionKey={spaceSessionKey} incomingHandoff={spaceHandoff} onTransfer={onTransferSpace} />;
		case "ide":
			return <IDE initialPath={activeWorkspace?.path} workspaceName={activeWorkspace?.name} />;
	}
}
