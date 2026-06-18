import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type WebSearchProvider = "auto" | "all" | "brave" | "tavily" | "exa" | "jina" | "bing" | "duckduckgo";
export type WebSearchTopic = "general" | "news";
export type WebSearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchOptions {
	queries: string[];
	provider?: WebSearchProvider;
	count?: number;
	topic?: WebSearchTopic;
	freshness?: WebSearchFreshness;
	includeDomains?: string[];
	excludeDomains?: string[];
	signal?: AbortSignal;
	federated?: boolean;
}

export interface WebFetchOptions {
	urls: string[];
	maxCharsPerPage?: number;
	maxTotalChars?: number;
	signal?: AbortSignal;
}

export interface WebResearchOptions extends WebSearchOptions {
	fetchTop?: number;
	maxCharsPerPage?: number;
	maxTotalChars?: number;
}

export interface WebSearchHit {
	id: string;
	title: string;
	url: string;
	canonicalUrl: string;
	domain: string;
	snippet: string;
	publishedDate?: string;
	score: number;
	providers: string[];
	matchedQueries: string[];
	sourceType: "official" | "documentation" | "research" | "news" | "community" | "web";
}

export interface WebFetchedPage {
	id: string;
	title: string;
	url: string;
	canonicalUrl: string;
	domain: string;
	content: string;
	contentType: string;
	fetchedAt: string;
	truncated: boolean;
	extractor: "native" | "jina-reader" | "playwright";
}

export interface WebSearchResponse {
	queries: string[];
	providers: string[];
	results: WebSearchHit[];
	warnings: string[];
}

export interface WebFetchResponse {
	pages: WebFetchedPage[];
	warnings: string[];
}

export interface WebResearchResponse extends WebSearchResponse {
	pages: WebFetchedPage[];
}

interface ProviderHit {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
	providerScore?: number;
	provider: string;
	query: string;
	rank: number;
}

interface CacheEntry<T> {
	expiresAt: number;
	value: T;
}

export interface WebResearchEngineOptions {
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	lookupHost?: (hostname: string) => Promise<string[]>;
	searchCacheTtlMs?: number;
	pageCacheTtlMs?: number;
}

const SEARCH_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_SEARCH_QUERIES = 4;
const MAX_RESULTS = 20;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_PAGE_CHARS = 8_000;
const DEFAULT_TOTAL_CHARS = 32_000;
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"mc_cid",
	"mc_eid",
	"ref",
	"ref_src",
	"source",
	"utm_campaign",
	"utm_content",
	"utm_medium",
	"utm_source",
	"utm_term",
]);

export class WebResearchEngine {
	private readonly fetchImpl: typeof fetch;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly lookupHost: (hostname: string) => Promise<string[]>;
	private readonly searchCacheTtlMs: number;
	private readonly pageCacheTtlMs: number;
	private readonly searchCache = new Map<string, CacheEntry<WebSearchResponse>>();
	private readonly pageCache = new Map<string, CacheEntry<WebFetchedPage>>();

	constructor(options: WebResearchEngineOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
		this.lookupHost =
			options.lookupHost ??
			(async (hostname) => {
				const records = await lookup(hostname, { all: true, verbatim: true });
				return records.map((record) => record.address);
			});
		this.searchCacheTtlMs = options.searchCacheTtlMs ?? 5 * 60_000;
		this.pageCacheTtlMs = options.pageCacheTtlMs ?? 15 * 60_000;
	}

