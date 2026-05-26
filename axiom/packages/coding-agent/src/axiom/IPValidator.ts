import type { AssistantMessage } from "@axiom/ai";
import type {
	AxiomAssistantValidationContext,
	AxiomIPCategory,
	AxiomIPIssue,
	AxiomIPValidationResult,
} from "./RuntimeTypes.ts";

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((part) => part.type === "toolCall");
}

function snippet(text: string, limit = 160): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

interface CodeBlock {
	lang: string;
	body: string;
	openLine: number;
}

/** Extract fenced code blocks and detect unclosed/malformed fences. */
function parseFences(text: string): { blocks: CodeBlock[]; unclosed: boolean; mismatched: boolean } {
	const blocks: CodeBlock[] = [];
	const lines = text.split(/\r?\n/);
	let open: { lang: string; bodyStart: number; openLine: number; fence: string } | null = null;
	let mismatched = false;
	const fenceRe = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9+_.-]*)\s*$/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = fenceRe.exec(line);
		if (!m) continue;
		const fence = m[2];
		const lang = m[3] ?? "";
		if (!open) {
			open = { lang, bodyStart: i + 1, openLine: i + 1, fence };
		} else {
			// Closing fence must use same delimiter character; length can vary in CommonMark
			// but for our heuristic we require same starting char.
			if (fence[0] !== open.fence[0]) {
				mismatched = true;
				continue;
			}
			const body = lines.slice(open.bodyStart, i).join("\n");
			blocks.push({ lang: open.lang, body, openLine: open.openLine });
			open = null;
		}
	}
	return { blocks, unclosed: open !== null, mismatched };
}

const PLACEHOLDER_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /\bTODO\b\s*[:(]/i, label: "TODO:" },
	{ re: /\bFIXME\b\s*[:(]/i, label: "FIXME:" },
	{ re: /\bXXX\b\s*[:(]/i, label: "XXX:" },
	{ re: /<INSERT[^>]{0,40}>/i, label: "<INSERT...>" },
	{ re: /<REPLACE[^>]{0,40}>/i, label: "<REPLACE...>" },
	{ re: /\[INSERT[^\]]{0,40}\]/i, label: "[INSERT...]" },
	{ re: /\[YOUR[_ ][A-Z ]{1,40}\]/, label: "[YOUR_...]" },
	{ re: /\bLorem ipsum\b/i, label: "Lorem ipsum" },
];

/**
 * Find repeated paragraphs (>= 60 chars, identical, occurring 2+ times) that
 * make up a meaningful slice of the response.
 *
 * Why the ratio guard: a long legitimate answer can quote the same 80-char API
 * signature or error message twice and that is fine. The pathology we want to
 * catch is the model getting stuck and emitting the same block over and over
 * — that pattern produces repetition that dominates the response. We only
 * flag when duplicated content is at least 35% of the total trimmed length.
 */
function findRepetition(text: string): string | undefined {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length >= 60);
	const seen = new Map<string, number>();
	for (const p of paragraphs) {
		seen.set(p, (seen.get(p) ?? 0) + 1);
	}
	const totalLen = text.replace(/\s+/g, " ").trim().length;
	if (totalLen === 0) return undefined;
	for (const [p, count] of seen) {
		if (count < 2) continue;
		const dupeChars = p.length * count;
		if (dupeChars / totalLen >= 0.35) return p;
	}
	return undefined;
}

/**
 * Detect the actual refusal-then-comply antipattern: the message OPENS with a
 * refusal (within the first sentence or first 200 chars) and then immediately
 * does the thing it just refused (code fence or numbered list within ~200 chars
 * of the refusal). The previous version flagged ANY "I cannot" anywhere in the
 * response and triggered on legitimate text like "I cannot show exact line
 * numbers without seeing your file. Here is what I recommend:" — those are
 * helpful answers, not contradictions.
 */
