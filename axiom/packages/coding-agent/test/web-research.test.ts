import { describe, expect, it, vi } from "vitest";
import { extractReadableContent, formatWebResearchEvidence, WebResearchEngine } from "../src/axiom/WebResearch.ts";
import { createWebResearchToolDefinition } from "../src/core/tools/web-research.ts";

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function htmlResponse(value: string): Response {
	return new Response(value, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

describe("WebResearchEngine", () => {
	it("federates providers, deduplicates canonical URLs, and fetches full evidence", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.search.brave.com/")) {
				return jsonResponse({
					web: {
						results: [
							{
								title: "Official AXIOM Search Documentation",
								url: "https://docs.example.com/search?utm_source=brave",
								description: "Official search documentation and API behavior.",
							},
							{
								title: "Independent Search Review",
								url: "https://review.example.org/axiom-search",
								description: "Independent benchmark review.",
							},
						],
					},
				});
			}
			if (url === "https://api.tavily.com/search") {
				return jsonResponse({
					results: [
						{
							title: "Official AXIOM Search Documentation",
							url: "https://docs.example.com/search?utm_medium=tavily",
							content: "Primary documentation for AXIOM web search.",
							score: 0.98,
						},
						{
							title: "AXIOM Search Release Notes",
							url: "https://news.example.net/axiom-search",
							content: "Release notes covering current behavior.",
							score: 0.8,
						},
					],
				});
			}
			if (url === "https://docs.example.com/search") {
				return htmlResponse(`
					<html>
						<head><title>Official AXIOM Search Documentation</title><script>ignore()</script></head>
						<body>
							<nav>Navigation noise</nav>
							<main>
								<h1>Search API</h1>
								<p>The API federates providers and returns citation-ready evidence.</p>
								<p>Full source content is available for grounded synthesis and verification.</p>
							</main>
						</body>
					</html>
				`);
			}
			if (url === "https://review.example.org/axiom-search") {
				return htmlResponse(`
					<html><head><title>Independent Search Review</title></head><body><main>
					<p>The independent review compares source diversity, latency, and citation quality.</p>
					<p>It reports that full-page evidence reduces unsupported conclusions in final answers.</p>
					</main></body></html>
				`);
			}
			if (url === "https://news.example.net/axiom-search") {
				return htmlResponse(`
					<html><head><title>AXIOM Search Release Notes</title></head><body><main>
					<p>The release adds provider fallback, canonical URL deduplication, and bounded fetching.</p>
					</main></body></html>
				`);
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		const engine = new WebResearchEngine({
			fetch: fetchMock,
			env: { BRAVE_SEARCH_API_KEY: "brave-test", TAVILY_API_KEY: "tavily-test" },
			lookupHost: async () => ["93.184.216.34"],
			now: () => Date.UTC(2026, 5, 6),
		});

		const response = await engine.research({
			queries: ["AXIOM web search API"],
			provider: "all",
			count: 5,
			fetchTop: 2,
			maxCharsPerPage: 2_000,
			maxTotalChars: 4_000,
		});

		expect(response.providers.sort()).toEqual(["brave", "tavily"]);
		expect(response.results).toHaveLength(3);
		expect(response.results[0]).toMatchObject({
			id: "S1",
			canonicalUrl: "https://docs.example.com/search",
			providers: expect.arrayContaining(["brave", "tavily"]),
		});
		expect(response.pages[0]?.content).toContain("citation-ready evidence");
		expect(response.pages[0]?.content).not.toContain("Navigation noise");
		expect(formatWebResearchEvidence(response)).toContain("Evidence: full content via native");
	});

	it("caches repeated searches and pages within the TTL", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.startsWith("https://www.bing.com/search")) {
				return htmlResponse(`
					<li class="b_algo">
						<h2><a href="https://example.com/page">Example page</a></h2>
						<div class="b_caption"><p>A useful result for the query.</p></div>
					</li>
				`);
			}
			if (url === "https://example.com/page") {
				return htmlResponse(
					`<html><head><title>Example</title></head><body><main><p>${"Useful full content. ".repeat(30)}</p></main></body></html>`,
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		const engine = new WebResearchEngine({
			fetch: fetchMock,
			env: {},
			lookupHost: async () => ["93.184.216.34"],
			now: () => 1_000,
		});

		await engine.search({ queries: ["cache test"], provider: "auto" });
		await engine.search({ queries: ["cache test"], provider: "auto" });
		await engine.fetchPages({ urls: ["https://example.com/page"] });
		await engine.fetchPages({ urls: ["https://example.com/page"] });

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("blocks localhost and private DNS results before fetching", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const localhost = new WebResearchEngine({
			fetch: fetchMock,
			env: {},
			lookupHost: async () => ["127.0.0.1"],
		});
		const privateDns = new WebResearchEngine({
			fetch: fetchMock,
			env: {},
			lookupHost: async () => ["192.168.1.10"],
		});

		const localResult = await localhost.fetchPages({ urls: ["http://localhost:3000/private"] });
		const privateResult = await privateDns.fetchPages({ urls: ["https://internal.example/private"] });

		expect(localResult.pages).toHaveLength(0);
		expect(localResult.warnings[0]).toContain("Blocked private hostname");
		expect(privateResult.pages).toHaveLength(0);
		expect(privateResult.warnings[0]).toContain("Blocked non-public address");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("extracts readable HTML while dropping scripts, forms, and navigation", () => {
		const extracted = extractReadableContent(
			`
				<html>
					<head><title>Research &amp; Results</title><style>.bad { display: none }</style></head>
					<body>
						<nav>Menu item</nav>
						<article>
							<h1>Verified result</h1>
							<p>First evidence paragraph.</p>
							<form><input value="noise"></form>
							<p>Second evidence paragraph.</p>
						</article>
						<script>hallucinate()</script>
					</body>
				</html>
			`,
			"text/html",
			"https://example.com/research",
		);

		expect(extracted.title).toBe("Research & Results");
		expect(extracted.content).toContain("Verified result");
		expect(extracted.content).toContain("Second evidence paragraph.");
		expect(extracted.content).not.toContain("Menu item");
		expect(extracted.content).not.toContain("hallucinate");
		expect(extracted.content).not.toContain("noise");
	});

	it("exposes research as a default-ready tool with citation instructions", () => {
		const definition = createWebResearchToolDefinition({
			fetch: vi.fn<typeof fetch>(),
			env: {},
			lookupHost: async () => ["93.184.216.34"],
		});

		expect(definition.name).toBe("web_research");
		expect(definition.promptSnippet).toContain("deep research");
		expect(definition.promptGuidelines?.join(" ")).toContain("primary sources");
		expect(definition.promptGuidelines?.join(" ")).toContain("coverage");
	});
});
