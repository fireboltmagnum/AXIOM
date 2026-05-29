import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AxiomContextLedgerCandidate,
	AxiomContextLedgerDecision,
	AxiomContextLedgerEntry,
	AxiomContextLedgerOutcome,
	AxiomContextLedgerPlan,
} from "./RuntimeTypes.ts";

interface ContextLedgerInjection {
	traceId: string;
	taskSignature: string;
	taskKind: string;
	timestamp: string;
	itemKeys: string[];
	estimatedTokens: number;
	outcome?: AxiomContextLedgerOutcome;
	outcomeAt?: string;
}

interface ContextLedgerSnapshot {
	version: 1;
	updatedAt: string;
	entries: AxiomContextLedgerEntry[];
	injections: ContextLedgerInjection[];
}

export interface ContextLedgerEvaluateOptions {
	traceId?: string;
	taskSignature: string;
	taskKind: string;
	keywords: readonly string[];
	candidates: readonly AxiomContextLedgerCandidate[];
	maxEstimatedTokens: number;
}

/**
 * Persistent context ROI ledger.
 *
 * Context Agent recall can become a benchmark liability: old lessons, stale
 * code maps, and broad document hits consume tokens before the agent has done
 * any work. The ledger makes context injection measurable. Every recall item
 * gets a stable key, estimated token cost, and success/failure history. Future
 * planning can then skip repeated low-ROI context or trim by value density when
 * the recall bundle exceeds a configured budget.
 */
