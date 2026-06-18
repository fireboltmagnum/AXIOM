import type { AgentTool } from "@axiom/agent-core";
import { Text } from "@axiom/tui";
import { type Static, Type } from "typebox";
import {
	type DeepResearchBrowserMode,
	DeepResearchEngine,
	formatDeepResearchEvidence,
} from "../../axiom/DeepResearch.ts";
import { PlaywrightPageExtractor } from "../../axiom/PlaywrightPageExtractor.ts";
import {
	formatWebFetchEvidence,
	formatWebResearchEvidence,
	formatWebSearchEvidence,
	WebResearchEngine,
	type WebResearchEngineOptions,
	type WebSearchProvider,
} from "../../axiom/WebResearch.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const providerSchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("all"),
	Type.Literal("brave"),
	Type.Literal("tavily"),
	Type.Literal("exa"),
	Type.Literal("jina"),
	Type.Literal("bing"),
	Type.Literal("duckduckgo"),
]);

const webResearchSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("search"), Type.Literal("fetch"), Type.Literal("research"), Type.Literal("deep_research")],
		{
			description:
				"search returns ranked snippets; fetch extracts known URLs; research performs one federated search/fetch pass; deep_research iterates until evidence coverage is strong or its budget is exhausted.",
		},
	),
	query: Type.Optional(Type.String({ description: "Primary web search query." })),
	queries: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional query variants for broader recall, up to 4. Used with query when both are supplied.",
		}),
	),
	url: Type.Optional(Type.String({ description: "Single URL for action=fetch." })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "URLs for action=fetch, up to 10." })),
	provider: Type.Optional(
		Type.Union([providerSchema], {
			description:
				"auto selects the best configured provider with fallback; all federates configured providers; bing and duckduckgo need no API key.",
		}),
	),
	count: Type.Optional(Type.Number({ description: "Maximum ranked search results, 1-20 (default 8)." })),
	topic: Type.Optional(
		Type.Union([Type.Literal("general"), Type.Literal("news")], {
			description: "Use news for current-event reporting; general for everything else.",
		}),
	),
	freshness: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Optional recency window.",
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Restrict search to these domains when the provider supports it." }),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude these domains when the provider supports it." }),
	),
	fetchTop: Type.Optional(
		Type.Number({ description: "For action=research, fetch full content for top 1-8 sources." }),
	),
	maxCharsPerPage: Type.Optional(
		Type.Number({ description: "Maximum extracted characters per fetched page (default 8000)." }),
	),
	maxTotalChars: Type.Optional(
		Type.Number({ description: "Total full-content evidence budget across fetched pages (default 32000)." }),
	),
	maxRounds: Type.Optional(Type.Number({ description: "For deep_research, maximum iterative search rounds, 1-5." })),
	maxSources: Type.Optional(Type.Number({ description: "For deep_research, maximum ranked sources, 3-30." })),
	minFullSources: Type.Optional(
		Type.Number({ description: "For deep_research, minimum full-content sources before early stopping." }),
	),
	coverageThreshold: Type.Optional(
		Type.Number({ description: "For deep_research, target evidence coverage from 0.35 to 0.98." }),
	),
	browser: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("off"), Type.Literal("force")], {
			description:
				"Playwright extraction for dynamic pages: auto uses it only when normal extraction is thin; force tries it on selected pages; off disables it.",
		}),
	),
});

export type WebResearchToolInput = Static<typeof webResearchSchema>;

export interface WebResearchToolDetails {
	action: WebResearchToolInput["action"];
	providers: string[];
	resultCount: number;
	fetchedCount: number;
	warningCount: number;
	roundCount?: number;
	coverage?: number;
}

export interface WebResearchToolOptions extends WebResearchEngineOptions {
	cwd?: string;
}

