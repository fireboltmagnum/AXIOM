// The four surfaces (plus the new-tab launcher). A tab is just a surface + its
// project binding + view state — all surfaces of a project share one agent brain.

export type SurfaceKind = "launcher" | "chat" | "space" | "dashboard" | "ide";

export interface Tab {
	id: string;
	kind: SurfaceKind;
	title: string;
	/** Project the surface is bound to (null on the launcher). */
	projectId: string | null;
}

export interface SurfaceMeta {
	kind: Exclude<SurfaceKind, "launcher">;
	label: string;
	glyph: string;
	/** Accent dot color used in the bookmark rail + launcher cards. */
	color: string;
	desc: string;
}

export const SURFACES: SurfaceMeta[] = [
	{ kind: "space", label: "SPACE", glyph: "◍", color: "#8b7cf6", desc: "infinite whiteboard" },
	{ kind: "chat", label: "Chat", glyph: "✦", color: "#ff7a6b", desc: "talk to the agent" },
	{ kind: "dashboard", label: "Dashboard", glyph: "▦", color: "#3aa3ff", desc: "command center" },
	{ kind: "ide", label: "IDE", glyph: "▤", color: "#39c98a", desc: "code + agent" },
];

let counter = 0;
export function newTabId(): string {
	counter += 1;
	return `tab_${Date.now().toString(36)}_${counter}`;
}
