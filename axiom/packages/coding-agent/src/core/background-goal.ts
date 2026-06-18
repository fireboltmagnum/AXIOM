/**
 * Persistent background goal (`/goal`).
 *
 * A background goal is a durable objective the user sets once and the agent then
 * pursues across every subsequent turn and prompt — the small-model analogue of
 * keeping a north star in view so it doesn't drift mid-task. The goal lives on the
 * session and is folded into the very bottom of the system prompt on each prompt,
 * so it rides along on every continuation turn without polluting the transcript.
 *
 * This module is the pure formatter, kept separate so it can be unit-tested
 * without standing up a full session.
 */

const GOAL_OPEN = "<background_goal>";
const GOAL_CLOSE = "</background_goal>";

/**
 * Render the system-prompt block for a background goal. Returns "" for an empty
 * goal so callers can append unconditionally.
 */
export function formatBackgroundGoalBlock(goal: string | undefined): string {
	const trimmed = goal?.trim();
	if (!trimmed) return "";
	return [
		GOAL_OPEN,
		"This is a standing objective the user set with /goal. Keep making concrete progress toward it on every turn until it is fully achieved.",
		"Do not lose track of it, and do not stop while there are still actionable steps toward it. Treat the immediate user message as the next step in service of this goal unless the user changes course.",
		"",
		trimmed,
		GOAL_CLOSE,
	].join("\n");
}

/** Normalize raw `/goal` argument text into a stored goal (or undefined to clear). */
export function normalizeGoalInput(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	const lowered = trimmed.toLowerCase();
	if (lowered === "clear" || lowered === "none" || lowered === "off" || lowered === "reset") return undefined;
	return trimmed;
}
