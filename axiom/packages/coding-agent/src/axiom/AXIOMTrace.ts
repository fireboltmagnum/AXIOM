import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AxiomTraceRecord, AxiomTraceStart } from "./RuntimeTypes.ts";

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}

export class AXIOMTraceStore {
	private readonly traceDir: string;
	private readonly filePath: string;
	private readonly enabled: boolean;

	constructor(options: { cwd: string; sessionId: string; enabled: boolean }) {
		this.traceDir = join(options.cwd, ".axiom", "traces");
		this.filePath = join(this.traceDir, `${safeFilePart(options.sessionId)}.jsonl`);
		this.enabled = options.enabled;
	}

	start(input: Omit<AxiomTraceStart, "startedAt">): void {
		this.record({
			type: "task_start",
			timestamp: new Date().toISOString(),
			...input,
			startedAt: new Date().toISOString(),
		});
	}

	record(record: AxiomTraceRecord): void {
		if (!this.enabled) {
			return;
		}
		try {
			mkdirSync(this.traceDir, { recursive: true });
			appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
		} catch {
			// Tracing must never slow or break the agent path.
		}
	}
}