	async search(options: WebSearchOptions): Promise<WebSearchResponse> {
		const queries = normalizeQueries(options.queries);
		const count = clampInteger(options.count, 1, MAX_RESULTS, 8);
		const provider = options.provider ?? "auto";
		const cacheKey = JSON.stringify({
			queries,
			provider,
			count,
			topic: options.topic ?? "general",
			freshness: options.freshness,
			includeDomains: normalizeDomains(options.includeDomains),
			excludeDomains: normalizeDomains(options.excludeDomains),
			federated: options.federated === true,
		});
		const cached = this.readCache(this.searchCache, cacheKey);
		if (cached) return cached;

		const providers = this.resolveProviders(provider, options.federated === true);
		const warnings: string[] = [];
		const settled = await Promise.allSettled(
			queries.flatMap((query) =>
				providers.map(async (selectedProvider) => {
					const hits = await this.searchProvider(selectedProvider, query, count, options);
					return { provider: selectedProvider, hits };
				}),
			),
		);
		const providerHits: ProviderHit[] = [];
		const usedProviders = new Set<string>();
		for (const item of settled) {
			if (item.status === "fulfilled") {
				usedProviders.add(item.value.provider);
				providerHits.push(...item.value.hits);
			} else {
				warnings.push(normalizeError(item.reason));
			}
		}

		if (providerHits.length === 0 && !providers.includes("bing")) {
			try {
				const fallbackHits = await Promise.all(
					queries.map((query) => this.searchBing(query, count, options.signal)),
				);
				providerHits.push(...fallbackHits.flat());
				usedProviders.add("bing");
				warnings.push("Configured search providers returned no results; used Bing public-search fallback.");
			} catch (error) {
				warnings.push(`Bing fallback failed: ${normalizeError(error)}`);
			}
		}
		if (providerHits.length === 0 && !providers.includes("duckduckgo")) {
			try {
				const fallbackHits = await Promise.all(
					queries.map((query) => this.searchDuckDuckGo(query, count, options.signal)),
				);
				providerHits.push(...fallbackHits.flat());
				usedProviders.add("duckduckgo");
				warnings.push("Bing returned no results; used DuckDuckGo as the final no-key fallback.");
			} catch (error) {
				warnings.push(`DuckDuckGo fallback failed: ${normalizeError(error)}`);
			}
		}

		const results = rankAndDedupe(providerHits, queries, count);
		const response = {
			queries,
			providers: [...usedProviders],
			results,
			warnings: uniqueStrings(warnings),
		};
		this.writeCache(this.searchCache, cacheKey, response, this.searchCacheTtlMs);
		return response;
	}

	async fetchPages(options: WebFetchOptions): Promise<WebFetchResponse> {
		const urls = uniqueStrings(options.urls.map((url) => url.trim()).filter(Boolean)).slice(0, 10);
		const maxCharsPerPage = clampInteger(options.maxCharsPerPage, 500, 50_000, DEFAULT_PAGE_CHARS);
		const maxTotalChars = clampInteger(options.maxTotalChars, 1_000, 150_000, DEFAULT_TOTAL_CHARS);
		const settled = await Promise.allSettled(
			urls.map((url, index) => this.fetchPage(url, `S${index + 1}`, maxCharsPerPage, options.signal)),
		);
		const pages: WebFetchedPage[] = [];
		const warnings: string[] = [];
		let remaining = maxTotalChars;
		for (const item of settled) {
			if (item.status === "rejected") {
				warnings.push(normalizeError(item.reason));
				continue;
			}
			if (remaining <= 0) {
				warnings.push("Full-content budget exhausted; remaining URLs were omitted.");
				break;
			}
			const content = item.value.content.slice(0, remaining);
			pages.push({
				...item.value,
				content,
				truncated: item.value.truncated || content.length < item.value.content.length,
			});
			remaining -= content.length;
		}
		return { pages, warnings: uniqueStrings(warnings) };
	}

	async research(options: WebResearchOptions): Promise<WebResearchResponse> {
		const search = await this.search({
			...options,
			federated: options.provider === "all" || options.federated !== false,
		});
		const fetchTop = clampInteger(options.fetchTop, 1, 8, 4);
		const selected = selectDomainDiverse(search.results, fetchTop);
		const fetched = await this.fetchPages({
			urls: selected.map((result) => result.url),
			maxCharsPerPage: options.maxCharsPerPage,
			maxTotalChars: options.maxTotalChars,
			signal: options.signal,
		});
		const pageByCanonical = new Map(fetched.pages.map((page) => [page.canonicalUrl, page]));
		const pages = selected
			.map((result) => pageByCanonical.get(result.canonicalUrl))
			.filter((page): page is WebFetchedPage => page !== undefined)
			.map((page) => {
				const result = search.results.find((candidate) => candidate.canonicalUrl === page.canonicalUrl);
				return { ...page, id: result?.id ?? page.id };
			});
		return {
			...search,
			pages,
			warnings: uniqueStrings([...search.warnings, ...fetched.warnings]),
		};
	}

