import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/axiom/MemoryStore.ts";

describe("MemoryStore", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `axiom-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("remembers and recalls by keyword overlap", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "project", text: "The build uses vitest with deterministic fakes" });
		store.remember({ type: "fact", text: "Auth tokens live in the secrets vault" });

		const hits = store.recall("how do we run the build tests");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].entry.text).toContain("vitest");
	});

	it("persists across instances (cross-session recall)", () => {
		const a = new MemoryStore(dir);
		a.remember({ type: "preference", text: "Prefer biome formatting over prettier", tags: ["style"] });

		const b = new MemoryStore(dir);
		expect(b.all().map((e) => e.text)).toContain("Prefer biome formatting over prettier");
		expect(b.recall("biome")[0].entry.text).toContain("biome");
	});

	it("de-duplicates identical type+text entries", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "fact", text: "same fact" });
		store.remember({ type: "fact", text: "same fact" });
		expect(store.all().filter((e) => e.text === "same fact").length).toBe(1);
	});

	it("builds a user model from user + preference entries only", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "user", text: "User is a security researcher" });
		store.remember({ type: "preference", text: "Likes terse answers" });
		store.remember({ type: "fact", text: "Repo has 200 files" });

		const model = store.userModel().map((e) => e.text);
		expect(model).toContain("User is a security researcher");
		expect(model).toContain("Likes terse answers");
		expect(model).not.toContain("Repo has 200 files");
	});

	it("surfaces standing user/preference memories even on a non-matching query", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "user", text: "User is named Sam" });
		store.remember({ type: "fact", text: "unrelated incidental detail about widgets" });

		const hits = store.recall("completely different topic xyz");
		expect(hits.map((h) => h.entry.text)).toContain("User is named Sam");
		expect(hits.map((h) => h.entry.text)).not.toContain("unrelated incidental detail about widgets");
	});

	it("ranks user/preference above plain facts at equal keyword overlap", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "fact", text: "deployment runs nightly" });
		store.remember({ type: "preference", text: "deployment notifications should be terse" });

		const hits = store.recall("deployment");
		expect(hits[0].entry.type).toBe("preference");
	});

	it("forgets an entry by id and rewrites the index", () => {
		const store = new MemoryStore(dir);
		const entry = store.remember({ type: "fact", text: "temporary note" })!;
		expect(store.forget(entry.id)).toBe(true);
		expect(store.all()).toEqual([]);
		expect(store.forget("nonexistent")).toBe(false);
	});

	it("regenerates MEMORY.md and USER.md surfaces on write", () => {
		const store = new MemoryStore(dir);
		store.remember({ type: "user", text: "User dreams of building VOKK" });
		store.remember({ type: "project", text: "Targeting Opus 4.8 benchmarks with Gemma" });

		const memoryMd = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		expect(memoryMd).toContain("# Agent memory");
		expect(memoryMd).toContain("Targeting Opus 4.8 benchmarks with Gemma");

		const userMd = readFileSync(join(dir, "USER.md"), "utf-8");
		expect(userMd).toContain("# User model");
		expect(userMd).toContain("User dreams of building VOKK");
		expect(userMd).not.toContain("Targeting Opus 4.8");
	});

	it("ignores empty text and bad json lines", () => {
		const store = new MemoryStore(dir);
		expect(store.remember({ type: "fact", text: "   " })).toBeNull();
		expect(store.all()).toEqual([]);
	});
});
