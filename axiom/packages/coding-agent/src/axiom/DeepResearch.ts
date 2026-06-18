import type { BrowserPageExtractor } from "./PlaywrightPageExtractor.ts";
import type {
	WebFetchedPage,
	WebResearchOptions,
	WebResearchResponse,
	WebSearchFreshness,
	WebSearchHit,
	WebSearchProvider,
	WebSearchTopic,
} from "./WebResearch.ts";

export type DeepResearchBrowserMode = "auto" | "off" | "force";

export interface DeepResearchOptions {
	query: string;
	queries?: string[];
	provider?: WebSearchProvider;
	topic?: WebSearchTopic;
	freshness?: WebSearchFreshness;
	includeDomains?: string[];
	excludeDomains?: string[];
	maxRounds?: number;
	maxSources?: number;
	fetchPerRound?: number;
	maxCharsPerPage?: number;
	maxTotalChars?: number;
	minFullSources?: number;
	coverageThreshold?: number;
	browser?: DeepResearchBrowserMode;
	browserFetchesPerRound?: number;
	signal?: AbortSignal;
}

export interface DeepResearchRound {
	round: number;
	queries: string[];
	newSources: number;
	fullSources: number;
	domains: number;
	coverage: number;
	gaps: string[];
}

export interface DeepResearchSource extends WebSearchHit {
	page?: WebFetchedPage;
	evidenceScore: number;
}

export interface DeepResearchClaim {
	id: string;
	sourceId: string;
	text: string;
	status: "supported" | "weak" | "conflicted";
	supportingSourceIds: string[];
}

export interface DeepResearchConflict {
	claimA: string;
	claimB: string;
	sourceA: string;
	sourceB: string;
	reason: string;
}

export interface DeepResearchCoverage {
	score: number;
	queryTermCoverage: number;
	fullSourceScore: number;
	domainDiversityScore: number;
	primarySourceScore: number;
	coveredTerms: string[];
	missingTerms: string[];
}

export interface DeepResearchResponse {
	query: string;
	rounds: DeepResearchRound[];
	sources: DeepResearchSource[];
	claims: DeepResearchClaim[];
	conflicts: DeepResearchConflict[];
	coverage: DeepResearchCoverage;
	stopReason: "coverage_reached" | "round_budget" | "no_new_queries" | "aborted";
	warnings: string[];
}

export interface DeepResearchBackend {
	research(options: WebResearchOptions): Promise<WebResearchResponse>;
	validatePublicUrl?(url: string): Promise<void>;
}

export interface DeepResearchEngineOptions {
	backend: DeepResearchBackend;
	browserExtractor?: BrowserPageExtractor;
}

interface MutableSource {
	hit: WebSearchHit;
	page?: WebFetchedPage;
}

interface RawClaim {
	sourceKey: string;
	text: string;
	tokens: Set<string>;
	values: string[];
}

const DEFAULT_ROUNDS = 3;
const DEFAULT_SOURCES = 12;
const DEFAULT_FETCH_PER_ROUND = 4;
const DEFAULT_TOTAL_CHARS = 64_000;
const DEFAULT_PAGE_CHARS = 10_000;
const DEFAULT_MIN_FULL_SOURCES = 4;
const DEFAULT_COVERAGE_THRESHOLD = 0.72;
const MIN_RENDERED_CONTENT = 240;
const STOP_WORDS = new Set([
	"a",
	"about",
	"after",
	"all",
	"also",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"because",
	"before",
	"best",
	"but",
	"by",
	"can",
	"do",
	"does",
	"for",
	"from",
	"how",
	"i",
	"in",
	"into",
	"is",
	"it",
	"its",
	"latest",
	"more",
	"most",
	"of",
	"on",
	"or",
	"should",
	"than",
	"that",
	"the",
	"their",
	"this",
	"to",
	"use",
	"using",
	"was",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
]);

/**
 * Bounded, provider-agnostic deep research. Search remains cheap and broad;
 * full-page token spend is reserved for high-value, diverse sources.
 */
export class DeepResearchEngine {
	private readonly backend: DeepResearchBackend;
	private readonly browserExtractor?: BrowserPageExtractor;

	constructor(options: DeepResearchEngineOptions) {
		this.backend = options.backend;
		this.browserExtractor = options.browserExtractor;
	}

