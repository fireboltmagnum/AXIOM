import { completeSimple, type Model } from "@axiom/ai";
import type { AxiomAbstraction } from "./RuntimeTypes.ts";

/**
 * Step-Back pre-reasoning abstraction. Maps a concrete user task to its
 * problem class and keywords so:
 *   1) the model gets a clearer framing in the system prompt
 *   2) Reflexion has stable keys to grep past lessons against
 *
 * When an LLM call is unavailable (no model, no key, stepBack disabled, or
 * the call fails), this falls back to a deterministic keyword extractor.
 */

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"with",
	"by",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"i",
	"you",
	"we",
	"they",
	"it",
	"this",
	"that",
	"my",
	"your",
	"our",
	"their",
	"its",
	"do",
	"does",
	"did",
	"done",
	"have",
	"has",
	"had",
	"please",
	"can",
	"could",
	"should",
	"would",
	"will",
	"may",
	"might",
	"just",
	"now",
	"new",
	"old",
	"some",
	"any",
	"how",
	"what",
	"why",
	"when",
	"where",
	"who",
	"which",
	"not",
	"no",
	"yes",
	"get",
	"got",
	"make",
	"made",
	"use",
	"using",
	"need",
	"want",
	"like",
	"one",
	"two",
	"three",
	"let",
	"lets",
	"also",
	"then",
	"than",
	"so",
	"about",
	"into",
	"from",
	"over",
	"under",
	"out",
	"up",
	"down",
	"very",
	"more",
	"most",
	"less",
	"few",
]);

const DOMAIN_HINTS: { domain: string; markers: RegExp }[] = [
	{
		domain: "coding",
		markers: /\b(fix|bug|implement|refactor|test|compile|typescript|python|rust|function|class|api)\b/i,
	},
	{ domain: "data", markers: /\b(dataset|csv|sql|query|column|row|aggregate|pandas|dataframe)\b/i },
	{ domain: "devops", markers: /\b(docker|kubernetes|deploy|ci\b|cd\b|terraform|nginx|systemd)\b/i },
	{ domain: "math", markers: /\b(equation|integral|derivative|theorem|proof|matrix|vector|prime)\b/i },
	{ domain: "writing", markers: /\b(write|essay|paragraph|tone|grammar|rewrite|summarize)\b/i },
];

function fallbackAbstraction(text: string, startedAt: number): AxiomAbstraction {
	const lower = text.toLowerCase();
	const tokens = lower
		.split(/[^a-z0-9_+#-]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
	const frequency = new Map<string, number>();
	for (const token of tokens) {
		frequency.set(token, (frequency.get(token) ?? 0) + 1);
	}
	const keywords = [...frequency.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8)
		.map(([t]) => t);

	let domain = "general";
	for (const { domain: d, markers } of DOMAIN_HINTS) {
		if (markers.test(text)) {
			domain = d;
			break;
		}
	}

	// Without an LLM we can't synthesize a problem class meaningfully; reuse the
	// top keywords as a placeholder so Reflexion still has something to grep.
	const problemClass = keywords.slice(0, 3);

	return {
		source: "fallback",
		problemClass,
		keywords,
		domain,
		latencyMs: Date.now() - startedAt,
	};
}

const STEP_BACK_SYSTEM_PROMPT = `You are a problem-abstraction assistant inside AXIOM. Your only job is to map a user task to its underlying problem class.

Reply with ONE valid JSON object and nothing else, matching this shape exactly:
{
  "problemClass": ["<2-4 short noun phrases naming the underlying problem class>"],
  "keywords": ["<3-8 lowercase keywords useful for retrieval>"],
  "domain": "<one of: coding, data, devops, math, writing, design, general>"
}

Rules:
- Do not answer the user task.
- Do not explain.
- Do not include code fences or commentary.
- Use lowercase keywords. Strip punctuation. Single words or short hyphenated terms only.
- If the task is trivial (greeting, status), still return valid JSON; domain may be "general".`;

interface LLMOptions {
	model: Model<any>;
	/** Provider auth resolved by the caller. */
	apiKey: string;
	headers?: Record<string, string>;
	/** Abort the call if it exceeds this many ms. */
	timeoutMs: number;
}

function extractJson(text: string): string | null {
	// Strip fences if the model ignored instructions and added them.
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) return fenced[1].trim();
	// Otherwise take the first balanced {...} block.
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseLLMResponse(raw: string, startedAt: number): AxiomAbstraction | null {
	const json = extractJson(raw);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as {
			problemClass?: unknown;
			keywords?: unknown;
			domain?: unknown;
		};
		const problemClass = Array.isArray(parsed.problemClass)
			? parsed.problemClass.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 6)
			: [];
		const keywords = Array.isArray(parsed.keywords)
			? parsed.keywords
					.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
					.map((s) => s.toLowerCase().trim())
					.slice(0, 12)
			: [];
		const domain =
			typeof parsed.domain === "string" && parsed.domain.trim().length > 0
				? parsed.domain.trim().toLowerCase()
				: "general";
		if (problemClass.length === 0 && keywords.length === 0) return null;
		return {
			source: "llm",
			problemClass,
			keywords,
			domain,
			latencyMs: Date.now() - startedAt,
		};
	} catch {
		return null;
	}
}

export class StepBackAbstractor {
	/**
	 * Returns a deterministic fallback abstraction (no LLM). Always safe to call.
	 */
	fallback(text: string): AxiomAbstraction {
		return fallbackAbstraction(text, Date.now());
	}

	/**
	 * Try an LLM-based abstraction. On any failure (timeout, parse, provider
	 * error), returns null — the caller should fall back to `fallback()`.
	 */
	async llm(text: string, options: LLMOptions): Promise<AxiomAbstraction | null> {
		const startedAt = Date.now();
		try {
			const result = await withTimeout(
				completeSimple(
					options.model,
					{
						systemPrompt: STEP_BACK_SYSTEM_PROMPT,
						messages: [{ role: "user", content: text, timestamp: Date.now() }],
					},
					{
						// Step-Back wants the cheapest path; omit reasoning so the provider's
						// default applies (Pi maps "minimal"/no-thinking when unspecified).
						reasoning: "minimal",
						apiKey: options.apiKey,
						headers: options.headers,
					},
				),
				options.timeoutMs,
			);
			if (!result) return null;
			const textParts = result.content
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("")
				.trim();
			if (!textParts) return null;
			return parseLLMResponse(textParts, startedAt);
		} catch {
			return null;
		}
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	if (ms <= 0) return promise;
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(null);
			});
	});
}