	private resolveProviders(provider: WebSearchProvider, federated: boolean): string[] {
		const configured = [
			this.env.BRAVE_SEARCH_API_KEY ? "brave" : undefined,
			this.env.TAVILY_API_KEY ? "tavily" : undefined,
			this.env.EXA_API_KEY ? "exa" : undefined,
			this.env.JINA_API_KEY ? "jina" : undefined,
		].filter((value): value is string => value !== undefined);
		if (provider === "duckduckgo") return ["duckduckgo"];
		if (provider === "bing") return ["bing"];
		if (provider !== "auto" && provider !== "all") {
			if (!configured.includes(provider)) {
				throw new Error(`${provider} search requires its API key in the environment.`);
			}
			return [provider];
		}
		if (provider === "all" || federated) {
			return configured.length > 0 ? configured : ["bing"];
		}
		return configured.length > 0 ? [configured[0]!] : ["bing"];
	}

	private async searchProvider(
		provider: string,
		query: string,
		count: number,
		options: WebSearchOptions,
	): Promise<ProviderHit[]> {
		switch (provider) {
			case "brave":
				return this.searchBrave(query, count, options);
			case "tavily":
				return this.searchTavily(query, count, options);
			case "exa":
				return this.searchExa(query, count, options);
			case "jina":
				return this.searchJina(query, count, options.signal);
			case "bing":
				return this.searchBing(query, count, options.signal);
			case "duckduckgo":
				return this.searchDuckDuckGo(query, count, options.signal);
			default:
				throw new Error(`Unsupported web search provider: ${provider}`);
		}
	}