	async research(options: DeepResearchOptions): Promise<DeepResearchResponse> {
		const query = options.query.trim();
		if (!query) throw new Error("Deep research requires a non-empty query.");
		const maxRounds = clampInteger(options.maxRounds, 1, 5, DEFAULT_ROUNDS);
		const maxSources = clampInteger(options.maxSources, 3, 30, DEFAULT_SOURCES);
		const fetchPerRound = clampInteger(options.fetchPerRound, 1, 8, DEFAULT_FETCH_PER_ROUND);
		const maxCharsPerPage = clampInteger(options.maxCharsPerPage, 1_000, 50_000, DEFAULT_PAGE_CHARS);
		const maxTotalChars = clampInteger(options.maxTotalChars, 4_000, 180_000, DEFAULT_TOTAL_CHARS);
		const minFullSources = clampInteger(options.minFullSources, 1, maxSources, DEFAULT_MIN_FULL_SOURCES);
		const coverageThreshold = clampNumber(options.coverageThreshold, 0.35, 0.98, DEFAULT_COVERAGE_THRESHOLD);
		const browserMode = options.browser ?? "auto";
		const browserFetchesPerRound = clampInteger(options.browserFetchesPerRound, 1, 4, 2);
		const sourceMap = new Map<string, MutableSource>();
		const rounds: DeepResearchRound[] = [];
		const warnings: string[] = [];
		const searchedQueries = new Set<string>();
		let nextQueries = initialQueries(query, options.queries);
		let coverage = emptyCoverage(query);
		let stopReason: DeepResearchResponse["stopReason"] = "round_budget";

		for (let round = 1; round <= maxRounds; round++) {
			if (options.signal?.aborted) {
				stopReason = "aborted";
				break;
			}
			const roundQueries = nextQueries
				.filter((candidate) => !searchedQueries.has(normalizeText(candidate)))
				.slice(0, 4);
			if (roundQueries.length === 0) {
				stopReason = "no_new_queries";
				break;
			}
			for (const candidate of roundQueries) searchedQueries.add(normalizeText(candidate));

			const response = await this.backend.research({
				queries: roundQueries,
				provider: options.provider,
				count: maxSources,
				topic: options.topic,
				freshness: options.freshness,
				includeDomains: options.includeDomains,
				excludeDomains: options.excludeDomains,
				fetchTop: fetchPerRound,
				maxCharsPerPage,
				maxTotalChars: Math.max(maxCharsPerPage, Math.ceil(maxTotalChars / maxRounds)),
				signal: options.signal,
				federated: true,
			});
			warnings.push(...response.warnings);
			const before = sourceMap.size;
			mergeResearchResponse(sourceMap, response);
			await this.applyBrowserFallback(
				sourceMap,
				response.results,
				browserMode,
				browserFetchesPerRound,
				fetchPerRound,
				maxCharsPerPage,
				options.signal,
				warnings,
			);

			const ranked = rankSources([...sourceMap.values()], query).slice(0, maxSources);
			coverage = calculateCoverage(query, ranked, minFullSources);
			const gaps = deriveGaps(coverage, ranked, minFullSources);
			rounds.push({
				round,
				queries: roundQueries,
				newSources: sourceMap.size - before,
				fullSources: ranked.filter((source) => source.page && source.page.content.length >= MIN_RENDERED_CONTENT)
					.length,
				domains: new Set(ranked.map((source) => source.hit.domain)).size,
				coverage: coverage.score,
				gaps,
			});

			if (
				coverage.score >= coverageThreshold &&
				ranked.filter((source) => source.page && source.page.content.length >= MIN_RENDERED_CONTENT).length >=
					minFullSources
			) {
				stopReason = "coverage_reached";
				break;
			}
			nextQueries = followUpQueries(query, coverage, round);
		}

		const ranked = rankSources([...sourceMap.values()], query).slice(0, maxSources);
		const sources = applyEvidenceBudget(ranked, maxTotalChars, query);
		const rawClaims = extractClaims(sources, query);
		const conflicts = findConflicts(rawClaims, sources);
		const claims = finalizeClaims(rawClaims, conflicts, sources);
		coverage = calculateCoverage(
			query,
			sources.map((source) => ({ hit: source, page: source.page })),
			minFullSources,
		);

		return {
			query,
			rounds,
			sources,
			claims,
			conflicts,
			coverage,
			stopReason,
			warnings: uniqueStrings(warnings),
		};
	}