export class ContextLedgerStore {
	private readonly baseDir: string;
	private readonly storePath: string;
	private readonly reportPath: string;
	private cached: ContextLedgerSnapshot | undefined;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "context-ledger");
		this.storePath = join(this.baseDir, "ledger.json");
		this.reportPath = join(this.baseDir, "CONTEXT_LEDGER.md");
	}

	evaluateAndRecord(options: ContextLedgerEvaluateOptions): AxiomContextLedgerPlan {
		const snapshot = this.load();
		const queryKeywords = new Set(options.keywords.map((k) => normalizeToken(k)).filter(Boolean));
		const decisions = options.candidates.map((candidate) => this.scoreCandidate(snapshot, candidate, queryKeywords));

		const initiallyInjected = decisions.filter((decision) => decision.action === "inject");
		const toxicDropped = decisions.filter((decision) => decision.action === "drop");
		const budgeted = applyTokenBudget(initiallyInjected, Math.max(0, options.maxEstimatedTokens));
		const injectedKeys = new Set(budgeted.injected.map((decision) => decision.key));
		const injected = initiallyInjected.filter((decision) => injectedKeys.has(decision.key));
		const budgetDropped = initiallyInjected
			.filter((decision) => !injectedKeys.has(decision.key))
			.map((decision) => ({
				...decision,
				action: "drop" as const,
				reason: `ContextLedger budget trim: lower ROI than kept context (budget ${options.maxEstimatedTokens} tokens).`,
			}));
		const dropped = [...toxicDropped, ...budgetDropped];
		const now = new Date().toISOString();
		const injectedTokenCount = sumTokens(injected);
		const plan: AxiomContextLedgerPlan = {
			taskSignature: options.taskSignature,
			traceId: options.traceId,
			injected,
			dropped,
			estimatedTokensInjected: injectedTokenCount,
			estimatedTokensSaved: sumTokens(dropped),
		};

		if (injected.length > 0) {
			for (const decision of injected) {
				upsertEntry(snapshot, decision, {
					now,
					traceId: options.traceId,
					taskKind: options.taskKind,
					keywords: [...queryKeywords],
				});
			}
			if (options.traceId) {
				snapshot.injections.push({
					traceId: options.traceId,
					taskSignature: options.taskSignature,
					taskKind: options.taskKind,
					timestamp: now,
					itemKeys: injected.map((decision) => decision.key),
					estimatedTokens: injectedTokenCount,
				});
				snapshot.injections = snapshot.injections.slice(-500);
			}
			snapshot.updatedAt = now;
			this.flush(snapshot);
		}

		return plan;
	}

	recordOutcome(traceId: string | undefined, outcome: AxiomContextLedgerOutcome): number {
		if (!traceId) return 0;
		const snapshot = this.load();
		const injection = [...snapshot.injections].reverse().find((candidate) => candidate.traceId === traceId);
		if (!injection || injection.outcome) return 0;
		const now = new Date().toISOString();
		const itemKeys = new Set(injection.itemKeys);
		let mutated = 0;
		for (const entry of snapshot.entries) {
			if (!itemKeys.has(entry.key)) continue;
			if (outcome === "success") {
				entry.successCount++;
				entry.failureStreak = 0;
			} else {
				entry.failureCount++;
				entry.failureStreak++;
			}
			entry.lastOutcomeAt = now;
			mutated++;
		}
		injection.outcome = outcome;
		injection.outcomeAt = now;
		snapshot.updatedAt = now;
		this.flush(snapshot);
		return mutated;
	}

	all(): AxiomContextLedgerEntry[] {
		return [...this.load().entries];
	}

	private scoreCandidate(
		snapshot: ContextLedgerSnapshot,
		candidate: AxiomContextLedgerCandidate,
		queryKeywords: Set<string>,
	): AxiomContextLedgerDecision {
		const entry = snapshot.entries.find((item) => item.key === candidate.key);
		const history = {
			injectCount: entry?.injectCount ?? 0,
			successCount: entry?.successCount ?? 0,
			failureCount: entry?.failureCount ?? 0,
			failureStreak: entry?.failureStreak ?? 0,
		};
		const matchedKeywords = new Set(candidate.matchedKeywords.map((k) => normalizeToken(k)).filter(Boolean));
		let queryOverlap = 0;
		for (const token of matchedKeywords) {
			if (queryKeywords.has(token)) queryOverlap++;
		}
		const confidence = (history.successCount + 1) / (history.successCount + history.failureCount + 2);
		const freshnessBoost = history.injectCount === 0 ? 0.75 : 0;
		const tokenPenalty = Math.min(1.75, candidate.estimatedTokens / 900);
		const failurePenalty = Math.min(2.5, history.failureStreak * 0.8);
		const ledgerScore =
			candidate.relevanceScore +
			queryOverlap * 0.35 +
			confidence * 1.6 +
			freshnessBoost -
			tokenPenalty -
			failurePenalty;

		let action: AxiomContextLedgerDecision["action"] = "inject";
		let reason = `ROI ${round(ledgerScore)}; confidence ${round(confidence)}; ${candidate.estimatedTokens} estimated tokens.`;
		if (history.injectCount >= 2 && history.failureCount >= history.successCount + 2 && ledgerScore < 1.75) {
			action = "drop";
			reason = `ContextLedger suppressed repeated low-ROI context: ${history.failureCount} failed outcome(s), ${history.successCount} successful outcome(s), score ${round(ledgerScore)}.`;
		}

		return {
			...candidate,
			action,
			ledgerScore,
			reason,
			history,
		};
	}

	private load(): ContextLedgerSnapshot {
		if (this.cached) return this.cached;
		if (!existsSync(this.storePath)) {
			this.cached = { version: 1, updatedAt: new Date(0).toISOString(), entries: [], injections: [] };
			return this.cached;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.storePath, "utf-8")) as ContextLedgerSnapshot;
			this.cached = {
				version: 1,
				updatedAt: parsed.updatedAt ?? new Date().toISOString(),
				entries: Array.isArray(parsed.entries) ? parsed.entries : [],
				injections: Array.isArray(parsed.injections) ? parsed.injections : [],
			};
		} catch {
			this.cached = { version: 1, updatedAt: new Date(0).toISOString(), entries: [], injections: [] };
		}
		return this.cached;
	}

	private flush(snapshot: ContextLedgerSnapshot): void {
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			writeFileSync(this.storePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
			writeFileSync(this.reportPath, renderReport(snapshot.entries), "utf-8");
			this.cached = snapshot;
		} catch {
			// Context ROI is advisory. Planning must continue even if persistence
			// fails because a disk path is unavailable or readonly.
		}
	}
}