	private async searchBrave(query: string, count: number, options: WebSearchOptions): Promise<ProviderHit[]> {
		const key = this.env.BRAVE_SEARCH_API_KEY;
		if (!key) throw new Error("Brave search requires BRAVE_SEARCH_API_KEY.");
		const endpoint = options.topic === "news" ? "news/search" : "web/search";
		const url = new URL(`https://api.search.brave.com/res/v1/${endpoint}`);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(count));
		url.searchParams.set("safesearch", "moderate");
		if (options.freshness) url.searchParams.set("freshness", braveFreshness(options.freshness));
		const response = await this.fetchWithTimeout(
			url,
			{ headers: { Accept: "application/json", "X-Subscription-Token": key } },
			SEARCH_TIMEOUT_MS,
			options.signal,
		);
		const data = await readJson(response, "Brave");
		const root = asRecord(data);
		const providerResults = options.topic === "news" ? root?.results : asRecord(root?.web)?.results;
		const rows = Array.isArray(providerResults) ? providerResults : [];
		return rows.slice(0, count).flatMap((row, index) => {
			const item = asRecord(row);
			const urlValue = asString(item?.url);
			if (!urlValue) return [];
			return [
				{
					title: asString(item?.title) || urlValue,
					url: urlValue,
					snippet: stripMarkup(asString(item?.description) || ""),
					publishedDate: asString(item?.page_age) || asString(item?.age),
					provider: "brave",
					query,
					rank: index + 1,
				},
			];
		});
	}

	private async searchTavily(query: string, count: number, options: WebSearchOptions): Promise<ProviderHit[]> {
		const key = this.env.TAVILY_API_KEY;
		if (!key) throw new Error("Tavily search requires TAVILY_API_KEY.");
		const response = await this.fetchWithTimeout(
			"https://api.tavily.com/search",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: key,
					query,
					max_results: count,
					search_depth: options.federated ? "advanced" : "fast",
					topic: options.topic ?? "general",
					time_range: options.freshness,
					include_domains: normalizeDomains(options.includeDomains),
					exclude_domains: normalizeDomains(options.excludeDomains),
					include_answer: false,
					include_raw_content: false,
				}),
			},
			SEARCH_TIMEOUT_MS,
			options.signal,
		);
		const data = asRecord(await readJson(response, "Tavily"));
		const rows = Array.isArray(data?.results) ? data.results : [];
		return rows.slice(0, count).flatMap((row, index) => {
			const item = asRecord(row);
			const urlValue = asString(item?.url);
			if (!urlValue) return [];
			return [
				{
					title: asString(item?.title) || urlValue,
					url: urlValue,
					snippet: asString(item?.content) || "",
					publishedDate: asString(item?.published_date),
					providerScore: asNumber(item?.score),
					provider: "tavily",
					query,
					rank: index + 1,
				},
			];
		});
	}

	private async searchExa(query: string, count: number, options: WebSearchOptions): Promise<ProviderHit[]> {
		const key = this.env.EXA_API_KEY;
		if (!key) throw new Error("Exa search requires EXA_API_KEY.");
		const response = await this.fetchWithTimeout(
			"https://api.exa.ai/search",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": key },
				body: JSON.stringify({
					query,
					numResults: count,
					type: options.federated ? "auto" : "fast",
					includeDomains: normalizeDomains(options.includeDomains),
					excludeDomains: normalizeDomains(options.excludeDomains),
					startPublishedDate: freshnessStartDate(options.freshness, this.now()),
					contents: { highlights: { maxCharacters: 900 } },
				}),
			},
			SEARCH_TIMEOUT_MS,
			options.signal,
		);
		const data = asRecord(await readJson(response, "Exa"));
		const rows = Array.isArray(data?.results) ? data.results : [];
		return rows.slice(0, count).flatMap((row, index) => {
			const item = asRecord(row);
			const urlValue = asString(item?.url);
			if (!urlValue) return [];
			const highlights = Array.isArray(item?.highlights)
				? item.highlights
						.map((value) => asString(value))
						.filter(Boolean)
						.join(" ")
				: "";
			return [
				{
					title: asString(item?.title) || urlValue,
					url: urlValue,
					snippet: highlights || asString(item?.summary) || asString(item?.text) || "",
					publishedDate: asString(item?.publishedDate),
					providerScore: firstNumber(item?.highlightScores),
					provider: "exa",
					query,
					rank: index + 1,
				},
			];
		});
	}

	private async searchJina(query: string, count: number, signal?: AbortSignal): Promise<ProviderHit[]> {
		const key = this.env.JINA_API_KEY;
		if (!key) throw new Error("Jina search requires JINA_API_KEY.");
		const response = await this.fetchWithTimeout(
			`https://s.jina.ai/${encodeURIComponent(query)}`,
			{
				headers: {
					Accept: "text/plain",
					Authorization: `Bearer ${key}`,
					"X-Retain-Images": "none",
				},
			},
			SEARCH_TIMEOUT_MS,
			signal,
		);
		const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
		return parseMarkdownSearch(text, "jina", query).slice(0, count);
	}

	private async searchDuckDuckGo(query: string, count: number, signal?: AbortSignal): Promise<ProviderHit[]> {
		const url = new URL("https://html.duckduckgo.com/html/");
		url.searchParams.set("q", query);
		const response = await this.fetchWithTimeout(
			url,
			{
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"User-Agent": "Mozilla/5.0 (compatible; AXIOM-WebResearch/1.0)",
				},
			},
			SEARCH_TIMEOUT_MS,
			signal,
		);
		const html = await readTextLimited(response, MAX_RESPONSE_BYTES);
		const hits = parseDuckDuckGo(html, query).slice(0, count);
		if (hits.length === 0 && /challenge-form|Unfortunately, bots use DuckDuckGo/i.test(html)) {
			throw new Error("DuckDuckGo returned an anti-bot challenge.");
		}
		return hits;
	}

	private async searchBing(query: string, count: number, signal?: AbortSignal): Promise<ProviderHit[]> {
		const url = new URL("https://www.bing.com/search");
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(count));
		const response = await this.fetchWithTimeout(
			url,
			{
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en-US,en;q=0.8",
					"User-Agent": "Mozilla/5.0 (compatible; AXIOM-WebResearch/1.0)",
				},
			},
			SEARCH_TIMEOUT_MS,
			signal,
		);
		const html = await readTextLimited(response, MAX_RESPONSE_BYTES);
		return parseBing(html, query).slice(0, count);
	}

	private async fetchPage(
		rawUrl: string,
		id: string,
		maxChars: number,
		signal?: AbortSignal,
	): Promise<WebFetchedPage> {
		const canonicalUrl = canonicalizeUrl(rawUrl);
		const cached = this.readCache(this.pageCache, canonicalUrl);
		if (cached) return { ...cached, id };
		await this.validatePublicUrl(canonicalUrl);

		let currentUrl = canonicalUrl;
		for (let redirects = 0; redirects <= 5; redirects++) {
			const response = await this.fetchWithTimeout(
				currentUrl,
				{
					redirect: "manual",
					headers: {
						Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/pdf",
						"User-Agent": "Mozilla/5.0 (compatible; AXIOM-WebResearch/1.0)",
					},
				},
				PAGE_TIMEOUT_MS,
				signal,
			);
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) throw new Error(`Redirect from ${currentUrl} had no Location header.`);
				currentUrl = new URL(location, currentUrl).toString();
				await this.validatePublicUrl(currentUrl);
				continue;
			}
			if (!response.ok) throw new Error(`Fetch ${currentUrl} failed with HTTP ${response.status}.`);
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (contentType.includes("application/pdf")) {
				const page = await this.fetchWithJinaReader(currentUrl, id, maxChars, signal, contentType);
				this.writeCache(this.pageCache, canonicalUrl, page, this.pageCacheTtlMs);
				return page;
			}
			const raw = await readTextLimited(response, MAX_RESPONSE_BYTES);
			const extracted = extractReadableContent(raw, contentType, currentUrl);
			if (extracted.content.length < 240 && contentType.includes("html")) {
				try {
					const page = await this.fetchWithJinaReader(currentUrl, id, maxChars, signal, contentType);
					this.writeCache(this.pageCache, canonicalUrl, page, this.pageCacheTtlMs);
					return page;
				} catch {
					// Keep the native extraction if the optional reader fallback fails.
				}
			}
			const content = extracted.content.slice(0, maxChars);
			const page: WebFetchedPage = {
				id,
				title: extracted.title,
				url: currentUrl,
				canonicalUrl,
				domain: new URL(currentUrl).hostname,
				content,
				contentType,
				fetchedAt: new Date(this.now()).toISOString(),
				truncated: content.length < extracted.content.length,
				extractor: "native",
			};
			this.writeCache(this.pageCache, canonicalUrl, page, this.pageCacheTtlMs);
			return page;
		}
		throw new Error(`Too many redirects while fetching ${rawUrl}.`);
	}

	private async fetchWithJinaReader(
		url: string,
		id: string,
		maxChars: number,
		signal: AbortSignal | undefined,
		contentType: string,
	): Promise<WebFetchedPage> {
		const headers: Record<string, string> = {
			Accept: "text/plain",
			"X-Retain-Images": "none",
			"X-With-Generated-Alt": "false",
		};
		if (this.env.JINA_API_KEY) headers.Authorization = `Bearer ${this.env.JINA_API_KEY}`;
		const response = await this.fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, PAGE_TIMEOUT_MS, signal);
		const raw = await readTextLimited(response, MAX_RESPONSE_BYTES);
		const title = /^Title:\s*(.+)$/m.exec(raw)?.[1]?.trim() || new URL(url).hostname;
		const content = raw.slice(0, maxChars);
		return {
			id,
			title,
			url,
			canonicalUrl: canonicalizeUrl(url),
			domain: new URL(url).hostname,
			content,
			contentType,
			fetchedAt: new Date(this.now()).toISOString(),
			truncated: content.length < raw.length,
			extractor: "jina-reader",
		};
	}

	async validatePublicUrl(rawUrl: string): Promise<void> {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Only http(s) URLs are allowed: ${rawUrl}`);
		}
		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
		if (
			hostname === "localhost" ||
			hostname.endsWith(".localhost") ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal")
		) {
			throw new Error(`Blocked private hostname: ${hostname}`);
		}
		const addresses = isIP(hostname) ? [hostname] : await this.lookupHost(hostname);
		if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
			throw new Error(`Blocked non-public address for ${hostname}.`);
		}
	}

	private async fetchWithTimeout(
		input: string | URL,
		init: RequestInit,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Response> {
		const timeoutController = new AbortController();
		const timer = setTimeout(
			() => timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms.`)),
			timeoutMs,
		);
		const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
		try {
			return await this.fetchImpl(input, { ...init, signal: combined });
		} finally {
			clearTimeout(timer);
		}
	}

	private readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
		const entry = cache.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			cache.delete(key);
			return undefined;
		}
		return entry.value;
	}

	private writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
		cache.set(key, { expiresAt: this.now() + ttlMs, value });
	}
}

