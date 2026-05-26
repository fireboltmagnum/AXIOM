import { completeSimple, type Model } from "@axiom/ai";
import type {
	AxiomAbstraction,
	AxiomGraphNode,
	AxiomReasoningCandidate,
	AxiomReasoningGraph,
	AxiomTaskClassification,
} from "./RuntimeTypes.ts";

interface LLMOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs: number;
	candidateCount: number;
	rollouts: number;
	maxDepth: number;
	exploration: number;
}

interface RawBranch {
	summary?: unknown;
	action?: unknown;
	pros?: unknown;
	cons?: unknown;
	feasibility?: unknown;
	completeness?: unknown;
	risk?: unknown;
	expectedTool?: unknown;
	terminal?: unknown;
}

interface SearchNode {
	id: string;
	parentId?: string;
	depth: number;
	summary: string;
	action: string;
	pros?: string;
	cons?: string;
	feasibility?: number;
	completeness?: number;
	risk?: number;
	score: number;
	expectedTool?: string;
	terminal?: boolean;
	children: string[];
	visits: number;
	totalValue: number;
	lastSearchScore?: number;
}

const ROOT_ID = "root";

function buildRootPrompt(candidateCount: number, availableTools: string[]): string {
	const tools = availableTools.length > 0 ? availableTools.join(", ") : "(no tools)";
	return `You are AXIOM's rStar-lite planner. You do NOT answer the user. You produce root search branches for a small MCTS/GoT planner.

Return one valid JSON object and nothing else:
{
  "branches": [
    {
      "summary": "short branch name",
      "action": "first concrete move for this approach",
      "pros": "why this branch can work",
      "cons": "main weakness",
      "feasibility": 8,
      "completeness": 7,
      "risk": 3,
      "expectedTool": "rg"
    }
  ]
}

Rules:
- Produce ${candidateCount} meaningfully different branches.
- Scores are integers in [1, 10].
- feasibility and completeness are higher-is-better; risk is lower-is-better.
- expectedTool is optional and must be one of: ${tools}.
- Each action should be a concrete executable move, not a broad placeholder.
- Keep each string one short sentence.`;
}

function buildExpandPrompt(availableTools: string[]): string {
	const tools = availableTools.length > 0 ? availableTools.join(", ") : "(no tools)";
	return `You are AXIOM's rStar-lite planner. Expand one search node into the next possible moves. You do NOT answer the user.

Return one valid JSON object and nothing else:
{
  "children": [
    {
      "summary": "short child branch name",
      "action": "next concrete move",
      "pros": "why this child improves the plan",
      "cons": "main weakness",
      "feasibility": 8,
      "completeness": 8,
      "risk": 2,
      "expectedTool": "read",
      "terminal": false
    }
  ]
}

Rules:
- Produce 1-3 useful children.
- Scores are integers in [1, 10].
- Mark terminal=true only when the branch has enough detail to execute directly as one atomic action.
- Prefer children that make the selected path more executable, measurable, and easy to verify.
- expectedTool is optional and must be one of: ${tools}.
- Keep strings short and concrete.`;
}

function extractJson(text: string): string | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) return fenced[1].trim();
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function textFromResult(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("")
		.trim();
}

function clampScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(10, Math.max(1, Math.round(value)));
}

function baseValue(branch: RawBranch): {
	feasibility?: number;
	completeness?: number;
	risk?: number;
	score: number;
} {
	const feasibility = clampScore(branch.feasibility);
	const completeness = clampScore(branch.completeness);
	const risk = clampScore(branch.risk);
	const score =
		feasibility !== undefined && completeness !== undefined && risk !== undefined
			? feasibility + completeness - risk
			: 5;
	return { feasibility, completeness, risk, score };
}

function parseBranches(raw: string, key: "branches" | "children"): RawBranch[] {
	const json = extractJson(raw);
	if (!json) return [];
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const value = parsed[key];
	if (!Array.isArray(value)) return [];
	return value.filter((branch): branch is RawBranch => {
		const b = branch as RawBranch;
		return typeof b.summary === "string" || typeof b.action === "string";
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	if (ms <= 0) return promise;
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(null);
			});
	});
}

