import { randomUUID } from "node:crypto";
import type { AxiomClassifyInput, AxiomTaskClassification, AxiomTaskKind, AxiomTaskRoute } from "./RuntimeTypes.ts";

const GREETING_RE = /^(hi|hii+|hello|hey|yo|sup|gm|good\s+(morning|afternoon|evening))\b/i;
const GRATITUDE_RE = /^(thanks|thank you|thx|ty)\b/i;
const IDENTITY_RE = /\b(who are you|what are you|your name|are you axiom|are you gemma)\b/i;
const STATUS_RE = /\b(you there|can you hear|can u hear|pls work|please work|are you working|test)\b/i;
const CODING_RE =
	/\b(code|file|repo|bug|fix|build|implement|terminal|typescript|javascript|python|api|test|compile|run|error|stack trace|ui|component)\b/i;
const COMMAND_RE = /^(\/|!|git\s|npm\s|pnpm\s|bun\s|node\s|python\s|tsc\b|npx\s)/i;

export class TaskClassifier {
	classify(input: AxiomClassifyInput): AxiomTaskClassification {
		const text = input.text.trim();
		const normalized = text.toLowerCase().replace(/\s+/g, " ");
		const words = normalized.length === 0 ? [] : normalized.split(/\s+/);
		const reasons: string[] = [];

		let kind: AxiomTaskKind = "general";
		let route: AxiomTaskRoute = "direct";
		let complexity = 20;
		let confidence = 0.55;
		let fastPathReply: string | undefined;

		if (COMMAND_RE.test(normalized)) {
			kind = "command";
			route = "agent";
			complexity = 55;
			confidence = 0.86;
			reasons.push("command-like input");
		} else if (CODING_RE.test(normalized)) {
			kind = "coding";
			route = "agent";
			complexity = Math.min(95, 45 + Math.floor(words.length / 8));
			confidence = 0.78;
			reasons.push("coding/development terms");
		} else if (GREETING_RE.test(normalized)) {
			kind = STATUS_RE.test(normalized) ? "status" : "greeting";
			route = "local";
			complexity = 5;
			confidence = 0.92;
			fastPathReply = STATUS_RE.test(normalized)
				? "Hey, I am here and working. What should we build next?"
				: "Hey. What do you want to work on?";
			reasons.push("short greeting/status check");
		} else if (GRATITUDE_RE.test(normalized) && words.length <= 8) {
			kind = "gratitude";
			route = "local";
			complexity = 4;
			confidence = 0.9;
			fastPathReply = "No problem.";
			reasons.push("short gratitude");
		} else if (IDENTITY_RE.test(normalized) && words.length <= 12) {
			kind = "identity";
			route = "local";
			complexity = 8;
			confidence = 0.88;
			fastPathReply = "I am AXIOM, your local coding agent runtime.";
			reasons.push("simple identity question");
		} else if (normalized.endsWith("?")) {
			kind = "question";
			route = "direct";
			complexity = Math.min(80, 20 + Math.floor(words.length / 5));
			confidence = 0.66;
			reasons.push("question form");
		}

		if (input.hasImages || input.hasPendingContext) {
			route = route === "local" ? "direct" : route;
			fastPathReply = undefined;
			complexity = Math.max(complexity, 35);
			confidence = Math.min(confidence, 0.7);
			reasons.push(input.hasImages ? "image input requires model path" : "pending context requires model path");
		}

		if (input.activeToolNames.length > 0 && route !== "local") {
			reasons.push(`tools available: ${input.activeToolNames.slice(0, 4).join(", ")}`);
		}

		return {
			id: randomUUID(),
			kind,
			route,
			complexity,
			confidence,
			fastPathReply,
			reasons,
		};
	}
}