export function formatWebSearchEvidence(response: WebSearchResponse): string {
	const lines = [
		"# Web search results",
		`Queries: ${response.queries.join(" | ")}`,
		`Providers: ${response.providers.join(", ") || "none"}`,
	];
	for (const result of response.results) {
		lines.push("");
		lines.push(`## [${result.id}] ${result.title}`);
		lines.push(`URL: ${result.url}`);
		if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
		lines.push(
			`Rank: ${result.score.toFixed(3)} | Type: ${result.sourceType} | Providers: ${result.providers.join(", ")}`,
		);
		if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
	}
	appendWarnings(lines, response.warnings);
	lines.push(
		"",
		"Cite claims with [S#] and include the corresponding URL. Search snippets are leads, not full-page evidence.",
	);
	return lines.join("\n");
}

export function formatWebFetchEvidence(response: WebFetchResponse): string {
	const lines = ["# Fetched web evidence"];
	for (const page of response.pages) {
		lines.push("");
		lines.push(`## [${page.id}] ${page.title}`);
		lines.push(`URL: ${page.url}`);
		lines.push(`Extractor: ${page.extractor}${page.truncated ? " (truncated)" : ""}`);
		lines.push("", page.content);
	}
	appendWarnings(lines, response.warnings);
	lines.push("", "Cite claims with [S#] and include the corresponding URL.");
	return lines.join("\n");
}

