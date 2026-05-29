import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextLedgerStore } from "../src/axiom/ContextLedgerStore.ts";
import type { AxiomContextLedgerCandidate } from "../src/axiom/RuntimeTypes.ts";

describe("ContextLedgerStore", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `axiom-context-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("records injected context outcomes and suppresses repeated low-ROI items", () => {
		const store = new ContextLedgerStore(testDir);
		const candidate: AxiomContextLedgerCandidate = {
			key: "reflection:bad-context",
			kind: "reflection",
			label: "bad-context",
			summary: "Old lesson that repeatedly failed this task shape.",
			sourceIds: ["bad-context"],
			matchedKeywords: ["router"],
			relevanceScore: 0.1,
			estimatedTokens: 900,
		};

		for (let i = 0; i < 2; i++) {
			const traceId = `trace-${i}`;
			const plan = store.evaluateAndRecord({
				traceId,
				taskSignature: `task-${i}`,
				taskKind: "coding",
				keywords: ["router"],
				candidates: [candidate],
				maxEstimatedTokens: 2000,
			});
			expect(plan.injected).toHaveLength(1);
			expect(store.recordOutcome(traceId, "failure")).toBe(1);
		}

		const next = store.evaluateAndRecord({
			traceId: "trace-3",
			taskSignature: "task-3",
			taskKind: "coding",
			keywords: ["router"],
			candidates: [candidate],
			maxEstimatedTokens: 2000,
		});

		expect(next.injected).toHaveLength(0);
		expect(next.dropped[0]?.reason).toContain("suppressed repeated low-ROI context");
	});

	it("keeps the highest value-density context inside the token budget", () => {
		const store = new ContextLedgerStore(testDir);
		const candidates: AxiomContextLedgerCandidate[] = [
			{
				key: "sparse_tree_grep:doc:large",
				kind: "sparse_tree_grep",
				label: "large",
				summary: "Large but weak document hit.",
				sourceIds: ["doc", "large"],
				matchedKeywords: ["auth"],
				relevanceScore: 0.2,
				estimatedTokens: 1200,
			},
			{
				key: "flow_graph:repo:exact",
				kind: "flow_graph",
				label: "exact",
				summary: "Exact flow hit for the current prompt.",
				sourceIds: ["repo", "exact"],
				matchedKeywords: ["auth", "login"],
				relevanceScore: 5,
				estimatedTokens: 300,
			},
		];

		const plan = store.evaluateAndRecord({
			traceId: "trace-budget",
			taskSignature: "task-budget",
			taskKind: "coding",
			keywords: ["auth", "login"],
			candidates,
			maxEstimatedTokens: 500,
		});

		expect(plan.injected.map((decision) => decision.key)).toEqual(["flow_graph:repo:exact"]);
		expect(plan.dropped.map((decision) => decision.key)).toContain("sparse_tree_grep:doc:large");
		expect(plan.estimatedTokensSaved).toBeGreaterThan(0);
	});
});
