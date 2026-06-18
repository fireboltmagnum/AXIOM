export {
	type AskUserQuestionToolDetails,
	type AskUserQuestionToolInput,
	createAskUserQuestionTool,
	createAskUserQuestionToolDefinition,
} from "./ask-user-question.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type BenchmarkTestToolDetails,
	type BenchmarkTestToolInput,
	createBenchmarkTestTool,
	createBenchmarkTestToolDefinition,
} from "./benchmark-test.ts";
export {
	type CodeGraphToolDetails,
	type CodeGraphToolInput,
	createCodeGraphTool,
	createCodeGraphToolDefinition,
} from "./code-graph.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export {
	createExecuteCodeTool,
	createExecuteCodeToolDefinition,
	type ExecuteCodeToolDetails,
	type ExecuteCodeToolInput,
} from "./execute-code.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createFlowGraphTool,
	createFlowGraphToolDefinition,
	type FlowGraphToolDetails,
	type FlowGraphToolInput,
} from "./flow-graph.ts";
export {
	createGatherContextTool,
	createGatherContextToolDefinition,
	type GatherContextToolDetails,
	type GatherContextToolInput,
} from "./gather-context.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	createRgTool,
	createRgToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createKnowledgeGraphTool,
	createKnowledgeGraphToolDefinition,
	type KnowledgeGraphToolDetails,
	type KnowledgeGraphToolInput,
} from "./knowledge-graph.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createMemoryTool,
	createMemoryToolDefinition,
	type MemoryToolDetails,
	type MemoryToolInput,
} from "./memory.ts";
export {
	createPlaywrightCliTool,
	createPlaywrightCliToolDefinition,
	type PlaywrightCliToolDetails,
	type PlaywrightCliToolInput,
} from "./playwright-cli.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createSparseTreeGrepTool,
	createSparseTreeGrepToolDefinition,
	type SparseTreeGrepToolDetails,
	type SparseTreeGrepToolInput,
} from "./sparse-tree-grep.ts";
export {
	createTodoListTool,
	createTodoListToolDefinition,
	type TodoListToolDetails,
	type TodoListToolInput,
	type TodoListToolOptions,
} from "./todo-list.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createUnderstandCodeTool,
	createUnderstandCodeToolDefinition,
	type UnderstandCodeToolDetails,
	type UnderstandCodeToolInput,
} from "./understand-code.ts";
export {
	createWebResearchTool,
	createWebResearchToolDefinition,
	type WebResearchToolDetails,
	type WebResearchToolInput,
	type WebResearchToolOptions,
} from "./web-research.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@axiom/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAskUserQuestionTool, createAskUserQuestionToolDefinition } from "./ask-user-question.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createBenchmarkTestTool, createBenchmarkTestToolDefinition } from "./benchmark-test.ts";
import { createCodeGraphTool, createCodeGraphToolDefinition } from "./code-graph.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createExecuteCodeTool, createExecuteCodeToolDefinition } from "./execute-code.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createFlowGraphTool, createFlowGraphToolDefinition } from "./flow-graph.ts";
import { createGatherContextTool, createGatherContextToolDefinition } from "./gather-context.ts";
import {
	createGrepTool,
	createGrepToolDefinition,
	createRgTool,
	createRgToolDefinition,
	type GrepToolOptions,
} from "./grep.ts";
import { createKnowledgeGraphTool, createKnowledgeGraphToolDefinition } from "./knowledge-graph.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createMemoryTool, createMemoryToolDefinition } from "./memory.ts";
import { createPlaywrightCliTool, createPlaywrightCliToolDefinition } from "./playwright-cli.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createSparseTreeGrepTool, createSparseTreeGrepToolDefinition } from "./sparse-tree-grep.ts";
import { createTodoListTool, createTodoListToolDefinition } from "./todo-list.ts";
import { createUnderstandCodeTool, createUnderstandCodeToolDefinition } from "./understand-code.ts";
import { createWebResearchTool, createWebResearchToolDefinition } from "./web-research.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "ask_user_question"
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "rg"
	| "grep"
	| "find"
	| "ls"
	| "understand_code"
	| "code_graph"
	| "flow_graph"
	| "knowledge_graph"
	| "sparse_tree_grep"
	| "playwright_cli"
	| "todo_list"
	| "gather_context"
	| "benchmark_test"
	| "execute_code"
	| "memory"
	| "web_research";
