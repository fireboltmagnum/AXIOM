import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPlaywrightCommand,
	detectPlaywrightProject,
	parsePlaywrightFailures,
} from "../src/core/tools/playwright-cli.ts";

describe("playwright_cli tool helpers", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `axiom-playwright-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("detects Playwright config, dependency, local CLI, and specs", () => {
		mkdirSync(join(testDir, "node_modules", ".bin"), { recursive: true });
		mkdirSync(join(testDir, "tests"), { recursive: true });
		writeFileSync(join(testDir, "node_modules", ".bin", "playwright"), "#!/bin/sh\n");
		writeFileSync(join(testDir, "playwright.config.ts"), "export default {};\n");
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }),
		);
		writeFileSync(join(testDir, "tests", "login.spec.ts"), "import { test } from '@playwright/test';\n");

		const status = detectPlaywrightProject(testDir);

		expect(status.hasPlaywright).toBe(true);
		expect(status.hasConfig).toBe(true);
		expect(status.hasLocalCli).toBe(true);
		expect(status.specFiles).toContain("tests/login.spec.ts");
	});

	it("builds targeted test commands", () => {
		const command = buildPlaywrightCommand(
			{
				action: "test",
				file: "tests/login.spec.ts",
				line: 42,
				project: "chromium",
				grep: "login",
				trace: "retain-on-failure",
			},
			testDir,
			{
				hasPlaywright: true,
				hasConfig: true,
				hasLocalCli: false,
				configFiles: [],
				specFiles: [],
				packageManagerHint: "npm",
			},
		);

		expect(command.command).toBe("npx");
		expect(command.args).toEqual([
			"--no-install",
			"playwright",
			"test",
			"tests/login.spec.ts:42",
			"--grep",
			"login",
			"--project=chromium",
			"--trace=retain-on-failure",
			"--reporter=line",
		]);
	});

	it("blocks external screenshot URLs by default", () => {
		expect(() =>
			buildPlaywrightCommand({ action: "screenshot", url: "https://example.com", file: "shot.png" }, testDir, {
				hasPlaywright: true,
				hasConfig: true,
				hasLocalCli: false,
				configFiles: [],
				specFiles: [],
				packageManagerHint: "npm",
			}),
		).toThrow(/External URLs/);
	});

	it("parses Playwright failures", () => {
		const failures = parsePlaywrightFailures(`
  1) [chromium] › tests/login.spec.ts:12:7 › login › redirects after submit
    Error: expect(locator).toBeVisible() failed
      at LoginPage.submit (src/LoginPage.tsx:88:12)
`);

		expect(failures).toContain("tests/login.spec.ts:12:7 login › redirects after submit");
		expect(failures).toContain("Error: expect(locator).toBeVisible() failed");
		expect(failures).toContain("src/LoginPage.tsx:88:12 stack frame");
	});
});
