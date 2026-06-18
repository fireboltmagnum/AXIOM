import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "../..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const outputDir = join(desktopDir, "src-tauri", "resources", "agent");

function run(command, args, cwd = repoRoot) {
	// shell:true is required on Windows: tsgo/bun/npm resolve to .cmd shims, and
	// spawnSync cannot execute a .cmd directly without a shell (it needs cmd.exe).
	// Our command paths contain no spaces, so shell quoting is not a concern.
	const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
}

function bunPackageName() {
	const suffix = platform === "win32" ? "windows" : platform;
	if (!["darwin", "linux", "windows"].includes(suffix) || !["arm64", "x64"].includes(arch)) {
		throw new Error(`Unsupported desktop build platform: ${platform} ${arch}`);
	}
	return `@oven/bun-${suffix}-${arch === "x64" ? "x64" : "aarch64"}`;
}

function findBun() {
	const executable = platform === "win32" ? "bun.exe" : "bun";
	const candidates = [
		join(repoRoot, "node_modules", ...bunPackageName().split("/"), "bin", executable),
		join(repoRoot, "node_modules", "bun", "bin", platform === "win32" ? "bun.exe" : "bun.exe"),
		join(repoRoot, "node_modules", ".bin", platform === "win32" ? "bun.cmd" : "bun"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`Bundled Bun compiler is missing. Checked: ${candidates.join(", ")}. Run npm install.`);
}

const tsgo = join(repoRoot, "node_modules", ".bin", platform === "win32" ? "tsgo.cmd" : "tsgo");
for (const packageName of ["tui", "ai", "agent"]) {
	run(tsgo, ["-p", join(repoRoot, "packages", packageName, "tsconfig.build.json")]);
}
run("npm", ["run", "build"], codingAgentDir);

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

const executableName = platform === "win32" ? "axiom-agent.exe" : "axiom-agent";
run(
	findBun(),
	[
		"build",
		"--compile",
		join(codingAgentDir, "dist", "bun", "cli.js"),
		"--outfile",
		join(outputDir, executableName),
	],
	codingAgentDir,
);

const distDir = join(codingAgentDir, "dist");
cpSync(join(codingAgentDir, "package.json"), join(outputDir, "package.json"));
cpSync(join(codingAgentDir, "README.md"), join(outputDir, "README.md"));
cpSync(join(codingAgentDir, "CHANGELOG.md"), join(outputDir, "CHANGELOG.md"));
cpSync(join(codingAgentDir, "docs"), join(outputDir, "docs"), { recursive: true });
cpSync(join(codingAgentDir, "examples"), join(outputDir, "examples"), { recursive: true });
cpSync(join(distDir, "modes", "interactive", "theme"), join(outputDir, "theme"), { recursive: true });
cpSync(join(distDir, "modes", "interactive", "assets"), join(outputDir, "assets"), { recursive: true });
cpSync(join(distDir, "core", "export-html"), join(outputDir, "export-html"), { recursive: true });
cpSync(
	join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
	join(outputDir, "photon_rs_bg.wasm"),
);

console.log(`Prepared self-contained AXIOM agent runtime at ${outputDir}`);
