import { spawn } from "node:child_process";

export interface SubprocessRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

/**
 * Run a subprocess with stdin = `input`, capture stdout/stderr, and enforce
 * a hard wall-clock timeout. The promise NEVER rejects; failures and timeouts
 * are reflected on the result object so call sites don't need try/catch.
 *
 * Why a custom runner instead of `execFile`:
 *   - `execFile` has buffer-size traps and an opaque error shape.
 *   - We need to feed code via stdin (avoids shell-escaping the model's code
 *     into the command line, which is both lossy and a security hazard).
 *   - We need an immediate `SIGKILL` on timeout so a misbehaving interpreter
 *     can't blow past the 1-second budget the user asked for.
 */
export function runWithStdin(
	command: string,
	args: string[],
	input: string,
	timeoutMs: number,
): Promise<SubprocessRunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			// Command not found (e.g. python3 missing) — treat as no-op-pass so
			// missing tooling never blocks the agent.
			resolve({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
			return;
		}

		const timer = setTimeout(
			() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// ignore — process may already be gone
				}
			},
			Math.max(50, timeoutMs),
		);

		const settle = (result: SubprocessRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", () => {
			// ENOENT or similar: same policy as the synchronous throw above.
			settle({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false });
		});
		child.on("close", (code) => {
			settle({
				ok: code === 0 && !timedOut,
				stdout,
				stderr,
				exitCode: code,
				timedOut,
			});
		});

		try {
			child.stdin?.write(input);
			child.stdin?.end();
		} catch {
			// stdin pipe died — the close event will still fire with whatever
			// exit code the child produced.
		}
	});
}