function applyTokenBudget(
	decisions: AxiomContextLedgerDecision[],
	maxEstimatedTokens: number,
): { injected: AxiomContextLedgerDecision[] } {
	if (maxEstimatedTokens <= 0 || sumTokens(decisions) <= maxEstimatedTokens) return { injected: decisions };
	const ranked = [...decisions].sort(
		(a, b) =>
			valueDensity(b) - valueDensity(a) || b.ledgerScore - a.ledgerScore || a.estimatedTokens - b.estimatedTokens,
	);
	let budget = 0;
	const keep = new Set<string>();
	for (const decision of ranked) {
		if (budget + decision.estimatedTokens > maxEstimatedTokens && keep.size > 0) continue;
		keep.add(decision.key);
		budget += decision.estimatedTokens;
	}
	return { injected: decisions.filter((decision) => keep.has(decision.key)) };
}

function valueDensity(decision: AxiomContextLedgerDecision): number {
	return decision.ledgerScore / Math.max(1, Math.sqrt(decision.estimatedTokens));
}

function upsertEntry(
	snapshot: ContextLedgerSnapshot,
	decision: AxiomContextLedgerDecision,
	options: { now: string; traceId?: string; taskKind: string; keywords: string[] },
): void {
	let entry = snapshot.entries.find((item) => item.key === decision.key);
	if (!entry) {
		entry = {
			key: decision.key,
			kind: decision.kind,
			label: decision.label,
			summary: decision.summary,
			sourceIds: decision.sourceIds,
			keywords: unique([...decision.matchedKeywords, ...options.keywords]).slice(0, 32),
			firstInjectedAt: options.now,
			lastInjectedAt: options.now,
			injectCount: 0,
			successCount: 0,
			failureCount: 0,
			failureStreak: 0,
			totalEstimatedTokens: 0,
			lastEstimatedTokens: decision.estimatedTokens,
			lastScore: decision.ledgerScore,
			lastReason: decision.reason,
			taskKinds: [],
			traceIds: [],
		};
		snapshot.entries.push(entry);
	}
	entry.kind = decision.kind;
	entry.label = decision.label;
	entry.summary = decision.summary;
	entry.sourceIds = unique([...decision.sourceIds, ...entry.sourceIds]).slice(0, 16);
	entry.keywords = unique([...decision.matchedKeywords, ...options.keywords, ...entry.keywords]).slice(0, 32);
	entry.lastInjectedAt = options.now;
	entry.injectCount++;
	entry.totalEstimatedTokens += decision.estimatedTokens;
	entry.lastEstimatedTokens = decision.estimatedTokens;
	entry.lastScore = decision.ledgerScore;
	entry.lastReason = decision.reason;
	entry.taskKinds = unique([options.taskKind, ...entry.taskKinds]).slice(0, 12);
	if (options.traceId) entry.traceIds = unique([options.traceId, ...entry.traceIds]).slice(0, 20);
}

function sumTokens(decisions: readonly AxiomContextLedgerDecision[]): number {
	return decisions.reduce((sum, decision) => sum + Math.max(0, decision.estimatedTokens), 0);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeToken(token: string): string {
	return token.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "");
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function renderReport(entries: readonly AxiomContextLedgerEntry[]): string {
	const lines = ["# AXIOM ContextLedger", ""];
	lines.push("Context items ranked by learned ROI. Higher confidence and lower token cost are better.");
	lines.push("");
	for (const entry of [...entries].sort((a, b) => b.lastScore - a.lastScore).slice(0, 200)) {
		const confidence = (entry.successCount + 1) / (entry.successCount + entry.failureCount + 2);
		lines.push(
			`- ${entry.kind} ${entry.label}: score ${round(entry.lastScore)}, confidence ${round(confidence)}, injected ${entry.injectCount}x, success ${entry.successCount}, failure ${entry.failureCount}, last tokens ${entry.lastEstimatedTokens}`,
		);
		lines.push(`  ${entry.summary}`);
		if (entry.lastReason) lines.push(`  Last reason: ${entry.lastReason}`);
	}
	lines.push("");
	return lines.join("\n");
}