function asShortString(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function allowedTool(value: unknown, allowedTools: Set<string>): string | undefined {
	if (typeof value !== "string") return undefined;
	const tool = value.trim();
	if (!tool) return undefined;
	if (allowedTools.size > 0 && !allowedTools.has(tool)) return undefined;
	return tool;
}

function chooseBest(nodes: Map<string, SearchNode>): SearchNode | undefined {
	return [...nodes.values()]
		.filter((node) => node.id !== ROOT_ID)
		.sort((a, b) => {
			const aValue = a.visits > 0 ? a.totalValue / a.visits : a.score;
			const bValue = b.visits > 0 ? b.totalValue / b.visits : b.score;
			return bValue - aValue || b.score - a.score || a.depth - b.depth;
		})[0];
}

function pathToNode(nodes: Map<string, SearchNode>, id: string): SearchNode[] {
	const path: SearchNode[] = [];
	let current = nodes.get(id);
	while (current && current.id !== ROOT_ID) {
		path.unshift(current);
		current = current.parentId ? nodes.get(current.parentId) : undefined;
	}
	return path;
}

function ucbScore(node: SearchNode, parentVisits: number, exploration: number): number {
	if (node.visits === 0) return Number.POSITIVE_INFINITY;
	const mean = node.totalValue / node.visits;
	const bonus = exploration * Math.sqrt(Math.log(Math.max(parentVisits, 1) + 1) / node.visits);
	return mean + bonus;
}

function selectLeaf(nodes: Map<string, SearchNode>, maxDepth: number, exploration: number): SearchNode {
	let current = nodes.get(ROOT_ID);
	if (!current) throw new Error("missing rStar root");
	while (current.children.length > 0 && current.depth < maxDepth && !current.terminal) {
		const parentVisits = current.visits;
		const candidates: SearchNode[] = current.children
			.map((id) => nodes.get(id))
			.filter((node): node is SearchNode => node !== undefined);
		if (candidates.length === 0) break;
		candidates.sort((a, b) => {
			const aScore = ucbScore(a, parentVisits, exploration);
			const bScore = ucbScore(b, parentVisits, exploration);
			a.lastSearchScore = aScore;
			b.lastSearchScore = bScore;
			return bScore - aScore || b.score - a.score;
		});
		const next = candidates[0];
		if (!next) break;
		current = next;
		if (current.visits === 0 || current.children.length === 0) break;
	}
	return current;
}

function backprop(nodes: Map<string, SearchNode>, node: SearchNode, value: number): void {
	let current: SearchNode | undefined = node;
	while (current) {
		current.visits += 1;
		current.totalValue += value;
		current = current.parentId ? nodes.get(current.parentId) : undefined;
	}
}

function makeNode(
	id: string,
	raw: RawBranch,
	parentId: string | undefined,
	depth: number,
	allowedTools: Set<string>,
): SearchNode {
	const scores = baseValue(raw);
	const summary = asShortString(raw.summary, asShortString(raw.action, "Unnamed branch"));
	const action = asShortString(raw.action, summary);
	return {
		id,
		parentId,
		depth,
		summary,
		action,
		pros: typeof raw.pros === "string" ? asShortString(raw.pros, "") : undefined,
		cons: typeof raw.cons === "string" ? asShortString(raw.cons, "") : undefined,
		feasibility: scores.feasibility,
		completeness: scores.completeness,
		risk: scores.risk,
		score: scores.score,
		expectedTool: allowedTool(raw.expectedTool, allowedTools),
		terminal: typeof raw.terminal === "boolean" ? raw.terminal : false,
		children: [],
		visits: 0,
		totalValue: 0,
	};
}

function toCandidates(nodes: Map<string, SearchNode>): AxiomReasoningCandidate[] {
	return [...nodes.values()]
		.filter((node) => node.id !== ROOT_ID)
		.map((node) => {
			const path = pathToNode(nodes, node.id).map((n) => n.id);
			return {
				id: node.id,
				parentId: node.parentId,
				depth: node.depth,
				path,
				summary: node.summary,
				pros: node.pros,
				cons: node.cons,
				feasibility: node.feasibility,
				completeness: node.completeness,
				risk: node.risk,
				score: node.score,
				visits: node.visits,
				totalValue: node.totalValue,
				meanValue: node.visits > 0 ? Number((node.totalValue / node.visits).toFixed(3)) : undefined,
				searchScore: Number.isFinite(node.lastSearchScore ?? Number.NaN)
					? Number((node.lastSearchScore ?? 0).toFixed(3))
					: undefined,
			};
		});
}

function toGraphNodes(path: SearchNode[]): AxiomGraphNode[] {
	const nodes: AxiomGraphNode[] = path.slice(0, 8).map((node, index) => ({
		id: `n${index + 1}`,
		description: node.action || node.summary,
		dependencies: index === 0 ? [] : [`n${index}`],
		depth: 1,
		atomic: Boolean(node.terminal) || index === path.length - 1,
		successCriteria: node.terminal
			? "The selected concrete move is complete and verified."
			: "The next selected search move is ready.",
		output: node.terminal ? "Completed atomic action." : "Prepared execution step.",
		expectedTool: node.expectedTool,
		status: "pending" as const,
	}));
	while (nodes.length < 3) {
		const index = nodes.length;
		const descriptions = [
			"Inspect the concrete evidence needed for the selected approach.",
			"Execute the selected approach with the available tools.",
			"Validate the result against the user's request and report any caveats.",
		];
		nodes.push({
			id: `n${index + 1}`,
			description: descriptions[index] ?? "Validate the result and prepare the final answer.",
			dependencies: index === 0 ? [] : [`n${index}`],
			depth: 1,
			atomic: true,
			successCriteria: "The action is complete and verified.",
			output: "Completed fallback action.",
			status: "pending",
		});
	}
	return nodes;
}

export class RStarPlanner {
	async plan(options: {
		text: string;
		classification: AxiomTaskClassification;
		abstraction: AxiomAbstraction;
		availableTools: string[];
		llm: LLMOptions;
	}): Promise<AxiomReasoningGraph | null> {
		const startedAt = Date.now();
		const { llm } = options;
		const allowedTools = new Set(options.availableTools);
		const rollouts = Math.max(1, Math.min(12, Math.round(llm.rollouts)));
		const maxDepth = Math.max(1, Math.min(5, Math.round(llm.maxDepth)));
		const exploration = Number.isFinite(llm.exploration) ? llm.exploration : 1.4;

		try {
			const rootResult = await withTimeout(
				completeSimple(
					llm.model,
					{
						systemPrompt: buildRootPrompt(Math.max(2, llm.candidateCount), options.availableTools),
						messages: [
							{
								role: "user",
								content: JSON.stringify({
									task: options.text,
									domain: options.abstraction.domain,
									problemClass: options.abstraction.problemClass,
									keywords: options.abstraction.keywords,
									taskKind: options.classification.kind,
									complexity: options.classification.complexity,
								}),
								timestamp: Date.now(),
							},
						],
					},
					{ reasoning: "minimal", apiKey: llm.apiKey, headers: llm.headers },
				),
				llm.timeoutMs,
			);
			if (!rootResult) return null;
			const rootBranches = parseBranches(textFromResult(rootResult), "branches").slice(0, llm.candidateCount);
			if (rootBranches.length === 0) return null;

			const nodes = new Map<string, SearchNode>();
			nodes.set(ROOT_ID, {
				id: ROOT_ID,
				depth: 0,
				summary: "root",
				action: "root",
				score: 0,
				children: [],
				visits: 0,
				totalValue: 0,
			});

			let nextId = 1;
			for (const branch of rootBranches) {
				const id = `r${nextId++}`;
				const node = makeNode(id, branch, ROOT_ID, 1, allowedTools);
				nodes.set(id, node);
				nodes.get(ROOT_ID)?.children.push(id);
			}

			for (let rollout = 0; rollout < rollouts; rollout++) {
				const leaf = selectLeaf(nodes, maxDepth, exploration);
				if (leaf.depth >= maxDepth || leaf.terminal) {
					backprop(nodes, leaf, leaf.score);
					continue;
				}

				const path = pathToNode(nodes, leaf.id).map((n) => ({
					id: n.id,
					summary: n.summary,
					action: n.action,
					score: n.score,
				}));
				const expandResult = await withTimeout(
					completeSimple(
						llm.model,
						{
							systemPrompt: buildExpandPrompt(options.availableTools),
							messages: [
								{
									role: "user",
									content: JSON.stringify({
										task: options.text,
										currentNode: {
											id: leaf.id,
											summary: leaf.summary,
											action: leaf.action,
											depth: leaf.depth,
											score: leaf.score,
										},
										path,
										maxDepth,
									}),
									timestamp: Date.now(),
								},
							],
						},
						{ reasoning: "minimal", apiKey: llm.apiKey, headers: llm.headers },
					),
					llm.timeoutMs,
				);
				const children = expandResult ? parseBranches(textFromResult(expandResult), "children") : [];
				if (children.length === 0) {
					backprop(nodes, leaf, leaf.score);
					continue;
				}

				const added: SearchNode[] = [];
				for (const child of children.slice(0, 3)) {
					const id = `r${nextId++}`;
					const childNode = makeNode(id, child, leaf.id, leaf.depth + 1, allowedTools);
					nodes.set(id, childNode);
					leaf.children.push(id);
					added.push(childNode);
				}
				const bestChild = added.sort((a, b) => b.score - a.score)[0] ?? leaf;
				backprop(nodes, bestChild, bestChild.score);
			}

			const chosen = chooseBest(nodes);
			if (!chosen) return null;
			const chosenPath = pathToNode(nodes, chosen.id);
			const candidates = toCandidates(nodes);
			return {
				source: "rstar",
				candidates,
				chosenId: chosen.id,
				chosenReason: `rStar-lite selected the highest-value branch after ${rollouts} rollout(s); mean value ${
					chosen.visits > 0 ? Number((chosen.totalValue / chosen.visits).toFixed(3)) : chosen.score
				}.`,
				chosenOverridden: false,
				search: {
					algorithm: "rstar-lite",
					rollouts,
					maxDepth,
					exploration,
					expandedNodes: candidates.length,
				},
				nodes: toGraphNodes(chosenPath),
				latencyMs: Date.now() - startedAt,
			};
		} catch {
			return null;
		}
	}
}
