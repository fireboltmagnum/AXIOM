import { spawn } from "node:child_process";
import type { AxiomGraphNode } from "./RuntimeTypes.ts";

/**
 * Subgoal verification (Process Reward, lightweight).
 *
 * Reasoning graph nodes can optionally carry a `verifyClaim` field: a bash
 * one-liner whose exit code proves whether the node's work was actually done.
 * Examples:
 *
 *     grep -q "newFunction" src/foo.ts
 *     test -f dist/index.js
 *     npm run lint --workspace packages/foo --silent
 *
 * When the GraphExecutionTracker marks a node `complete`, we run its
 * verifyClaim (if set). On exit 0 the node stays `complete`. On non-zero we
 * flip it to `failed` and surface a hint so the agent knows the claim was
 * wrong — common failure mode is "agent says it implemented X" but actually
 * wrote a placeholder.
 *
 * Defensive everywhere:
 *   - missing verifyClaim => skip silently (most nodes won't have one)
 *   - command not in safe-list => skip silently and log a warn-style note
 *   - timeout => mark `verifyPassed: false`, never hang the agent
 *   - shell escaping is intentionally NOT done; the planner authored the
 *     command, we trust it. If a malformed claim throws, we degrade to skip.
 */

export interface VerifyClaimResult {
	checked: boolean;
	passed?: boolean;
	exitCode?: number;
	stderrTail?: string;
}

const SAFE_PREFIXES = [
	"grep ",
	"rg ",
	"test ",
	"[ ",
	"ls ",
	"cat ",
	"head ",
	"tail ",
	"wc ",
	"find ",
	"npm run ",
	"npm test",
	"npx ",
	"pnpm ",
	"yarn ",
	"node ",
	"python ",
	"python3 ",
	"pytest",
	"cargo ",
	"go ",
	"jq ",
	"file ",
	"stat ",
];

/**
 * Lightweight allow-list. We do NOT execute arbitrary shell from the planner
 * — only verbs that read state or run a project verifier. Refusing rather
 * than blocking is the safe default; the agent can re-emit with a friendlier
 * claim if needed.
 */
export function isSafeVerifyClaim(claim: string): boolean {
	const trimmed = claim.trim();
	if (!trimmed) return false;
	// Refuse anything that looks like state mutation, network, or shell tricks.
	if (
		/[;&|`$<>]|>>|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bgit\s+(push|reset|checkout|commit)\b|curl|wget|ssh|scp/.test(
			trimmed,
		)
	) {
		return false;
	}
	return SAFE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export class SubgoalVerifier {
	private readonly cwd: string;
	private readonly timeoutMs: number;

	constructor(options: { cwd: string; timeoutMs?: number }) {
		this.cwd = options.cwd;
		this.timeoutMs = options.timeoutMs ?? 5000;
	}

	async verify(node: AxiomGraphNode): Promise<VerifyClaimResult> {
		const claim = node.verifyClaim?.trim();
		if (!claim) return { checked: false };
		if (!isSafeVerifyClaim(claim)) {
			return { checked: true, passed: false, exitCode: -1, stderrTail: "claim refused by safe-list" };
		}
		return await this.runShell(claim);
	}

	private runShell(command: string): Promise<VerifyClaimResult> {
		return new Promise<VerifyClaimResult>((resolve) => {
			let stderr = "";
			let settled = false;
			const child = spawn(command, {
				cwd: this.cwd,
				shell: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			const finish = (value: VerifyClaimResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					child.kill("SIGKILL");
				} catch {
					// already dead
				}
				resolve(value);
			};
			const timer = setTimeout(
				() =>
					finish({
						checked: true,
						passed: false,
						exitCode: -1,
						stderrTail: `verifyClaim exceeded ${this.timeoutMs}ms`,
					}),
				Math.max(100, this.timeoutMs),
			);
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
				// Cap memory regardless of how chatty the verifier is.
				if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
			});
			child.on("error", () => finish({ checked: true, passed: false, exitCode: -1, stderrTail: "spawn failed" }));
			child.on("close", (code) => {
				finish({
					checked: true,
					passed: code === 0,
					exitCode: code ?? -1,
					stderrTail: stderr.trim().split("\n").slice(-2).join(" | "),
				});
			});
		});
	}
}