	private async applyBrowserFallback(
		sourceMap: Map<string, MutableSource>,
		roundHits: readonly WebSearchHit[],
		mode: DeepResearchBrowserMode,
		limit: number,
		selectedCount: number,
		maxChars: number,
		signal: AbortSignal | undefined,
		warnings: string[],
	): Promise<void> {
		if (mode === "off") return;
		if (!this.browserExtractor?.available()) {
			if (mode === "force") warnings.push("Playwright browser extraction was requested but is unavailable.");
			return;
		}
		const candidates = roundHits
			.slice(0, selectedCount)
			.map((hit) => sourceMap.get(hit.canonicalUrl))
			.filter((source): source is MutableSource => source !== undefined)
			.filter((source) => mode === "force" || !source.page || source.page.content.length < MIN_RENDERED_CONTENT)
			.slice(0, limit);
		for (const source of candidates) {
			try {
				await this.backend.validatePublicUrl?.(source.hit.url);
				const rendered = await this.browserExtractor.extract(source.hit.url, maxChars, signal);
				await this.backend.validatePublicUrl?.(rendered.url);
				if (rendered.content.length < MIN_RENDERED_CONTENT && source.page) continue;
				source.page = {
					id: source.hit.id,
					title: rendered.title || source.hit.title,
					url: rendered.url,
					canonicalUrl: source.hit.canonicalUrl,
					domain: new URL(rendered.url).hostname,
					content: rendered.content,
					contentType: rendered.contentType,
					fetchedAt: new Date().toISOString(),
					truncated: rendered.content.length >= maxChars,
					extractor: "playwright",
				};
			} catch (error) {
				warnings.push(`Playwright fallback failed for ${source.hit.url}: ${normalizeError(error)}`);
			}
		}
	}
}

export function formatDeepResearchEvidence(response: DeepResearchResponse): string {
	const lines = [
		"# Deep research evidence dossier",
		`Question: ${response.query}`,
		`Stop: ${response.stopReason}`,
		`Coverage: ${(response.coverage.score * 100).toFixed(0)}% (terms ${(response.coverage.queryTermCoverage * 100).toFixed(0)}%, full evidence ${(response.coverage.fullSourceScore * 100).toFixed(0)}%, domains ${(response.coverage.domainDiversityScore * 100).toFixed(0)}%, primary ${(response.coverage.primarySourceScore * 100).toFixed(0)}%)`,
		"",
		"## Research rounds",
	];
	for (const round of response.rounds) {
		lines.push(
			`- Round ${round.round}: ${round.queries.join(" | ")}; +${round.newSources} sources; ${round.fullSources} full; ${round.domains} domains; ${(round.coverage * 100).toFixed(0)}% coverage`,
		);
		if (round.gaps.length > 0) lines.push(`  Gaps: ${round.gaps.join("; ")}`);
	}

	if (response.coverage.missingTerms.length > 0) {
		lines.push(
			"",
			"## Remaining evidence gaps",
			`- Missing query concepts: ${response.coverage.missingTerms.join(", ")}`,
		);
	}
	if (response.conflicts.length > 0) {
		lines.push("", "## Potential conflicts requiring judgment");
		for (const conflict of response.conflicts) {
			lines.push(
				`- [${conflict.sourceA}] "${conflict.claimA}" conflicts with [${conflict.sourceB}] "${conflict.claimB}" (${conflict.reason})`,
			);
		}
	}
	if (response.claims.length > 0) {
		lines.push("", "## Claim audit");
		for (const claim of response.claims) {
			const support =
				claim.supportingSourceIds.length > 0 ? `; corroborated by ${claim.supportingSourceIds.join(", ")}` : "";
			lines.push(`- [${claim.sourceId}] ${claim.status.toUpperCase()}: ${claim.text}${support}`);
		}
	}

	lines.push("", "## Ranked source evidence");
	for (const source of response.sources) {
		lines.push("", `### [${source.id}] ${source.title}`);
		lines.push(`URL: ${source.url}`);
		if (source.publishedDate) lines.push(`Published: ${source.publishedDate}`);
		lines.push(
			`Evidence score: ${source.evidenceScore.toFixed(3)} | Type: ${source.sourceType} | Providers: ${source.providers.join(", ") || "unknown"} | ${source.page ? `full content via ${source.page.extractor}` : "snippet only"}`,
		);
		if (source.page) lines.push("", source.page.content);
		else if (source.snippet) lines.push(`Snippet: ${source.snippet}`);
	}
	if (response.warnings.length > 0) {
		lines.push("", "## Warnings", ...response.warnings.map((warning) => `- ${warning}`));
	}
	lines.push(
		"",
		"Build the answer from full-content sources, not snippets. Cite externally verifiable claims with [S#] and the source URL. Explicitly disclose unresolved conflicts and evidence gaps.",
	);
	return lines.join("\n");
}

