import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface BrowserPageExtraction {
	title: string;
	url: string;
	content: string;
	contentType: string;
}

export interface BrowserPageExtractor {
	available(): boolean;
	extract(url: string, maxChars: number, signal?: AbortSignal): Promise<BrowserPageExtraction>;
}

export interface PlaywrightPageExtractorOptions {
	cwd: string;
	timeoutMs?: number;
	packageRoot?: string;
}

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 18_000;
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * Optional JavaScript-rendered page extraction. It deliberately runs in a
 * subprocess so AXIOM does not need a hard Playwright dependency and a browser
 * crash cannot take down the agent process.
 */
export class PlaywrightPageExtractor implements BrowserPageExtractor {
	private readonly cwd: string;
	private readonly timeoutMs: number;
	private readonly packageRoot?: string;

	constructor(options: PlaywrightPageExtractorOptions) {
		this.cwd = options.cwd;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.packageRoot = options.packageRoot ?? findPlaywrightPackage(options.cwd);
	}

	available(): boolean {
		return this.packageRoot !== undefined;
	}

	async extract(url: string, maxChars: number, signal?: AbortSignal): Promise<BrowserPageExtraction> {
		if (!this.packageRoot) {
			throw new Error("Playwright extraction is unavailable; install playwright or @playwright/test.");
		}
		const directory = mkdtempSync(path.join(tmpdir(), "axiom-playwright-extract-"));
		const scriptPath = path.join(directory, "extract.cjs");
		writeFileSync(scriptPath, PLAYWRIGHT_EXTRACT_SCRIPT, "utf-8");
		try {
			const run = await runNodeScript(
				scriptPath,
				[this.packageRoot, url, String(maxChars), String(this.timeoutMs)],
				this.cwd,
				this.timeoutMs + 2_000,
				signal,
			);
			if (run.timedOut) throw new Error(`Playwright extraction timed out after ${this.timeoutMs}ms.`);
			if (run.exitCode !== 0) {
				throw new Error(cleanProcessError(run.stderr || run.stdout || "Playwright extraction failed."));
			}
			const parsed = parseExtraction(run.stdout);
			return {
				title: parsed.title,
				url: parsed.url,
				content: parsed.content.slice(0, maxChars),
				contentType: "text/html; rendered=playwright",
			};
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

export function findPlaywrightPackage(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	for (;;) {
		for (const candidate of [
			path.join(current, "node_modules", "playwright"),
			path.join(current, "node_modules", "@playwright", "test"),
		]) {
			if (existsSync(path.join(candidate, "package.json"))) return candidate;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const npxRoot = path.join(homedir(), ".npm", "_npx");
	if (!existsSync(npxRoot)) return undefined;
	for (const entry of readdirSync(npxRoot).sort().reverse()) {
		for (const candidate of [
			path.join(npxRoot, entry, "node_modules", "playwright"),
			path.join(npxRoot, entry, "node_modules", "@playwright", "test"),
		]) {
			if (existsSync(path.join(candidate, "package.json"))) return candidate;
		}
	}
	return undefined;
}

const PLAYWRIGHT_EXTRACT_SCRIPT = String.raw`
const packageRoot = process.argv[2];
const targetUrl = process.argv[3];
const maxChars = Number(process.argv[4]);
const timeoutMs = Number(process.argv[5]);
const dns = require("node:dns").promises;
const { isIP } = require("node:net");
const hostSafety = new Map();

function privateAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.includes(":")) {
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:");
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function blockedUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (hostSafety.has(host)) return hostSafety.get(host);
    const syntacticallyBlocked = host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "::1";
    if (syntacticallyBlocked) {
      hostSafety.set(host, true);
      return true;
    }
    const addresses = isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true })).map(row => row.address);
    const blocked = addresses.length === 0 || addresses.some(privateAddress);
    hostSafety.set(host, blocked);
    return blocked;
  } catch {
    return true;
  }
}

(async () => {
  if (await blockedUrl(targetUrl)) throw new Error("Blocked private browser target.");
  const playwright = require(packageRoot);
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: true,
      serviceWorkers: "block",
      userAgent: "Mozilla/5.0 (compatible; AXIOM-DeepResearch/1.0)"
    });
    await context.route("**/*", async route => {
      const request = route.request();
      const type = request.resourceType();
      if (await blockedUrl(request.url())) return route.abort();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(
      () => (document.body?.innerText?.trim().length ?? 0) >= 240,
      undefined,
      { timeout: Math.min(2500, timeoutMs) }
    ).catch(() => {});
    const result = await page.evaluate(limit => {
      const root = document.querySelector("article, main, [role=main]") || document.body;
      if (!root) return { title: document.title, content: "" };
      const clone = root.cloneNode(true);
      clone.querySelectorAll(
        "script,style,svg,canvas,template,noscript,form,nav,footer,aside,[aria-hidden=true]"
      ).forEach(node => node.remove());
      const content = (clone.innerText || clone.textContent || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
        .slice(0, limit);
      return { title: document.title || location.hostname, content };
    }, maxChars);
    const finalUrl = page.url();
    if (await blockedUrl(finalUrl)) throw new Error("Rendered page redirected to a private target.");
    process.stdout.write(JSON.stringify({ ...result, url: finalUrl }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

function runNodeScript(
	scriptPath: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			cwd,
			env: { ...process.env, NO_PROXY: "localhost,127.0.0.1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf-8")).slice(-MAX_OUTPUT_BYTES);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		const stop = () => {
			timedOut = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(stop, timeoutMs);
		const abort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: null, timedOut });
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, exitCode, timedOut });
		});
	});
}

function parseExtraction(stdout: string): { title: string; url: string; content: string } {
	const value = JSON.parse(stdout) as { title?: unknown; url?: unknown; content?: unknown };
	if (typeof value.url !== "string" || typeof value.content !== "string") {
		throw new Error("Playwright returned an invalid extraction payload.");
	}
	return {
		title: typeof value.title === "string" ? value.title : new URL(value.url).hostname,
		url: value.url,
		content: value.content,
	};
}

function cleanProcessError(value: string): string {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 6)
		.join(" | ");
}
