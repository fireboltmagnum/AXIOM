import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseEnvLine(line: string): [string, string] | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;

	const eq = trimmed.indexOf("=");
	if (eq <= 0) return undefined;

	const key = trimmed.slice(0, eq).trim();
	let value = trimmed.slice(eq + 1).trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}

	return [key, value.replace(/\\n/g, "\n")];
}

function findEnvFrom(start: string): string | undefined {
	let dir = resolve(start);
	while (true) {
		const candidate = join(dir, ".env");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function packageRootEnv(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = resolve(here, "..", "..", "..", "..");
	const candidate = join(root, ".env");
	return existsSync(candidate) ? candidate : undefined;
}

function loadEnvFile(path: string): void {
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
		const parsed = parseEnvLine(line);
		if (!parsed) continue;
		const [key, value] = parsed;
		process.env[key] ??= value;
	}
}

export function loadAxiomEnv(): void {
	const files = [packageRootEnv(), findEnvFrom(process.cwd())].filter(
		(path, index, arr): path is string => !!path && arr.indexOf(path) === index,
	);
	for (const file of files) {
		loadEnvFile(file);
	}
}