export function formatWebResearchEvidence(response: WebResearchResponse): string {
	const pageByUrl = new Map(response.pages.map((page) => [page.canonicalUrl, page]));
	const lines = [
		"# Web research evidence pack",
		`Queries: ${response.queries.join(" | ")}`,
		`Providers: ${response.providers.join(", ") || "none"}`,
	];
	for (const result of response.results) {
		const page = pageByUrl.get(result.canonicalUrl);
		lines.push("");
		lines.push(`## [${result.id}] ${result.title}`);
		lines.push(`URL: ${result.url}`);
		if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
		lines.push(`Evidence: ${page ? `full content via ${page.extractor}` : "search snippet only"}`);
		if (page) {
			lines.push("", page.content);
		} else if (result.snippet) {
			lines.push(`Snippet: ${result.snippet}`);
		}
	}
	appendWarnings(lines, response.warnings);
	lines.push(
		"",
		"Use full-content entries for detailed claims. Treat snippet-only entries as discovery leads. Cite every externally verifiable claim with [S#] and include source URLs.",
	);
	return lines.join("\n");
}

export function extractReadableContent(
	raw: string,
	contentType: string,
	url: string,
): { title: string; content: string } {
	if (contentType.includes("json")) {
		try {
			const formatted = JSON.stringify(JSON.parse(raw), null, 2);
			return { title: new URL(url).hostname, content: formatted };
		} catch {
			return { title: new URL(url).hostname, content: raw.trim() };
		}
	}
	if (!contentType.includes("html") && !/<(?:html|body|main|article)\b/i.test(raw)) {
		return { title: new URL(url).hostname, content: raw.replace(/\r\n/g, "\n").trim() };
	}

	const title = decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "").trim();
	let html = raw
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|svg|canvas|template|noscript|form|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|main|header|h[1-6]|li|tr|pre|blockquote)>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, " ");
	html = decodeHtmlEntities(html)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title: title || new URL(url).hostname, content: html };
}

