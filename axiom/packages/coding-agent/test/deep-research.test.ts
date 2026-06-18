import { describe, expect, it, vi } from "vitest";
import { type DeepResearchBackend, DeepResearchEngine, formatDeepResearchEvidence } from "../src/axiom/DeepResearch.ts";
import type { BrowserPageExtractor } from "../src/axiom/PlaywrightPageExtractor.ts";
import type { WebFetchedPage, WebResearchResponse, WebSearchHit } from "../src/axiom/WebResearch.ts";

function hit(
	id: string,
	domain: string,
	title: string,
	snippet: string,
	sourceType: WebSearchHit["sourceType"],
): WebSearchHit {
	const url = `https://${domain}/${id.toLowerCase()}`;
	return {
		id,
		title,
		url,
		canonicalUrl: url,
		domain,
		snippet,
		score: 1,
		providers: ["test"],
		matchedQueries: ["AXIOM retrieval latency accuracy"],
		sourceType,
	};
}

function page(
	source: WebSearchHit,
	content: string,
	extractor: WebFetchedPage["extractor"] = "native",
): WebFetchedPage {
	return {
		id: source.id,
		title: source.title,
		url: source.url,
		canonicalUrl: source.canonicalUrl,
		domain: source.domain,
		content,
		contentType: "text/html",
		fetchedAt: "2026-06-06T00:00:00.000Z",
		truncated: false,
		extractor,
	};
}

function response(results: WebSearchHit[], pages: WebFetchedPage[]): WebResearchResponse {
	return {
		queries: ["test"],
		providers: ["test"],
		results,
		pages,
		warnings: [],
	};
}

describe("DeepResearchEngine", () => {
	it("iterates over evidence gaps and stops when bounded coverage is reached", async () => {
		const official = hit(
			"S1",
			"docs.example.com",
			"Official AXIOM retrieval documentation",
			"Primary documentation for AXIOM retrieval accuracy.",
			"documentation",
		);
		const benchmark = hit(
			"S2",
			"bench.example.org",
			"Independent AXIOM latency benchmark",
			"Independent measurements of retrieval latency and accuracy.",
			"research",
		);
		let call = 0;
		const backend: DeepResearchBackend = {
			research: vi.fn(async () => {
				call++;
				if (call === 1) {
					return response(
						[official],
						[page(official, "AXIOM retrieval accuracy is evaluated against a fixed evidence set. ".repeat(8))],
					);
				}
				return response(
					[benchmark],
					[
						page(
							benchmark,
							"The independent AXIOM retrieval latency benchmark measures accuracy and reports stable latency. ".repeat(
								8,
							),
						),
					],
				);
			}),
		};
		const engine = new DeepResearchEngine({ backend });

		const result = await engine.research({
			query: "AXIOM retrieval latency accuracy",
			maxRounds: 3,
			maxSources: 6,
			minFullSources: 2,
			coverageThreshold: 0.8,
			browser: "off",
		});

		expect(result.rounds).toHaveLength(2);
		expect(result.rounds[0]?.gaps.join(" ")).toContain("latency");
		expect(result.stopReason).toBe("coverage_reached");
		expect(result.coverage.queryTermCoverage).toBe(1);
		expect(result.sources.filter((source) => source.page)).toHaveLength(2);
		expect(backend.research).toHaveBeenCalledTimes(2);
	});

	it("uses Playwright only as a fallback for thin or missing extracted pages", async () => {
		const dynamic = hit(
			"S1",
			"dynamic.example.com",
			"Dynamic research dashboard",
			"JavaScript dashboard containing AXIOM benchmark evidence.",
			"official",
		);
		const backend: DeepResearchBackend = {
			research: vi.fn(async () => response([dynamic], [])),
			validatePublicUrl: vi.fn(async () => {}),
		};
		const browser: BrowserPageExtractor = {
			available: () => true,
			extract: vi.fn(async () => ({
				title: dynamic.title,
				url: dynamic.url,
				content:
					"The rendered AXIOM benchmark dashboard contains full retrieval evidence and measured latency. ".repeat(
						8,
					),
				contentType: "text/html; rendered=playwright",
			})),
		};
		const engine = new DeepResearchEngine({ backend, browserExtractor: browser });

		const result = await engine.research({
			query: "AXIOM benchmark retrieval latency",
			maxRounds: 1,
			minFullSources: 1,
			coverageThreshold: 0.35,
			browser: "auto",
		});

		expect(browser.extract).toHaveBeenCalledTimes(1);
		expect(backend.validatePublicUrl).toHaveBeenCalledTimes(2);
		expect(result.sources[0]?.page?.extractor).toBe("playwright");
	});

	it("flags incompatible numerical claims from similar independent evidence", async () => {
		const first = hit("S1", "lab-a.example", "AXIOM benchmark report A", "Verified benchmark report.", "research");
		const second = hit(
			"S2",
			"lab-b.example",
			"AXIOM benchmark report B",
			"Independent benchmark report.",
			"research",
		);
		const commonTail =
			" The report documents the benchmark setup, verified coding tasks, evaluation protocol, and reproducible evidence.";
		const backend: DeepResearchBackend = {
			research: vi.fn(async () =>
				response(
					[first, second],
					[
						page(
							first,
							`AXIOM benchmark evaluation reports a success rate of 72% across verified coding tasks.${commonTail}`,
						),
						page(
							second,
							`AXIOM benchmark evaluation reports a success rate of 61% across verified coding tasks.${commonTail}`,
						),
					],
				),
			),
		};
		const engine = new DeepResearchEngine({ backend });

		const result = await engine.research({
			query: "AXIOM benchmark success rate verified coding tasks",
			maxRounds: 1,
			minFullSources: 2,
			coverageThreshold: 0.35,
			browser: "off",
		});

		expect(result.conflicts).toHaveLength(1);
		expect(result.claims.some((claim) => claim.status === "conflicted")).toBe(true);
		expect(formatDeepResearchEvidence(result)).toContain("Potential conflicts requiring judgment");
	});
});
