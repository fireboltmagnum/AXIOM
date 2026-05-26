/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

function buildToolPromptSections(options: {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
}): { tools: string[]; toolsList: string; guidelines: string } {
	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = options.selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!options.toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n")
			: "(none)";

	// Build guidelines based on which tools are actually available.
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasRg = tools.includes("rg");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	// File exploration guidelines.
	if (hasBash && !hasRg && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasRg || hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer rg/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of options.promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these.
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	return {
		tools,
		toolsList,
		guidelines: guidelinesList.map((g) => `- ${g}`).join("\n"),
	};
}

function buildAxiomToolWorkflow(tools: string[]): string {
	const active = new Set(tools);
	const lines: string[] = [];

	if (active.has("todo_list")) {
		lines.push(
			"Use todo_list at the start of work with 3+ steps; update set_current/check/fail/skip as each step changes.",
		);
	}
	if (active.has("rg")) {
		lines.push(
			"Use rg for exact text or regex search; prefer rg over bash grep because it is faster and respects .gitignore.",
		);
	} else if (active.has("grep")) {
		lines.push("Use grep for exact text or regex search before broad shell exploration.");
	}
	if (active.has("understand_code")) {
		lines.push(
			"Use understand_code for unfamiliar files or folders before broad edits; still read exact source before editing.",
		);
	}
	if (active.has("code_graph")) {
		lines.push(
			"Use code_graph for cross-file relationships: action=index first, then search/neighbors/path for symbols, imports, exports, and ownership.",
		);
	}
	if (active.has("flow_graph")) {
		lines.push(
			"Use flow_graph when behavior matters: analyze/path/data/effects/explain for static flow, debug/trace for command failures and stack traces.",
		);
	}
	if (active.has("knowledge_graph")) {
		lines.push(
			"Use knowledge_graph remember only for durable non-secret user-stated facts; use search/neighbors/path for prior non-code memory.",
		);
	}
	if (active.has("sparse_tree_grep")) {
		lines.push(
			"Use sparse_tree_grep for long non-code documents: index/search lightweight summaries, expand tree nodes, then extract exact chunks.",
		);
	}
	if (active.has("playwright_cli")) {
		lines.push(
			"Use playwright_cli for browser tests, screenshots, traces, and UI verification when browser behavior matters.",
		);
	}

	return lines.length > 0 ? `\n\nAXIOM tool workflow:\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const toolPrompt = buildToolPromptSections({ selectedTools, toolSnippets, promptGuidelines });

	if (customPrompt) {
		let prompt = customPrompt;

		prompt += `\n\nAvailable tools:\n${toolPrompt.toolsList}`;
		prompt +=
			"\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
		prompt += `\n\nGuidelines:\n${toolPrompt.guidelines}`;
		prompt += buildAxiomToolWorkflow(toolPrompt.tools);

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = toolPrompt.tools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	let prompt = `You are an expert coding assistant operating inside AXIOM, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolPrompt.toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${toolPrompt.guidelines}${buildAxiomToolWorkflow(toolPrompt.tools)}

AXIOM documentation (read only when the user asks about AXIOM itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading AXIOM docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), AXIOM packages (docs/packages.md)
- When working on AXIOM topics, read the docs and examples, and follow .md cross-references before implementing
- Always read AXIOM .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (toolPrompt.tools.includes("read") && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