function rankAndDedupe(hits: ProviderHit[], queries: string[], count: number): WebSearchHit[] {
	const merged = new Map<
		string,
		{
			title: string;
			url: string;
			canonicalUrl: string;
			snippet: string;
			publishedDate?: string;
			score: number;
			providers: Set<string>;
			queries: Set<string>;
		}
	>();
	for (const hit of hits) {
		let canonicalUrl: string;
		try {
			canonicalUrl = canonicalizeUrl(hit.url);
		} catch {
			continue;
		}
		const existing = merged.get(canonicalUrl);
		const lexical = queryCoverage(`${hit.title} ${hit.snippet}`, hit.query);
		const contribution = 1 / (60 + Math.max(1, hit.rank)) + lexical * 0.03 + (hit.providerScore ?? 0) * 0.02;
		if (existing) {
			existing.score += contribution;
			existing.providers.add(hit.provider);
			existing.queries.add(hit.query);
			if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
			if (!existing.publishedDate && hit.publishedDate) existing.publishedDate = hit.publishedDate;
		} else {
			merged.set(canonicalUrl, {
				title: hit.title,
				url: hit.url,
				canonicalUrl,
				snippet: hit.snippet,
				publishedDate: hit.publishedDate,
				score: contribution,
				providers: new Set([hit.provider]),
				queries: new Set([hit.query]),
			});
		}
	}

	const ordered = [...merged.values()].sort((a, b) => b.score - a.score);
	const maxScore = ordered[0]?.score || 1;
	const candidates = ordered.map((item) => ({
		id: "",
		title: item.title,
		url: item.url,
		canonicalUrl: item.canonicalUrl,
		domain: new URL(item.canonicalUrl).hostname,
		snippet: compactText(item.snippet, 1_200),
		publishedDate: item.publishedDate,
		score: item.score / maxScore,
		providers: [...item.providers],
		matchedQueries: [...item.queries].filter((query) => queries.includes(query)),
		sourceType: classifySource(item.canonicalUrl),
	}));
	return selectDomainDiverse(candidates, count).map((item, index) => ({ ...item, id: `S${index + 1}` }));
}

function selectDomainDiverse<T extends { domain: string }>(items: T[], count: number): T[] {
	const selected: T[] = [];
	const deferred: T[] = [];
	const domainCounts = new Map<string, number>();
	for (const item of items) {
		const seen = domainCounts.get(item.domain) ?? 0;
		if (seen < 2 && selected.length < count) {
			selected.push(item);
			domainCounts.set(item.domain, seen + 1);
		} else {
			deferred.push(item);
		}
	}
	for (const item of deferred) {
		if (selected.length >= count) break;
		selected.push(item);
	}
	return selected;
}

function parseDuckDuckGo(html: string, query: string): ProviderHit[] {
	const hits: ProviderHit[] = [];
	const resultPattern =
		/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>)/gi;
	let match = resultPattern.exec(html);
	while (match !== null) {
		const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(match[1] ?? ""));
		if (url.startsWith("http://") || url.startsWith("https://")) {
			hits.push({
				title: stripMarkup(match[2] ?? "") || url,
				url,
				snippet: stripMarkup(match[3] ?? ""),
				provider: "duckduckgo",
				query,
				rank: hits.length + 1,
			});
		}
		match = resultPattern.exec(html);
	}
	return hits;
}

function parseBing(html: string, query: string): ProviderHit[] {
	const hits: ProviderHit[] = [];
	const blockPattern = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
	let blockMatch = blockPattern.exec(html);
	while (blockMatch !== null) {
		const block = blockMatch[1] ?? "";
		const titleMatch = /<h2\b[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block);
		if (titleMatch) {
			const url = unwrapBingUrl(decodeHtmlEntities(titleMatch[1] ?? ""));
			if (url.startsWith("http://") || url.startsWith("https://")) {
				const snippetMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
				hits.push({
					title: stripMarkup(titleMatch[2] ?? "") || url,
					url,
					snippet: stripMarkup(snippetMatch?.[1] ?? ""),
					provider: "bing",
					query,
					rank: hits.length + 1,
				});
			}
		}
		blockMatch = blockPattern.exec(html);
	}
	return hits;
}

function parseMarkdownSearch(text: string, provider: string, query: string): ProviderHit[] {
	const hits: ProviderHit[] = [];
	const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)(?:\s*\n+([\s\S]*?))?(?=\n+\[[^\]\n]+\]\(https?:\/\/|$)/g;
	let match = pattern.exec(text);
	while (match !== null) {
		hits.push({
			title: match[1]?.trim() || match[2]!,
			url: match[2]!,
			snippet: compactText(match[3] ?? "", 1_000),
			provider,
			query,
			rank: hits.length + 1,
		});
		match = pattern.exec(text);
	}
	return hits;
}

function canonicalizeUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.hash = "";
	url.hostname = url.hostname.toLowerCase();
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
			url.searchParams.delete(key);
		}
	}
	url.searchParams.sort();
	if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString();
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl, "https://duckduckgo.com");
		return url.searchParams.get("uddg") || url.toString();
	} catch {
		return rawUrl;
	}
}

function unwrapBingUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl, "https://www.bing.com");
		const encoded = url.searchParams.get("u");
		if (!encoded?.startsWith("a1")) return url.toString();
		const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : url.toString();
	} catch {
		return rawUrl;
	}
}

function classifySource(rawUrl: string): WebSearchHit["sourceType"] {
	const url = new URL(rawUrl);
	const host = url.hostname.toLowerCase();
	const path = url.pathname.toLowerCase();
	if (host.endsWith(".gov") || host.endsWith(".edu") || host.includes("developer.") || host.startsWith("docs.")) {
		return "official";
	}
	if (path.includes("/docs") || path.includes("/documentation") || host.includes("readthedocs"))
		return "documentation";
	if (host.includes("arxiv.org") || host.includes("doi.org") || host.includes("semanticscholar.org"))
		return "research";
	if (host.includes("news") || path.includes("/news/")) return "news";
	if (host.includes("reddit.com") || host.includes("stackoverflow.com") || host.includes("forum")) return "community";
	return "web";
}

function isPrivateAddress(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0]!;
	if (normalized.includes(":")) {
		return (
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb") ||
			normalized.startsWith("ff") ||
			normalized.startsWith("2001:db8:")
		);
	}
	const parts = normalized.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		a! >= 224
	);
}

function normalizeQueries(queries: string[]): string[] {
	const normalized = uniqueStrings(queries.map((query) => query.trim()).filter(Boolean)).slice(0, MAX_SEARCH_QUERIES);
	if (normalized.length === 0) throw new Error("web_research requires at least one non-empty query.");
	return normalized;
}

function normalizeDomains(domains: string[] | undefined): string[] {
	return uniqueStrings(
		(domains ?? [])
			.map((domain) =>
				domain
					.trim()
					.toLowerCase()
					.replace(/^https?:\/\//, "")
					.replace(/\/.*$/, ""),
			)
			.filter(Boolean),
	).slice(0, 20);
}

function queryCoverage(text: string, query: string): number {
	const terms = tokenize(query);
	if (terms.length === 0) return 0;
	const haystack = new Set(tokenize(text));
	return terms.filter((term) => haystack.has(term)).length / terms.length;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter((term) => term.length > 2);
}

function stripMarkup(text: string): string {
	return compactText(decodeHtmlEntities(text.replace(/<[^>]+>/g, " ")), 1_500);
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity: string) => {
		if (entity.startsWith("#")) {
			const hex = entity[1]?.toLowerCase() === "x";
			const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(value) ? String.fromCodePoint(value) : full;
		}
		return named[entity.toLowerCase()] ?? full;
	});
}

async function readJson(response: Response, provider: string): Promise<unknown> {
	if (!response.ok) {
		const body = compactText(await response.text(), 500);
		throw new Error(`${provider} search failed with HTTP ${response.status}${body ? `: ${body}` : ""}.`);
	}
	return response.json();
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
	if (!response.ok) {
		throw new Error(`Request failed with HTTP ${response.status}.`);
	}
	const reader = response.body?.getReader();
	if (!reader) return (await response.text()).slice(0, maxBytes);
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			break;
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

function freshnessStartDate(freshness: WebSearchFreshness | undefined, now: number): string | undefined {
	if (!freshness) return undefined;
	const days = { day: 1, week: 7, month: 31, year: 366 }[freshness];
	return new Date(now - days * 86_400_000).toISOString();
}

function braveFreshness(freshness: WebSearchFreshness): string {
	return { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
}

function firstNumber(value: unknown): number | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		const number = asNumber(item);
		if (number !== undefined) return number;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function normalizeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendWarnings(lines: string[], warnings: string[]): void {
	if (warnings.length === 0) return;
	lines.push("", "# Warnings");
	for (const warning of warnings) lines.push(`- ${warning}`);
}
