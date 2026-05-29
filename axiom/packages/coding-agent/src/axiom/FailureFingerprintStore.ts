import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RepairIssue, RepairVerifier } from "./RepairLoop.ts";

export interface FailureFingerprintEntry {
	id: string;
	signatures: string[];
	normalizedKey: string;
	verifierKind: RepairVerifier["kind"];
	verifierCommand: string;
	issueKinds: RepairIssue["kind"][];
	files: string[];
	owners: string[];
	messages: string[];
	firstSeenAt: string;
	lastSeenAt: string;
	occurrences: number;
	resolvedCount: number;
	lastResolvedAt?: string;
	repairHints: string[];
}

export interface FailureFingerprintHit {
	entry: FailureFingerprintEntry;
	score: number;
	matched: string[];
}

export interface FailureFingerprintFailureInput {
	signature: string;
	verifier: RepairVerifier;
	issues: readonly RepairIssue[];
	changedFiles: readonly string[];
	output?: string;
}

export interface FailureFingerprintResolutionInput {
	signature: string;
	changedFiles: readonly string[];
	note?: string;
}

interface FailureFingerprintSnapshot {
	version: 1;
	updatedAt: string;
	entries: FailureFingerprintEntry[];
}

/**
 * Persistent verifier-failure memory.
 *
 * RepairLoop already knows how to parse the current failure. This store adds
 * cross-session memory: normalize the failure shape, remember repeated
 * fingerprints, mark fingerprints as resolved when a later verifier passes,
 * and feed high-confidence prior repair hints back into future packets.
 */
export class FailureFingerprintStore {
	private readonly baseDir: string;
	private readonly storePath: string;
	private readonly reportPath: string;
	private cached: FailureFingerprintSnapshot | undefined;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".axiom", "agent", "failure-fingerprints");
		this.storePath = join(this.baseDir, "fingerprints.json");
		this.reportPath = join(this.baseDir, "FAILURE_FINGERPRINTS.md");
	}

	recordFailure(input: FailureFingerprintFailureInput): FailureFingerprintEntry | undefined {
		const snapshot = this.load();
		const normalizedKey = normalizedKeyFor(input.issues, input.output);
		const now = new Date().toISOString();
		let entry = snapshot.entries.find(
			(candidate) =>
				candidate.signatures.includes(input.signature) ||
				(candidate.normalizedKey === normalizedKey && candidate.verifierKind === input.verifier.kind),
		);
		const summary = summarizeFailure(input);
		if (!entry) {
			entry = {
				id: `ff_${hash(`${input.verifier.kind}:${normalizedKey}`, 16)}`,
				signatures: [input.signature],
				normalizedKey,
				verifierKind: input.verifier.kind,
				verifierCommand: input.verifier.command,
				issueKinds: unique(input.issues.map((issue) => issue.kind)),
				files: unique(input.issues.flatMap((issue) => (issue.file ? [issue.file] : []))),
				owners: unique(input.issues.flatMap((issue) => (issue.owner ? [issue.owner] : []))),
				messages: unique(input.issues.map((issue) => issue.message)).slice(0, 8),
				firstSeenAt: now,
				lastSeenAt: now,
				occurrences: 1,
				resolvedCount: 0,
				repairHints: [summary],
			};
			snapshot.entries.push(entry);
		} else {
			if (!entry.signatures.includes(input.signature)) entry.signatures.push(input.signature);
			entry.verifierCommand = input.verifier.command;
			entry.issueKinds = unique([...entry.issueKinds, ...input.issues.map((issue) => issue.kind)]);
			entry.files = unique([
				...entry.files,
				...input.issues.flatMap((issue) => (issue.file ? [issue.file] : [])),
			]).slice(0, 24);
			entry.owners = unique([
				...entry.owners,
				...input.issues.flatMap((issue) => (issue.owner ? [issue.owner] : [])),
			]).slice(0, 24);
			entry.messages = unique([...input.issues.map((issue) => issue.message), ...entry.messages]).slice(0, 8);
			entry.lastSeenAt = now;
			entry.occurrences++;
			entry.repairHints = unique([summary, ...entry.repairHints]).slice(0, 8);
		}
		snapshot.updatedAt = now;
		this.flush(snapshot);
		return entry;
	}

	recordResolution(input: FailureFingerprintResolutionInput): FailureFingerprintEntry | undefined {
		const snapshot = this.load();
		const entry = snapshot.entries.find((candidate) => candidate.signatures.includes(input.signature));
		if (!entry) return undefined;
		const now = new Date().toISOString();
		entry.resolvedCount++;
		entry.lastResolvedAt = now;
		const changed = input.changedFiles.map((file) => basename(file)).filter(Boolean);
		const note =
			input.note ??
			`A later verifier pass resolved this fingerprint after edits touching: ${changed.length > 0 ? changed.join(", ") : "unknown files"}. Reuse the localized fix pattern; avoid broad rewrites.`;
		entry.repairHints = unique([note, ...entry.repairHints]).slice(0, 8);
		snapshot.updatedAt = now;
		this.flush(snapshot);
		return entry;
	}

	recall(input: FailureFingerprintFailureInput, limit = 3): FailureFingerprintHit[] {
		const snapshot = this.load();
		if (snapshot.entries.length === 0) return [];
		const normalizedKey = normalizedKeyFor(input.issues, input.output);
		const queryTokens = new Set(tokensForFailure(input.issues, input.output));
		const hits: FailureFingerprintHit[] = [];
		for (const entry of snapshot.entries) {
			const matched = new Set<string>();
			let score = 0;
			if (entry.signatures.includes(input.signature)) {
				score += 12;
				matched.add("exact-signature");
			}
			if (entry.normalizedKey === normalizedKey) {
				score += 9;
				matched.add("normalized-fingerprint");
			}
			if (entry.verifierKind === input.verifier.kind) {
				score += 2;
				matched.add(`verifier:${entry.verifierKind}`);
			}
			for (const token of entryTokens(entry)) {
				if (!queryTokens.has(token)) continue;
				score += 1;
				if (matched.size < 8) matched.add(token);
			}
			if (entry.resolvedCount > 0) score += Math.min(5, entry.resolvedCount * 2);
			if (entry.occurrences > 1) score += Math.min(4, Math.log2(entry.occurrences + 1));
			if (score < 4) continue;
			hits.push({ entry, score, matched: [...matched] });
		}
		return hits
			.sort((a, b) => b.score - a.score || b.entry.lastSeenAt.localeCompare(a.entry.lastSeenAt))
			.slice(0, limit);
	}

	all(): FailureFingerprintEntry[] {
		return [...this.load().entries];
	}

	private load(): FailureFingerprintSnapshot {
		if (this.cached) return this.cached;
		if (!existsSync(this.storePath)) {
			this.cached = { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
			return this.cached;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.storePath, "utf-8")) as FailureFingerprintSnapshot;
			this.cached = {
				version: 1,
				updatedAt: parsed.updatedAt ?? new Date().toISOString(),
				entries: Array.isArray(parsed.entries) ? parsed.entries : [],
			};
		} catch {
			this.cached = { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
		}
		return this.cached;
	}

	private flush(snapshot: FailureFingerprintSnapshot): void {
		try {
			if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
			writeFileSync(this.storePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
			writeFileSync(this.reportPath, renderReport(snapshot.entries), "utf-8");
			this.cached = snapshot;
		} catch {
			// Failure memory is best-effort; verifier repair must never fail
			// because its cache could not be written.
		}
	}
}

