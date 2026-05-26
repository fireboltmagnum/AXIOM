import { fauxAssistantMessage, registerFauxProvider } from "@axiom/ai";
import { afterEach, describe, expect, it } from "vitest";
import { GraphPlanner } from "../src/axiom/GraphPlanner.ts";
import type { AxiomAbstraction, AxiomTaskClassification } from "../src/axiom/RuntimeTypes.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

const classification: AxiomTaskClassification = {
	id: "task-1",
	kind: "coding",
	route: "agent",
	complexity: 92,
	confidence: 0.9,
	reasons: ["test"],
};

const abstraction: AxiomAbstraction = {
	source: "fallback",
	problemClass: ["feature-build"],
	keywords: ["auth", "login", "schema"],
	domain: "typescript",
	latencyMs: 0,
};

describe("GraphPlanner", () => {
	it("parses a recursive execution tree with atomic leaves", async () => {
		const registration = registerFauxProvider({ api: "faux:graph-planner" });
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					candidates: [
						{
							id: "c1",
							summary: "Build auth recursively.",
							pros: "Covers schema and endpoint.",
							cons: "Needs verification.",
							feasibility: 9,
							completeness: 9,
							risk: 2,
						},
						{
							id: "c2",
							summary: "Patch only the route.",
							pros: "Small.",
							cons: "Misses persistence.",
							feasibility: 7,
							completeness: 5,
							risk: 4,
						},
					],
					chosenId: "c1",
					chosenReason: "It covers the full auth path.",
					nodes: [
						{
							id: "n1",
							description: "Build authentication system",
							dependencies: [],
							atomic: false,
							successCriteria: "All auth child actions are complete.",
							output: "Working authentication slice.",
						},
						{
							id: "n1.1",
							parentId: "n1",
							depth: 2,
							description: "Create users table migration",
							dependencies: [],
							atomic: true,
							successCriteria: "Migration defines id, email, and password_hash columns.",
							output: "Users migration file.",
							expectedTool: "edit",
						},
						{
							id: "n1.2",
							parentId: "n1",
							depth: 2,
							description: "Create login route handler",
							dependencies: ["n1.1"],
							atomic: true,
							successCriteria: "POST /login validates credentials and returns a session token.",
							output: "Login route handler.",
							expectedTool: "edit",
						},
					],
				}),
			),
		]);

		const graph = await new GraphPlanner().plan({
			text: "Build authentication.",
			classification,
			abstraction,
			availableTools: ["rg", "read", "edit", "bash"],
			llm: {
				model: registration.getModel(),
				apiKey: "test",
				timeoutMs: 1000,
				candidateCount: 2,
			},
		});

		expect(graph.source).toBe("llm");
		expect(graph.chosenId).toBe("c1");
		expect(graph.nodes).toHaveLength(3);
		expect(graph.nodes[0]).toMatchObject({
			id: "n1",
			atomic: false,
			depth: 1,
			successCriteria: "All auth child actions are complete.",
		});
		expect(graph.nodes[1]).toMatchObject({
			id: "n1.1",
			parentId: "n1",
			depth: 2,
			atomic: true,
			expectedTool: "edit",
			output: "Users migration file.",
		});
		expect(graph.nodes[2]).toMatchObject({
			id: "n1.2",
			parentId: "n1",
			dependencies: ["n1.1"],
			atomic: true,
		});
	});

	it("infers parent, depth, and atomic leaf status from dotted ids", async () => {
		const registration = registerFauxProvider({ api: "faux:graph-planner-infer" });
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					candidates: [
						{
							id: "c1",
							summary: "Decompose by files.",
							feasibility: 8,
							completeness: 8,
							risk: 2,
						},
					],
					chosenId: "c1",
					chosenReason: "Best scored plan.",
					nodes: [
						{ id: "n1", description: "Prepare verifier", dependencies: [] },
						{ id: "n1.1", description: "Read package scripts", dependencies: [], expectedTool: "read" },
						{ id: "n1.2", description: "Run cheapest verifier", dependencies: ["n1.1"], expectedTool: "bash" },
					],
				}),
			),
		]);

		const graph = await new GraphPlanner().plan({
			text: "Add a repair loop.",
			classification,
			abstraction,
			availableTools: ["rg", "read", "bash"],
			llm: {
				model: registration.getModel(),
				apiKey: "test",
				timeoutMs: 1000,
				candidateCount: 1,
			},
		});

		expect(graph.nodes[0]).toMatchObject({
			id: "n1",
			depth: 1,
			atomic: false,
			successCriteria: "All child actions are complete.",
		});
		expect(graph.nodes[1]).toMatchObject({
			id: "n1.1",
			parentId: "n1",
			depth: 2,
			atomic: true,
			expectedTool: "read",
			output: "Completed atomic action.",
		});
		expect(graph.nodes[2]).toMatchObject({
			id: "n1.2",
			parentId: "n1",
			depth: 2,
			atomic: true,
			dependencies: ["n1.1"],
		});
	});
});