function findRefusalContradiction(text: string): string | undefined {
	const head = text.slice(0, 200);
	const refusalRe =
		/\b(i\s+(?:cannot|can(?:not|'t)|will\s+not|won't|am\s+unable\s+to))\s+(do|help|assist|provide|write|create|generate|produce|comply|answer)\b/i;
	const match = refusalRe.exec(head);
	if (!match) return undefined;
	// Look for structured "doing the task" within 250 chars after the refusal.
	const after = text.slice(match.index + match[0].length, match.index + match[0].length + 250);
	if (/```|^\s*\d+\.\s/m.test(after)) {
		return match[0];
	}
	return undefined;
}

function categoryHeading(category: AxiomIPCategory): string {
	switch (category) {
		case "shape":
			return "Shape";
		case "syntax":
			return "Syntax";
		case "logic":
			return "Logic";
		case "leak":
			return "Leakage";
		case "safety":
			return "Safety";
	}
}

/**
 * Sentinel that wraps every IP-retry feedback message. The interactive UI
 * filters messages whose text starts with this tag so the user never sees
 * AXIOM's internal critique of the model. The model still receives the full
 * payload — the wrapper is just markup, not censorship.
 */
export const AXIOM_IP_RETRY_TAG = "<axiom_internal_ip_retry>";
export const AXIOM_IP_RETRY_END_TAG = "</axiom_internal_ip_retry>";

function buildAgentFeedback(errors: AxiomIPIssue[]): string {
	const lines: string[] = [];
	lines.push(AXIOM_IP_RETRY_TAG);
	lines.push(
		"Your previous response was rejected by AXIOM's integrity check. Do not apologize or re-explain; just produce a corrected response that addresses every issue below.",
	);
	lines.push("");
	for (const issue of errors) {
		lines.push(`- [${categoryHeading(issue.category)}] ${issue.message}`);
		if (issue.fixHint) {
			lines.push(`  Fix: ${issue.fixHint}`);
		}
		if (issue.evidence) {
			lines.push(`  Offending text: ${issue.evidence}`);
		}
	}
	lines.push("");
	lines.push("Re-answer the original user request, keeping anything that was correct and fixing only what failed.");
	lines.push(AXIOM_IP_RETRY_END_TAG);
	return lines.join("\n");
}

/** True if a piece of user-message text is an internal IP-retry payload. */
export function isAxiomIPRetryText(text: string): boolean {
	return text.trimStart().startsWith(AXIOM_IP_RETRY_TAG);
}

export class IPValidator {
	validateAssistantMessage(context: AxiomAssistantValidationContext): AxiomIPValidationResult {
		const startedAt = Date.now();
		const checks: string[] = [];
		const issues: AxiomIPIssue[] = [];
		const { message, userText, classification } = context;
		const text = textFromAssistant(message);
		const toolCallOnly = !text && hasToolCalls(message);

		// --- Shape checks ------------------------------------------------------
		checks.push("assistant-message-finalized");
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			issues.push({
				code: "provider-stop-error",
				severity: "error",
				category: "shape",
				message: message.errorMessage || `Assistant stopped with ${message.stopReason}`,
				fixHint: "Retry the task; the previous attempt did not finish.",
			});
		}

		checks.push("non-empty-response");
		if (!text && !hasToolCalls(message)) {
			issues.push({
				code: "empty-response",
				severity: "error",
				category: "shape",
				message: "Assistant response has no text or tool call content.",
				fixHint: "Produce an actual response to the user's request.",
			});
		}

		checks.push("direct-response-shape");
		if ((classification.kind === "greeting" || classification.kind === "status") && text.length > 400) {
			issues.push({
				code: "overlong-simple-reply",
				severity: "warning",
				category: "shape",
				message: "A direct greeting/status reply should be short (under ~400 chars).",
				fixHint: "Reply with a brief, single-sentence response.",
			});
		}

		// All remaining checks only meaningful when there is actual text. A pure tool-call
		// message is fine; tool-call validation happens at agent-core level.
		if (toolCallOnly) {
			const status = issues.some((i) => i.severity === "error")
				? "failed"
				: issues.length > 0
					? "warning"
					: "passed";
			return { status, checks, issues, latencyMs: Date.now() - startedAt };
		}

		// --- Leakage checks ----------------------------------------------------
		checks.push("raw-internal-format-guard");
		const analysisLeak = /^\s*[*-]\s+(User says|Intent|Plan|Reasoning|Internal note)\s*:/im.exec(text);
		if (analysisLeak) {
			issues.push({
				code: "raw-analysis-leak",
				severity: "error",
				category: "leak",
				message: "Internal analysis notes leaked into the user-visible response.",
				fixHint: "Send only the final answer to the user. Keep analysis private.",
				evidence: snippet(analysisLeak[0], 80),
			});
		}

		// --- Syntax checks -----------------------------------------------------
		checks.push("balanced-code-fences");
		const fenceInfo = parseFences(text);
		if (fenceInfo.unclosed) {
			issues.push({
				code: "unclosed-code-fence",
				severity: "error",
				category: "syntax",
				message: "A markdown code fence (```) was opened but never closed.",
				fixHint: "Close every ``` block with a matching ``` on its own line.",
			});
		}
		if (fenceInfo.mismatched) {
			issues.push({
				code: "mismatched-code-fence",
				severity: "warning",
				category: "syntax",
				message: "Code fence delimiters (``` vs ~~~) are mixed within the same block.",
				fixHint: "Use the same fence style to open and close each code block.",
			});
		}

		checks.push("json-block-parse");
		for (const block of fenceInfo.blocks) {
			const langLower = block.lang.toLowerCase();
			if (langLower === "json" || langLower === "json5") {
				try {
					JSON.parse(block.body);
				} catch (err) {
					issues.push({
						code: "invalid-json-block",
						severity: "error",
						category: "syntax",
						message: `A \`\`\`${block.lang || "json"} block (around line ${block.openLine}) is not valid JSON.`,
						fixHint: "Fix the JSON: quote keys/strings, remove trailing commas, balance brackets.",
						evidence: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		checks.push("placeholder-leakage");
		for (const { re, label } of PLACEHOLDER_PATTERNS) {
			if (re.test(text)) {
				issues.push({
					code: "placeholder-text",
					severity: "error",
					category: "syntax",
					message: `Response contains a placeholder (${label}) that was not filled in.`,
					fixHint: `Replace ${label} with the actual content, or remove that section.`,
				});
				break; // one placeholder report is enough
			}
		}

		// --- Logic checks ------------------------------------------------------
		checks.push("paragraph-repetition");
		const repeated = findRepetition(text);
		if (repeated) {
			issues.push({
				code: "looping-output",
				severity: "error",
				category: "logic",
				message: "The response repeats the same paragraph multiple times (looping output).",
				fixHint: "Write each point once; remove duplicated paragraphs.",
				evidence: snippet(repeated, 120),
			});
		}

		checks.push("refusal-then-comply");
		const refusal = findRefusalContradiction(text);
		if (refusal) {
			issues.push({
				code: "refusal-contradiction",
				severity: "error",
				category: "logic",
				message: `The response refuses ("${refusal.trim()}") and then proceeds to do the task anyway.`,
				fixHint:
					"Decide one stance: either decline cleanly, or just do the task without prepending a refusal disclaimer.",
			});
		}

		// `findYesNoFlip` was removed: matching "yes" / "no" within a 300-char
		// window was a pure false-positive generator. It triggered on harmless
		// phrases like "yes please", "no longer", "yes there are no exceptions".
		// Detecting genuine ambiguity needs semantic understanding, not regex.

		// --- Echo guard --------------------------------------------------------
		checks.push("input-echo-guard");
		if (userText.length >= 80 && text.includes(userText.trim()) && text.length < userText.length * 1.5) {
			issues.push({
				code: "input-echo",
				severity: "warning",
				category: "shape",
				message: "Response largely echoes the user input without adding content.",
				fixHint: "Produce a substantive answer rather than restating the question.",
			});
		}

		const errors = issues.filter((i) => i.severity === "error");
		const status: AxiomIPValidationResult["status"] =
			errors.length > 0 ? "failed" : issues.length > 0 ? "warning" : "passed";

		return {
			status,
			checks,
			issues,
			latencyMs: Date.now() - startedAt,
			agentFeedback: errors.length > 0 ? buildAgentFeedback(errors) : undefined,
		};
	}
}
