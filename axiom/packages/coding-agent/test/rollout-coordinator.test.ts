import { describe, expect, it } from "vitest";
import { RolloutCoordinator, type RolloutVerification } from "../src/axiom/RolloutCoordinator.ts";

/** Build a verification result with sensible defaults; override only what a test cares about. */
function verification(over: Partial<RolloutVerification>): RolloutVerification {
	return {
		passed: false,
		issueCount: 1,
		changedFileCount: 1,
		signature: "sig",
		verifierCommand: "test",
		durationMs: 1,
		...over,
	};
}

/** A deterministic verify() driven by a per-index lookup table. */
function tableVerify(table: Record<number, Partial<RolloutVerification>>) {
	return async (_sample: number, index: number): Promise<RolloutVerification> => verification(table[index] ?? {});
}

const identitySample = async (index: number): Promise<number> => index;

describe("RolloutCoordinator", () => {
	it("selects the single passing rollout out of N failing ones", async () => {
		const coord = new RolloutCoordinator({ n: 4, earlyStopOnPass: false, idPrefix: "trace" });
		const result = await coord.run({
			sample: identitySample,
			verify: tableVerify({
				0: { passed: false, issueCount: 3 },
				1: { passed: false, issueCount: 2 },
				2: { passed: true, issueCount: 0, changedFileCount: 2 },
				3: { passed: false, issueCount: 1 },
			}),
		});

		expect(result.samplesRun).toBe(4);
		expect(result.selection?.winner.rolloutIndex).toBe(2);
		expect(result.selection?.winner.passed).toBe(true);
		expect(result.winner?.sample).toBe(2);
	});

	it("prefers the more surgical fix when multiple rollouts pass", async () => {
		const coord = new RolloutCoordinator({ n: 3, earlyStopOnPass: false });
		const result = await coord.run({
			sample: identitySample,
			verify: tableVerify({
				0: { passed: true, issueCount: 0, changedFileCount: 5 },
				1: { passed: true, issueCount: 0, changedFileCount: 1 },
				2: { passed: true, issueCount: 0, changedFileCount: 3 },
			}),
		});

		expect(result.selection?.winner.rolloutIndex).toBe(1);
		expect(result.selection?.reason).toContain("passing");
	});

	it("is order-independent: completion order does not change the winner", async () => {
		// Make later indices resolve FIRST by sleeping in inverse-index order.
		const coord = new RolloutCoordinator({ n: 3, earlyStopOnPass: false });
		const result = await coord.run({
			sample: async (index) => {
				await new Promise((r) => setTimeout(r, (3 - index) * 5));
				return index;
			},
			verify: tableVerify({
				0: { passed: true, issueCount: 0, changedFileCount: 2 },
				1: { passed: true, issueCount: 0, changedFileCount: 4 },
				2: { passed: true, issueCount: 0, changedFileCount: 9 },
			}),
		});

		// Index 0 is most surgical and must win even though index 2 finished first.
		expect(result.selection?.winner.rolloutIndex).toBe(0);
	});

	it("early-stops once a rollout passes: not all samples run", async () => {
		let sampled = 0;
		const coord = new RolloutCoordinator({ n: 6, concurrency: 1, earlyStopOnPass: true });
		const result = await coord.run({
			sample: async (index) => {
				sampled++;
				return index;
			},
			// Index 0 fails, index 1 passes — with concurrency 1 we should stop after 2.
			verify: tableVerify({ 0: { passed: false }, 1: { passed: true, issueCount: 0 } }),
		});

		expect(result.earlyStopped).toBe(true);
		expect(sampled).toBe(2);
		expect(result.samplesRun).toBe(2);
		expect(result.selection?.winner.rolloutIndex).toBe(1);
	});

	it("respects the concurrency limit (never more than k in flight)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const coord = new RolloutCoordinator({ n: 6, concurrency: 2, earlyStopOnPass: false });
		await coord.run({
			sample: async (index) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return index;
			},
			verify: tableVerify({}),
		});

		expect(maxInFlight).toBe(2);
	});

	it("isolates a throwing rollout: it becomes a failed candidate and others still win", async () => {
		const coord = new RolloutCoordinator({ n: 3, earlyStopOnPass: false });
		const result = await coord.run({
			sample: async (index) => {
				if (index === 1) throw new Error("boom");
				return index;
			},
			verify: tableVerify({
				0: { passed: false, issueCount: 2 },
				2: { passed: true, issueCount: 0 },
			}),
		});

		expect(result.samplesRun).toBe(3);
		const failed = result.outcomes.find((o) => o.index === 1);
		expect(failed?.error?.message).toBe("boom");
		expect(failed?.candidate.passed).toBe(false);
		expect(result.selection?.winner.rolloutIndex).toBe(2);
	});

	it("handles the all-fail case: still returns a closest candidate", async () => {
		const coord = new RolloutCoordinator({ n: 3, earlyStopOnPass: false });
		const result = await coord.run({
			sample: identitySample,
			verify: tableVerify({
				0: { passed: false, issueCount: 5 },
				1: { passed: false, issueCount: 2 },
				2: { passed: false, issueCount: 8 },
			}),
		});

		expect(result.earlyStopped).toBe(false);
		expect(result.selection?.winner.rolloutIndex).toBe(1);
		expect(result.selection?.winner.passed).toBe(false);
		expect(result.selection?.reason).toContain("closest");
	});

	it("degenerates cleanly to N=1", async () => {
		const coord = new RolloutCoordinator({ n: 1 });
		const result = await coord.run({
			sample: identitySample,
			verify: tableVerify({ 0: { passed: true, issueCount: 0 } }),
		});

		expect(result.samplesRun).toBe(1);
		expect(result.selection?.winner.rolloutIndex).toBe(0);
	});

	it("signals abort to in-flight samples on early stop", async () => {
		let abortedSeen = false;
		const coord = new RolloutCoordinator({ n: 4, concurrency: 4, earlyStopOnPass: true });
		await coord.run<number>({
			sample: async (index, signal) => {
				if (index === 0) return 0; // resolves immediately, passes -> triggers early stop
				await new Promise((r) => setTimeout(r, 20));
				if (signal.aborted) abortedSeen = true;
				return index;
			},
			verify: async (_sample, index) =>
				verification(index === 0 ? { passed: true, issueCount: 0 } : { passed: false }),
		});

		expect(abortedSeen).toBe(true);
	});

	it("clamps invalid options (n<1, concurrency>n)", async () => {
		const coord = new RolloutCoordinator({ n: 0, concurrency: 99 });
		const result = await coord.run({
			sample: identitySample,
			verify: tableVerify({ 0: { passed: true, issueCount: 0 } }),
		});
		// n clamps to 1; concurrency clamps to n.
		expect(result.samplesRun).toBe(1);
	});
});