export const allToolNames: Set<ToolName> = new Set([
	"ask_user_question",
	"read",
	"bash",
	"edit",
	"write",
	"rg",
	"grep",
	"find",
	"ls",
	"understand_code",
	"code_graph",
	"flow_graph",
	"knowledge_graph",
	"sparse_tree_grep",
	"playwright_cli",
	"todo_list",
	"gather_context",
	"benchmark_test",
	"execute_code",
	"memory",
	"web_research",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "ask_user_question":
			return createAskUserQuestionToolDefinition();
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "rg":
			return createRgToolDefinition(cwd, options?.grep);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "understand_code":
			return createUnderstandCodeToolDefinition(cwd);
		case "code_graph":
			return createCodeGraphToolDefinition(cwd);
		case "flow_graph":
			return createFlowGraphToolDefinition(cwd);
		case "knowledge_graph":
			return createKnowledgeGraphToolDefinition(cwd);
		case "sparse_tree_grep":
			return createSparseTreeGrepToolDefinition(cwd);
		case "playwright_cli":
			return createPlaywrightCliToolDefinition(cwd);
		case "todo_list":
			return createTodoListToolDefinition();
		case "gather_context":
			return createGatherContextToolDefinition(cwd);
		case "benchmark_test":
			return createBenchmarkTestToolDefinition();
		case "execute_code":
			return createExecuteCodeToolDefinition(cwd);
		case "memory":
			return createMemoryToolDefinition(cwd);
		case "web_research":
			return createWebResearchToolDefinition({ cwd });
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "ask_user_question":
			return createAskUserQuestionTool();
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "rg":
			return createRgTool(cwd, options?.grep);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "understand_code":
			return createUnderstandCodeTool(cwd);
		case "code_graph":
			return createCodeGraphTool(cwd);
		case "flow_graph":
			return createFlowGraphTool(cwd);
		case "knowledge_graph":
			return createKnowledgeGraphTool(cwd);
		case "sparse_tree_grep":
			return createSparseTreeGrepTool(cwd);
		case "playwright_cli":
			return createPlaywrightCliTool(cwd);
		case "todo_list":
			return createTodoListTool();
		case "gather_context":
			return createGatherContextTool(cwd);
		case "benchmark_test":
			return createBenchmarkTestTool();
		case "execute_code":
			return createExecuteCodeTool(cwd);
		case "memory":
			return createMemoryTool(cwd);
		case "web_research":
			return createWebResearchTool({ cwd });
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createRgToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ask_user_question: createAskUserQuestionToolDefinition(),
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		rg: createRgToolDefinition(cwd, options?.grep),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		understand_code: createUnderstandCodeToolDefinition(cwd),
		code_graph: createCodeGraphToolDefinition(cwd),
		flow_graph: createFlowGraphToolDefinition(cwd),
		knowledge_graph: createKnowledgeGraphToolDefinition(cwd),
		sparse_tree_grep: createSparseTreeGrepToolDefinition(cwd),
		playwright_cli: createPlaywrightCliToolDefinition(cwd),
		todo_list: createTodoListToolDefinition(),
		gather_context: createGatherContextToolDefinition(cwd),
		benchmark_test: createBenchmarkTestToolDefinition(),
		execute_code: createExecuteCodeToolDefinition(cwd),
		memory: createMemoryToolDefinition(cwd),
		web_research: createWebResearchToolDefinition({ cwd }),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createRgTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		ask_user_question: createAskUserQuestionTool(),
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		rg: createRgTool(cwd, options?.grep),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		understand_code: createUnderstandCodeTool(cwd),
		code_graph: createCodeGraphTool(cwd),
		flow_graph: createFlowGraphTool(cwd),
		knowledge_graph: createKnowledgeGraphTool(cwd),
		sparse_tree_grep: createSparseTreeGrepTool(cwd),
		playwright_cli: createPlaywrightCliTool(cwd),
		todo_list: createTodoListTool(),
		gather_context: createGatherContextTool(cwd),
		benchmark_test: createBenchmarkTestTool(),
		execute_code: createExecuteCodeTool(cwd),
		memory: createMemoryTool(cwd),
		web_research: createWebResearchTool({ cwd }),
	};
}