function mergeResearchResponse(sourceMap: Map<string, MutableSource>, response: WebResearchResponse): void {
	const pageByUrl = new Map(response.pages.map((page) => [page.canonicalUrl, page]));
	for (const hit of response.results) {
		const existing = sourceMap.get(hit.canonicalUrl);
		const page = pageByUrl.get(hit.canonicalUrl);
		if (!existing) {
			sourceMap.set(hit.canonicalUrl, { hit: { ...hit }, page });
			continue;
		}
		existing.hit = {
			...existing.hit,
			title: existing.hit.title.length >= hit.title.length ? existing.hit.title : hit.title,
			snippet: existing.hit.snippet.length >= hit.snippet.length ? existing.hit.snippet : hit.snippet,
			score: Math.max(existing.hit.score, hit.score),
			providers: uniqueStrings([...existing.hit.providers, ...hit.providers]),
			matchedQueries: uniqueStrings([...existing.hit.matchedQueries, ...hit.matchedQueries]),
		};
		if (page && (!existing.page || page.content.length > existing.page.content.length)) existing.page = page;
	}
}

function rankSources(sources: readonly MutableSource[], query: string): MutableSource[] {
	const queryTokens = new Set(tokenize(query));
	return sources
		.map((source) => ({
			source,
			score: scoreSource(source, queryTokens),
		}))
		.sort((a, b) => b.score - a.score || a.source.hit.canonicalUrl.localeCompare(b.source.hit.canonicalUrl))
		.map(({ source }) => source);
}

function scoreSource(source: MutableSource, queryTokens: Set<string>): number {
	const typeWeight: Record<WebSearchHit["sourceType"], number> = {
		official: 0.27,
		documentation: 0.25,
		research: 0.25,
		news: 0.17,
		web: 0.12,
		community: 0.06,
	};
	const haystack = `${source.hit.title} ${source.hit.snippet} ${source.page?.content ?? ""}`.toLowerCase();
	const matched = [...queryTokens].filter((token) => haystack.includes(token)).length;
	const lexical = queryTokens.size === 0 ? 0 : matched / queryTokens.size;
	const full = source.page && source.page.content.length >= MIN_RENDERED_CONTENT ? 0.24 : 0;
	const length = source.page ? Math.min(0.08, source.page.content.length / 100_000) : 0;
	const provider = Math.min(0.05, Math.max(0, source.hit.providers.length - 1) * 0.025);
	const search = Math.min(0.11, Math.max(0, source.hit.score) * 0.055);
	const firstParty = isPrimarySource(source, queryTokens) && source.hit.sourceType === "web" ? 0.12 : 0;
	return clampNumber(
		typeWeight[source.hit.sourceType] + firstParty + full + length + provider + search + lexical * 0.25,
		0,
		1,
		0,
	);
}

function calculateCoverage(
	query: string,
	sources: readonly MutableSource[],
	minFullSources: number,
): DeepResearchCoverage {
	const terms = tokenize(query);
	const fullSources = sources.filter((source) => source.page && source.page.content.length >= MIN_RENDERED_CONTENT);
	const fullText = fullSources
		.map((source) => `${source.hit.title} ${source.page?.content ?? ""}`.toLowerCase())
		.join("\n");
	const coveredTerms = terms.filter((term) => fullText.includes(term));
	const missingTerms = terms.filter((term) => !fullText.includes(term));
	const queryTermCoverage = terms.length === 0 ? 1 : coveredTerms.length / terms.length;
	const fullSourceScore = Math.min(1, fullSources.length / Math.max(1, minFullSources));
	const domainDiversityScore = Math.min(1, new Set(fullSources.map((source) => source.hit.domain)).size / 3);
	const queryTokens = new Set(terms);
	const primarySourceScore = fullSources.some((source) => isPrimarySource(source, queryTokens)) ? 1 : 0;
	const score =
		queryTermCoverage * 0.45 + fullSourceScore * 0.25 + domainDiversityScore * 0.15 + primarySourceScore * 0.15;
	return {
		score,
		queryTermCoverage,
		fullSourceScore,
		domainDiversityScore,
		primarySourceScore,
		coveredTerms,
		missingTerms,
	};
}

