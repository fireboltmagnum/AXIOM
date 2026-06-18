import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@axiom/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@axiom/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("background goal injection", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedSystemPrompts: string[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		capturedSystemPrompts = [];

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Base system prompt.", tools: [] },
			streamFn: (_model, context) => {
				capturedSystemPrompts.push(context.systemPrompt ?? "");
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = assistantMessage("ok");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores and reports the goal via get/set", () => {
		expect(session.getBackgroundGoal()).toBeUndefined();
		session.setBackgroundGoal("  Ship the release  ");
		expect(session.getBackgroundGoal()).toBe("Ship the release");
		session.setBackgroundGoal(undefined);
		expect(session.getBackgroundGoal()).toBeUndefined();
	});

	it("injects the goal block into the system prompt the model sees", async () => {
		session.setBackgroundGoal("Reach 90% test coverage");
		await session.prompt("please refactor the parser module now");

		expect(capturedSystemPrompts.length).toBeGreaterThan(0);
		const seen = capturedSystemPrompts.at(-1)!;
		expect(seen).toContain("<background_goal>");
		expect(seen).toContain("Reach 90% test coverage");
	});

	it("omits the goal block when no goal is set", async () => {
		await session.prompt("please refactor the parser module now");
		const seen = capturedSystemPrompts.at(-1)!;
		expect(seen).not.toContain("<background_goal>");
	});

	it("stops injecting after the goal is cleared", async () => {
		session.setBackgroundGoal("temporary goal");
		await session.prompt("please update the first module");
		expect(capturedSystemPrompts.at(-1)!).toContain("temporary goal");

		session.setBackgroundGoal(undefined);
		await session.prompt("please update the second module");
		expect(capturedSystemPrompts.at(-1)!).not.toContain("background_goal");
	});
});
