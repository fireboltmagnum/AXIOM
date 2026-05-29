import type {
	AxiomGraphExecutionSnapshot,
	AxiomGraphExecutionUpdate,
	AxiomGraphNode,
	AxiomGraphNodeStatus,
	AxiomReasoningGraph,
} from "./RuntimeTypes.ts";

function cloneGraph(graph: AxiomReasoningGraph): AxiomReasoningGraph {
	return {
		...graph,
		candidates: graph.candidates.map((candidate) => ({ ...candidate })),
		nodes: graph.nodes.map((node) => ({ ...node, dependencies: [...node.dependencies] })),
	};
}

function isTerminal(status: AxiomGraphNodeStatus): boolean {
	return status === "complete" || status === "failed" || status === "skipped";
}

function capError(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 600 ? normalized : `${normalized.slice(0, 599)}…`;
}

export class GraphExecutionTracker {
	private readonly graph: AxiomReasoningGraph;
	private readonly toolCallToNode = new Map<string, string>();

	constructor(graph: AxiomReasoningGraph) {
		this.graph = cloneGraph(graph);
	}

	onToolStart(toolCallId: string, toolName: string): AxiomGraphExecutionUpdate | undefined {
		const node = this.assignNode(toolCallId, toolName);
		if (!node) {
			return undefined;
		}
		return this.updateNode(node, "in_progress", {
			toolCallId,
			toolName,
			reason: `Tool ${toolName} started.`,
		});
	}

	onToolEnd(
		toolCallId: string,
		toolName: string,
		isError: boolean,
		errorText?: string,
	): { update: AxiomGraphExecutionUpdate; snapshot: AxiomGraphExecutionSnapshot; note: string } | undefined {
		const node = this.nodeForToolCall(toolCallId) ?? this.assignNode(toolCallId, toolName);
		if (!node) {
			return undefined;
		}

		const update = this.updateNode(node, isError ? "failed" : "complete", {
			toolCallId,
			toolName,
			reason: isError ? `Tool ${toolName} failed.` : `Tool ${toolName} completed.`,
			error: capError(errorText),
		});
		const snapshot = this.snapshot();
		return {
			update,
			snapshot,
			note: this.buildContextNote(update, snapshot),
		};
	}

	/**
	 * Look up a node by id. Used by the agent session to fetch the node for
	 * verifyClaim execution between onToolEnd and the model's next turn.
	 */
	getNodeById(nodeId: string): AxiomGraphNode | undefined {
		return this.graph.nodes.find((node) => node.id === nodeId);
	}

	/**
	 * Apply a verifyClaim result to a node that just transitioned to
	 * `complete`. On a passing verification we just stash the exit code so
	 * the trace can show "yes, this was actually done." On a failing
	 * verification we flip the node back to `failed` so dependent subgoals
	 * don't proceed on a phantom success.
	 *
	 * Returns the updated node, or undefined if no node exists or the node
	 * wasn't in a state we should be acting on.
	 */
	applyVerification(
		nodeId: string,
		result: { passed: boolean; exitCode: number; stderrTail?: string },
	): AxiomGraphNode | undefined {
		const node = this.getNodeById(nodeId);
		if (!node) return undefined;
		node.verifyExitCode = result.exitCode;
		node.verifyPassed = result.passed;
		if (!result.passed && node.status === "complete") {
			node.status = "failed";
			node.error = capError(
				`verifyClaim failed (exit ${result.exitCode})${result.stderrTail ? `: ${result.stderrTail}` : ""}`,
			);
			node.completedAt = new Date().toISOString();
		}
		return node;
	}