function emptyCoverage(query: string): DeepResearchCoverage {
	return {
		score: 0,
		queryTermCoverage: 0,
		fullSourceScore: 0,
		domainDiversityScore: 0,
		primarySourceScore: 0,
		coveredTerms: [],
		missingTerms: tokenize(query),
	};
}

function deriveGaps(
	coverage: DeepResearchCoverage,
	sources: readonly MutableSource[],
	minFullSources: number,
): string[] {
	const gaps: string[] = [];
	const fullSources = sources.filter((source) => source.page && source.page.content.length >= MIN_RENDERED_CONTENT);
	if (coverage.missingTerms.length > 0)
		gaps.push(`uncovered concepts: ${coverage.missingTerms.slice(0, 6).join(", ")}`);
	if (fullSources.length < minFullSources) gaps.push(`only ${fullSources.length}/${minFullSources} full sources`);
	const domains = new Set(fullSources.map((source) => source.hit.domain)).size;
	if (domains < 3) gaps.push(`only ${domains}/3 independent domains`);
	if (coverage.primarySourceScore === 0) gaps.push("no full primary or official source");
	return gaps;
}

function initialQueries(query: string, supplied: readonly string[] | undefined): string[] {
	return uniqueStrings([
		query,
		...(supplied ?? []),
		`${query} official documentation primary source`,
		`${query} research evidence`,
		`${query} limitations criticism`,
	]).slice(0, 4);
}

function followUpQueries(query: string, coverage: DeepResearchCoverage, round: number): string[] {
	const missing = coverage.missingTerms.slice(0, 5).join(" ");
	return uniqueStrings([
		missing ? `${query} ${missing}` : "",
		coverage.primarySourceScore === 0 ? `${query} official report documentation paper` : "",
		`${query} independent verification evidence`,
		`${query} counterevidence failure limitations`,
		`${query} methodology benchmark data`,
		round > 1 ? `${query} recent update correction` : "",
	]).filter(Boolean);
}

function isPrimarySource(source: MutableSource, queryTokens: ReadonlySet<string>): boolean {
	if (["official", "documentation", "research"].includes(source.hit.sourceType)) return true;
	const url = new URL(source.hit.canonicalUrl);
	const domainLabels = url.hostname
		.toLowerCase()
		.split(".")
		.filter((label) => label.length >= 4 && !["www", "docs", "developer"].includes(label));
	if (domainLabels.some((label) => queryTokens.has(label))) return true;
	if (url.hostname === "github.com") {
		const pathLabels = url.pathname
			.toLowerCase()
			.split("/")
			.filter((label) => label.length >= 4);
		return pathLabels.some((label) => queryTokens.has(label));
	}
	return false;
}

function applyEvidenceBudget(
	sources: readonly MutableSource[],
	maxTotalChars: number,
	query: string,
): DeepResearchSource[] {
	let remaining = maxTotalChars;
	return sources.map((source, index) => {
		const evidenceScore = scoreSource(source, new Set(tokenize(query)));
		let page = source.page;
		if (page && remaining >= MIN_RENDERED_CONTENT) {
			const content = page.content.slice(0, remaining);
			page = {
				...page,
				id: `S${index + 1}`,
				content,
				truncated: page.truncated || content.length < page.content.length,
			};
			remaining -= content.length;
		} else {
			page = undefined;
		}
		return {
			...source.hit,
			id: `S${index + 1}`,
			page,
			evidenceScore,
		};
	});
}