export function createWebResearchToolDefinition(
	options: WebResearchToolOptions = {},
): ToolDefinition<typeof webResearchSchema, WebResearchToolDetails> {
	const engine = new WebResearchEngine(options);
	const deepResearch = new DeepResearchEngine({
		backend: engine,
		browserExtractor: new PlaywrightPageExtractor({ cwd: options.cwd ?? process.cwd() }),
	});
	return {
		name: "web_research",
		label: "Web research",
		description:
			"Search and investigate the live web with provider fallback, iterative deep research, evidence-gap expansion, source-quality scoring, claim audits, conflict detection, Playwright extraction for dynamic pages, safe bounded full-page evidence, and citation-ready [S#] source IDs.",
		promptSnippet: "Search, fetch, or run bounded multi-round deep research with audited full-content evidence",
		promptGuidelines: [
			"Use web_research for current, external, factual, product, API, news, recommendation, or source-backed questions; do not answer unstable facts from memory.",
			"Use action=search for discovery, action=fetch for URLs already known, action=research for a fast one-pass evidence pack, and action=deep_research for broad, disputed, high-stakes, comparative, or multi-hop questions.",
			"For technical research, prioritize official documentation and primary sources with includeDomains when known. Fetch full pages before making detailed claims; snippets are discovery leads only.",
			"Deep research should normally use 2-3 rounds. Inspect its coverage, remaining gaps, claim audit, and potential conflicts before synthesizing; do not hide unresolved evidence conflicts.",
			"Leave browser=auto unless a JavaScript-rendered page is known to require Playwright. Browser extraction is a slower fallback, not the default retrieval path.",
			"Use freshness/topic=news for time-sensitive queries. Compare publication dates and distinguish the event date from the article date.",
			"Cite externally verifiable claims with the tool's [S#] IDs and include source URLs. If sources conflict, fetch additional primary evidence and state the conflict.",
		],
		parameters: webResearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: WebResearchToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (params.action === "fetch") {
				const urls = normalizeUrls(params);
				const response = await engine.fetchPages({
					urls,
					maxCharsPerPage: params.maxCharsPerPage,
					maxTotalChars: params.maxTotalChars,
					signal,
				});
				return {
					content: [{ type: "text", text: formatWebFetchEvidence(response) }],
					details: {
						action: params.action,
						providers: uniqueProviders(response.pages.map((page) => page.extractor)),
						resultCount: response.pages.length,
						fetchedCount: response.pages.length,
						warningCount: response.warnings.length,
					},
				};
			}

			const queries = normalizeQueries(params);
			const common = {
				queries,
				provider: (params.provider ?? "auto") as WebSearchProvider,
				count: params.count,
				topic: params.topic,
				freshness: params.freshness,
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
				signal,
			};
			if (params.action === "search") {
				const response = await engine.search(common);
				return {
					content: [{ type: "text", text: formatWebSearchEvidence(response) }],
					details: {
						action: params.action,
						providers: response.providers,
						resultCount: response.results.length,
						fetchedCount: 0,
						warningCount: response.warnings.length,
					},
				};
			}

			if (params.action === "deep_research") {
				const response = await deepResearch.research({
					query: queries[0]!,
					queries: queries.slice(1),
					provider: common.provider,
					topic: common.topic,
					freshness: common.freshness,
					includeDomains: common.includeDomains,
					excludeDomains: common.excludeDomains,
					maxRounds: params.maxRounds,
					maxSources: params.maxSources,
					fetchPerRound: params.fetchTop,
					maxCharsPerPage: params.maxCharsPerPage,
					maxTotalChars: params.maxTotalChars ?? 64_000,
					minFullSources: params.minFullSources,
					coverageThreshold: params.coverageThreshold,
					browser: (params.browser ?? "auto") as DeepResearchBrowserMode,
					signal,
				});
				return {
					content: [{ type: "text", text: formatDeepResearchEvidence(response) }],
					details: {
						action: params.action,
						providers: uniqueProviders(response.sources.flatMap((source) => source.providers)),
						resultCount: response.sources.length,
						fetchedCount: response.sources.filter((source) => source.page !== undefined).length,
						warningCount: response.warnings.length,
						roundCount: response.rounds.length,
						coverage: response.coverage.score,
					},
				};
			}

			const response = await engine.research({
				...common,
				fetchTop: params.fetchTop,
				maxCharsPerPage: params.maxCharsPerPage,
				maxTotalChars: params.maxTotalChars,
			});
			return {
				content: [{ type: "text", text: formatWebResearchEvidence(response) }],
				details: {
					action: params.action,
					providers: response.providers,
					resultCount: response.results.length,
					fetchedCount: response.pages.length,
					warningCount: response.warnings.length,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const action = str(args?.action);
			const detail = args?.query
				? ` "${args.query}"`
				: args?.url
					? ` ${args.url}`
					: args?.queries?.length
						? ` ${args.queries.length} queries`
						: args?.urls?.length
							? ` ${args.urls.length} URLs`
							: "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("Web research"))} ${
					action === null ? invalidArgText(theme) : theme.fg("accent", action || "")
				}${theme.fg("toolOutput", detail)}`,
			);
			return text;
		},
		renderResult(result, renderOptions: ToolRenderResultOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as never, context.showImages).trim();
			if (!output) {
				text.setText("");
				return text;
			}
			const lines = output.split("\n");
			const maxLines = renderOptions.expanded ? lines.length : 30;
			const display = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			if (lines.length > maxLines) {
				display.push(
					theme.fg(
						"muted",
						`... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`,
					),
				);
			}
			text.setText(`\n${display.join("\n")}`);
			return text;
		},
	};
}

export function createWebResearchTool(options: WebResearchToolOptions = {}): AgentTool<typeof webResearchSchema> {
	return wrapToolDefinition(createWebResearchToolDefinition(options));
}

function normalizeQueries(params: WebResearchToolInput): string[] {
	const queries = [params.query, ...(params.queries ?? [])]
		.map((query) => query?.trim())
		.filter((query): query is string => !!query);
	if (queries.length === 0) throw new Error(`web_research action=${params.action} requires query or queries.`);
	return [...new Set(queries)].slice(0, 4);
}

function normalizeUrls(params: WebResearchToolInput): string[] {
	const urls = [params.url, ...(params.urls ?? [])].map((url) => url?.trim()).filter((url): url is string => !!url);
	if (urls.length === 0) throw new Error("web_research action=fetch requires url or urls.");
	return [...new Set(urls)].slice(0, 10);
}

function uniqueProviders(providers: string[]): string[] {
	return [...new Set(providers)];
}