	snapshot(): AxiomGraphExecutionSnapshot {
		const pending: string[] = [];
		const inProgress: string[] = [];
		const complete: string[] = [];
		const failed: string[] = [];
		const skipped: string[] = [];

		for (const node of this.graph.nodes) {
			switch (node.status) {
				case "pending":
					pending.push(node.id);
					break;
				case "in_progress":
					inProgress.push(node.id);
					break;
				case "complete":
					complete.push(node.id);
					break;
				case "failed":
					failed.push(node.id);
					break;
				case "skipped":
					skipped.push(node.id);
					break;
			}
		}

		return {
			total: this.graph.nodes.length,
			pending,
			inProgress,
			complete,
			failed,
			skipped,
			nextReady: this.readyPendingNodes().map((node) => node.id),
			completionRatio: this.graph.nodes.length === 0 ? 1 : complete.length / this.graph.nodes.length,
		};
	}

	private assignNode(toolCallId: string, toolName: string): AxiomGraphNode | undefined {
		const existing = this.nodeForToolCall(toolCallId);
		if (existing) {
			return existing;
		}

		const ready = this.readyPendingNodes();
		const matchingReady = ready.find((node) => node.expectedTool === toolName);
		const matchingPending = this.graph.nodes.find(
			(node) => node.status === "pending" && node.expectedTool === toolName,
		);
		const anyReady = ready[0];
		const anyPending = this.graph.nodes.find((node) => node.status === "pending");
		const node = matchingReady ?? matchingPending ?? anyReady ?? anyPending;
		if (!node) {
			return undefined;
		}

		this.toolCallToNode.set(toolCallId, node.id);
		node.toolCallId = toolCallId;
		node.actualTool = toolName;
		return node;
	}

	private nodeForToolCall(toolCallId: string): AxiomGraphNode | undefined {
		const nodeId = this.toolCallToNode.get(toolCallId);
		return nodeId ? this.graph.nodes.find((node) => node.id === nodeId) : undefined;
	}

	private readyPendingNodes(): AxiomGraphNode[] {
		const complete = new Set(this.graph.nodes.filter((node) => node.status === "complete").map((node) => node.id));
		return this.graph.nodes.filter(
			(node) => node.status === "pending" && node.dependencies.every((dependency) => complete.has(dependency)),
		);
	}

	private updateNode(
		node: AxiomGraphNode,
		status: AxiomGraphNodeStatus,
		options: { toolCallId?: string; toolName?: string; reason: string; error?: string },
	): AxiomGraphExecutionUpdate {
		const previousStatus = node.status;
		const timestamp = new Date().toISOString();
		node.status = status;
		if (options.toolCallId) node.toolCallId = options.toolCallId;
		if (options.toolName) node.actualTool = options.toolName;
		if (status === "in_progress" && !node.startedAt) node.startedAt = timestamp;
		if (isTerminal(status)) node.completedAt = timestamp;
		if (options.error) node.error = options.error;

		return {
			nodeId: node.id,
			previousStatus,
			status,
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			reason: options.reason,
			timestamp,
		};
	}

	private buildContextNote(update: AxiomGraphExecutionUpdate, snapshot: AxiomGraphExecutionSnapshot): string {
		const node = this.graph.nodes.find((candidate) => candidate.id === update.nodeId);
		const lines: string[] = [
			"<axiom_graph_execution>",
			`Node ${update.nodeId} is now ${update.status}${update.toolName ? ` after ${update.toolName}` : ""}.`,
		];
		if (node) {
			lines.push(`Subgoal: ${node.description}`);
		}
		if (snapshot.complete.length > 0) lines.push(`Completed: ${snapshot.complete.join(", ")}`);
		if (snapshot.failed.length > 0) lines.push(`Failed: ${snapshot.failed.join(", ")}`);
		if (snapshot.nextReady.length > 0) {
			lines.push(`Next ready subgoal(s): ${snapshot.nextReady.join(", ")}`);
		} else if (snapshot.pending.length > 0) {
			lines.push(`Pending but waiting on dependencies: ${snapshot.pending.join(", ")}`);
		}
		lines.push(
			"Use this graph status to choose the next subgoal. If a node failed, adapt the plan before continuing. Do not mention this internal status unless it matters to the user.",
		);
		lines.push("</axiom_graph_execution>");
		return lines.join("\n");
	}
}