function extractClaims(sources: readonly DeepResearchSource[], query: string): RawClaim[] {
	const queryTokens = new Set(tokenize(query));
	const claims: RawClaim[] = [];
	for (const source of sources) {
		const text = source.page?.content ?? source.snippet;
		const candidates = text
			.split(/(?<=[.!?])\s+|\n+/)
			.map((sentence) => sentence.trim().replace(/\s+/g, " "))
			.filter((sentence) => sentence.length >= 55 && sentence.length <= 420)
			.map((sentence) => {
				const tokens = new Set(tokenize(sentence));
				const overlap = [...queryTokens].filter((token) => tokens.has(token)).length;
				const values = extractValues(sentence);
				return { sentence, tokens, values, rank: overlap * 3 + values.length + (sentence.includes("%") ? 1 : 0) };
			})
			.filter((candidate) => candidate.rank > 0)
			.sort((a, b) => b.rank - a.rank)
			.slice(0, 4);
		for (const candidate of candidates) {
			claims.push({
				sourceKey: source.canonicalUrl,
				text: candidate.sentence,
				tokens: candidate.tokens,
				values: candidate.values,
			});
		}
	}
	return claims.slice(0, 32);
}

function findConflicts(rawClaims: readonly RawClaim[], sources: readonly DeepResearchSource[]): DeepResearchConflict[] {
	const sourceIdByKey = new Map(sources.map((source) => [source.canonicalUrl, source.id]));
	const conflicts: DeepResearchConflict[] = [];
	for (let i = 0; i < rawClaims.length; i++) {
		const left = rawClaims[i]!;
		for (let j = i + 1; j < rawClaims.length; j++) {
			const right = rawClaims[j]!;
			if (left.sourceKey === right.sourceKey || left.values.length === 0 || right.values.length === 0) continue;
			if (tokenSimilarity(left.tokens, right.tokens) < 0.36) continue;
			if (sameValues(left.values, right.values)) continue;
			conflicts.push({
				claimA: left.text,
				claimB: right.text,
				sourceA: sourceIdByKey.get(left.sourceKey) ?? "?",
				sourceB: sourceIdByKey.get(right.sourceKey) ?? "?",
				reason: `similar claims report different values (${left.values.join(", ")} vs ${right.values.join(", ")})`,
			});
			if (conflicts.length >= 8) return conflicts;
		}
	}
	return conflicts;
}

function finalizeClaims(
	rawClaims: readonly RawClaim[],
	conflicts: readonly DeepResearchConflict[],
	sources: readonly DeepResearchSource[],
): DeepResearchClaim[] {
	const sourceIdByKey = new Map(sources.map((source) => [source.canonicalUrl, source.id]));
	return rawClaims.slice(0, 20).map((claim, index) => {
		const sourceId = sourceIdByKey.get(claim.sourceKey) ?? "?";
		const supportingSourceIds = uniqueStrings(
			rawClaims
				.filter(
					(other) =>
						other.sourceKey !== claim.sourceKey &&
						tokenSimilarity(claim.tokens, other.tokens) >= 0.58 &&
						(claim.values.length === 0 || sameValues(claim.values, other.values)),
				)
				.map((other) => sourceIdByKey.get(other.sourceKey))
				.filter((id): id is string => id !== undefined && id !== sourceId),
		);
		const conflicted = conflicts.some(
			(conflict) =>
				(conflict.sourceA === sourceId && conflict.claimA === claim.text) ||
				(conflict.sourceB === sourceId && conflict.claimB === claim.text),
		);
		return {
			id: `C${index + 1}`,
			sourceId,
			text: claim.text,
			status: conflicted ? "conflicted" : supportingSourceIds.length > 0 ? "supported" : "weak",
			supportingSourceIds,
		};
	});
}

function extractValues(text: string): string[] {
	return uniqueStrings(
		(text.match(/\b(?:\d{4}|\d+(?:\.\d+)?%?|\$[\d,.]+(?:\s*(?:million|billion|trillion))?)\b/gi) ?? []).map((value) =>
			value.toLowerCase().replace(/,/g, ""),
		),
	);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function tokenSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection++;
	}
	return intersection / Math.min(left.size, right.size);
}

function tokenize(text: string): string[] {
	return uniqueStrings(
		text
			.toLowerCase()
			.match(/[a-z0-9][a-z0-9_-]{2,}/g)
			?.filter((token) => !STOP_WORDS.has(token)) ?? [],
	);
}

function normalizeText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value!)));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value!));
}

function normalizeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
