import { fauxAssistantMessage, registerFauxProvider } from "@axiom/ai";
import { afterEach, describe, expect, it } from "vitest";
import { RStarPlanner } from "../src/axiom/RStarPlanner.ts";
import type { AxiomAbstraction, AxiomTaskClassification } from "../src/axiom/RuntimeTypes.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("RStarPlanner", () => {
	it("expands branches and emits a reasoning graph", async () => {
		const registration = registerFauxProvider({ api: "faux:rstar-planner" });
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					branches: [
						{
							summary: "Patch quickly",
							action: "Inspect the obvious failing file.",
							pros: "Fast to start.",
							cons: "May miss the real cause.",
							feasibility: 7,
							completeness: 7,
							risk: 4,
							expectedTool: "grep",
						},
						{
							summary: "Trace the failure",
							action: "Search the stack trace and map it to code.",
							pros: "Targets the actual failure path.",
							cons: "Costs one extra lookup.",
							feasibility: 8,
							completeness: 8,
							risk: 2,
							expectedTool: "grep",
						},
					],
				}),
			),
			fauxAssistantMessage(
				JSON.stringify({
					children: [
						{
							summary: "Open mapped function",
							action: "Read the function named by the stack trace.",
							pros: "Connects symptoms to implementation.",
							cons: "Needs validation after patching.",
							feasibility: 9,
							completeness: 9,
							risk: 1,
							expectedTool: "read",
							terminal: true,
						},
					],
				}),
			),
			fauxAssistantMessage(
				JSON.stringify({
					children: [
						{
							summary: "Check neighboring callsite",
							action: "Read the closest caller before editing.",
							pros: "Avoids a narrow patch.",
							cons: "Slightly slower.",
							feasibility: 8,
							completeness: 8,
							risk: 3,
							expectedTool: "read",
							terminal: true,
						},
					],
				}),
			),
		]);

		const classification: AxiomTaskClassification = {
			id: "task-1",
			kind: "coding",
			route: "agent",
			complexity: 90,
			confidence: 0.9,
			reasons: ["test"],
		};
		const abstraction: AxiomAbstraction = {
			source: "fallback",
			problemClass: ["debugging"],
			keywords: ["stack", "trace", "failure"],
			domain: "typescript",
			latencyMs: 0,
		};

		const graph = await new RStarPlanner().plan({
			text: "Fix the failing TypeScript test.",
			classification,
			abstraction,
			availableTools: ["grep", "read", "bash"],
			llm: {
				model: registration.getModel(),
				apiKey: "test",
				timeoutMs: 1000,
				candidateCount: 2,
				rollouts: 2,
				maxDepth: 2,
				exploration: 1.4,
			},
		});

		expect(graph?.source).toBe("rstar");
		expect(graph?.search).toMatchObject({
			algorithm: "rstar-lite",
			rollouts: 2,
			maxDepth: 2,
			expandedNodes: 4,
		});
		expect(graph?.candidates.map((candidate) => candidate.id)).toContain(graph?.chosenId);
		expect(graph?.nodes).toHaveLength(3);
		expect(graph?.nodes[0]?.expectedTool).toBe("grep");
		expect(graph?.nodes[1]?.expectedTool).toBe("read");
		expect(registration.state.callCount).toBe(3);
	});
});
