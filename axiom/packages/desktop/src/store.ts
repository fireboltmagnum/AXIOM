// Minimal persistent data layer (localStorage). Real user data — empty for a new
// user (so the Dashboard shows honest empty states, not fake demo cards).

export interface Workspace {
	id: string;
	name: string;
	color: string;
	/** Absolute folder path. Older saved workspaces may not have one yet. */
	path?: string;
	createdAt: number;
	lastOpenedAt?: number;
}

export interface ActivityEvent {
	id: string;
	time: number;
	message: string;
	workspace: string;
}

export interface SpaceBoardState {
	cards: unknown[];
	elements: unknown[];
	links: unknown[];
	view: { scrollX: number; scrollY: number; zoom: number };
	updatedAt: number;
}

const WS_KEY = "axiom.workspaces";
const EV_KEY = "axiom.activity";
const SPACE_PREFIX = "axiom.space.";
const COLORS = ["#8b7cf6", "#3aa3ff", "#39c98a", "#f59e42", "#ec6cb0"];

function read<T>(key: string): T[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}
function write<T>(key: string, val: T[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(val));
	} catch {
		// storage full / unavailable — best effort
	}
}

export function loadWorkspaces(): Workspace[] {
	return read<Workspace>(WS_KEY);
}

export function addWorkspace(name: string, path?: string): Workspace {
	const list = loadWorkspaces();
	const ws: Workspace = {
		id: `ws_${Date.now().toString(36)}`,
		name: name.trim() || "Untitled workspace",
		color: COLORS[list.length % COLORS.length],
		path,
		createdAt: Date.now(),
		lastOpenedAt: path ? Date.now() : undefined,
	};
	write(WS_KEY, [...list, ws]);
	logActivity(`Created workspace "${ws.name}"`, ws.name);
	return ws;
}

export function updateWorkspace(
	id: string,
	patch: Partial<Pick<Workspace, "name" | "path" | "lastOpenedAt">>,
): Workspace | undefined {
	const list = loadWorkspaces();
	let updated: Workspace | undefined;
	write(
		WS_KEY,
		list.map((workspace) => {
			if (workspace.id !== id) return workspace;
			updated = { ...workspace, ...patch };
			return updated;
		}),
	);
	return updated;
}

export function removeWorkspace(id: string): void {
	write(
		WS_KEY,
		loadWorkspaces().filter((w) => w.id !== id),
	);
}

export function loadActivity(): ActivityEvent[] {
	return read<ActivityEvent>(EV_KEY).sort((a, b) => b.time - a.time);
}

export function logActivity(message: string, workspace = ""): void {
	const ev: ActivityEvent = {
		id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
		time: Date.now(),
		message,
		workspace,
	};
	write(EV_KEY, [...read<ActivityEvent>(EV_KEY), ev].slice(-100));
}

export function loadSpaceBoard(sessionKey: string): SpaceBoardState | undefined {
	try {
		const raw = localStorage.getItem(`${SPACE_PREFIX}${sessionKey}`);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as Partial<SpaceBoardState>;
		if (!Array.isArray(parsed.cards) || !Array.isArray(parsed.elements) || !Array.isArray(parsed.links))
			return undefined;
		return {
			cards: parsed.cards,
			elements: parsed.elements,
			links: parsed.links,
			view: parsed.view ?? { scrollX: 0, scrollY: 0, zoom: 1 },
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
		};
	} catch {
		return undefined;
	}
}

export function saveSpaceBoard(sessionKey: string, state: Omit<SpaceBoardState, "updatedAt">): void {
	try {
		localStorage.setItem(`${SPACE_PREFIX}${sessionKey}`, JSON.stringify({ ...state, updatedAt: Date.now() }));
	} catch {
		// storage full / unavailable — best effort
	}
}

export function relativeTime(ts: number): string {
	const s = Math.floor((Date.now() - ts) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
