import { describe, expect, it } from "vitest";
import { formatBackgroundGoalBlock, normalizeGoalInput } from "../src/core/background-goal.ts";

describe("background-goal", () => {
	describe("formatBackgroundGoalBlock", () => {
		it("wraps the goal in a tagged block with persistence instructions", () => {
			const block = formatBackgroundGoalBlock("Ship the auth refactor");
			expect(block).toContain("<background_goal>");
			expect(block).toContain("</background_goal>");
			expect(block).toContain("Ship the auth refactor");
			expect(block.toLowerCase()).toContain("every turn");
		});

		it("returns empty string for undefined or blank goals", () => {
			expect(formatBackgroundGoalBlock(undefined)).toBe("");
			expect(formatBackgroundGoalBlock("   ")).toBe("");
		});

		it("trims surrounding whitespace from the goal", () => {
			const block = formatBackgroundGoalBlock("  do the thing  ");
			expect(block).toContain("\ndo the thing\n");
		});
	});

	describe("normalizeGoalInput", () => {
		it("returns the trimmed goal for real input", () => {
			expect(normalizeGoalInput("  finish the migration ")).toBe("finish the migration");
		});

		it("treats clear/none/off/reset (any case) as a clear", () => {
			expect(normalizeGoalInput("clear")).toBeUndefined();
			expect(normalizeGoalInput("NONE")).toBeUndefined();
			expect(normalizeGoalInput("Off")).toBeUndefined();
			expect(normalizeGoalInput("reset")).toBeUndefined();
		});

		it("treats empty input as undefined", () => {
			expect(normalizeGoalInput("")).toBeUndefined();
			expect(normalizeGoalInput(undefined)).toBeUndefined();
		});
	});
});