function summarizeFailure(input: FailureFingerprintFailureInput): string {
	const first = input.issues[0];
	if (!first) {
		return `Verifier ${input.verifier.command} failed with no parsed issue. Inspect stdout/stderr tails and rerun the cheapest targeted check.`;
	}
	const location = [first.file, first.line, first.column].filter((part) => part !== undefined).join(":");
	const owner = first.owner ? ` in ${first.owner}` : "";
	return `${first.kind} failure at ${location || "unknown location"}${owner}: ${first.message}`;
}

function normalizedKeyFor(issues: readonly RepairIssue[], output?: string): string {
	const parts =
		issues.length > 0
			? issues
					.slice(0, 5)
					.map((issue) => [issue.kind, codeFor(issue.message), normalizeMessage(issue.message)].join(":"))
			: [`output:${normalizeMessage(output ?? "")}`];
	return hash(parts.join("|"), 24);
}

function tokensForFailure(issues: readonly RepairIssue[], output?: string): string[] {
	const text =
		issues.length > 0
			? issues.flatMap((issue) => [issue.kind, issue.file ?? "", issue.owner ?? "", issue.message]).join(" ")
			: (output ?? "");
	return tokenize(text);
}

function entryTokens(entry: FailureFingerprintEntry): string[] {
	return tokenize(
		[
			entry.verifierKind,
			entry.verifierCommand,
			entry.issueKinds.join(" "),
			entry.files.join(" "),
			entry.owners.join(" "),
			entry.messages.join(" "),
			entry.repairHints.join(" "),
		].join(" "),
	);
}

function codeFor(message: string): string {
	return /\b(?:TS|E|ERR|F)\d{3,6}\b/i.exec(message)?.[0].toUpperCase() ?? "no-code";
}

function normalizeMessage(message: string): string {
	return message
		.toLowerCase()
		.replace(/\b(?:\/?[\w.-]+\/)+[\w.-]+\b/g, "<path>")
		.replace(/(["'`])(?:\\.|(?!\1).){1,120}\1/g, "<quoted>")
		.replace(/\b\d+\b/g, "<num>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1 && token !== "error" && token !== "warning");
}

function unique<T>(items: readonly T[]): T[] {
	return [...new Set(items)];
}

function renderReport(entries: readonly FailureFingerprintEntry[]): string {
	const out = ["# Failure Fingerprints", ""];
	out.push(`Entries: ${entries.length}`);
	out.push("");
	for (const entry of [...entries].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 200)) {
		out.push(`- ${entry.id} (${entry.verifierKind})`);
		out.push(`  - occurrences: ${entry.occurrences}, resolved: ${entry.resolvedCount}`);
		out.push(`  - files: ${entry.files.slice(0, 5).join(", ") || "unknown"}`);
		out.push(`  - latest: ${entry.messages[0] ?? "unknown failure"}`);
		if (entry.repairHints[0]) out.push(`  - hint: ${entry.repairHints[0]}`);
	}
	return `${out.join("\n")}\n`;
}

function hash(text: string, length: number): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}
