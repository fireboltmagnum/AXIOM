import { describe, expect, it } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

describe("version-check semver helpers", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});
});

describe("remote release lookup", () => {
	// AXIOM does not ship a remote version-check endpoint. The three lookup
	// helpers are stubs that always resolve to undefined so the interactive
	// "Update Available" banner never fires.
	it("getLatestPiRelease returns undefined", async () => {
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});
	it("getLatestPiVersion returns undefined", async () => {
		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
	});
	it("checkForNewPiVersion returns undefined", async () => {
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});
});
