import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "../host.ts";
import type { SubagentScope } from "./subagent-scheduler.ts";

type Usage = NonNullable<Awaited<ReturnType<ToolDefinition["execute"]>>["usage"]>;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, value?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> }): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (typeof value?.[key] === "number" && Number.isFinite(value[key])) total[key] += value[key];
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (typeof value?.cost?.[key] === "number" && Number.isFinite(value.cost[key]))
			total.cost[key] += value.cost[key];
	}
}

export interface ChildResult {
	output: string;
	exitCode: number;
	stopReason?: string;
	error?: string;
	stderr: string;
	usage: Usage;
}

export function limitOutput(text: string, limit = 50_000): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n[Output truncated; full output is in subagent tool details (up to 1 MB).]`
		: text;
}

/** Preserve only runtime essentials; delegated agents must not inherit user or host secrets. */
export function subagentEnvironment(depth: number, scope?: SubagentScope): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		TARK_SUBAGENT_DEPTH: String(depth),
		...(scope ? { TARK_SUBAGENT_SCOPE: JSON.stringify(scope) } : {}),
	};
	for (const name of [
		"PATH",
		"HOME",
		"USERPROFILE",
		"APPDATA",
		"SystemRoot",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TERM",
		"TMPDIR",
		"TMP",
		"TEMP",
		"PI_OFFLINE",
		"TARK_CODING_AGENT_DIR",
	] as const) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	return environment;
}

// Child stdout is a wire boundary; validate the subset of JSON events used by the parent.
const childEventSchema = z.object({
	type: z.string(),
	toolName: z.string().optional(),
	aborted: z.boolean().optional(),
	message: z
		.object({
			role: z.string(),
			content: z
				.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
				.optional(),
			stopReason: z.string().optional(),
			errorMessage: z.string().optional(),
			usage: z
				.object({
					input: z.number().optional(),
					output: z.number().optional(),
					cacheRead: z.number().optional(),
					cacheWrite: z.number().optional(),
					totalTokens: z.number().optional(),
					cost: z
						.object({
							input: z.number().optional(),
							output: z.number().optional(),
							cacheRead: z.number().optional(),
							cacheWrite: z.number().optional(),
							total: z.number().optional(),
						})
						.optional(),
				})
				.optional(),
		})
		.optional(),
});

export async function runSubagent(options: {
	invocation: { command: string; args: string[] };
	args: string[];
	cwd: string;
	depth: number;
	task: string;
	scope?: SubagentScope;
	signal: AbortSignal;
	onProgress?: (text: string) => void;
}): Promise<ChildResult> {
	options.signal.throwIfAborted();
	const result: ChildResult = { output: "", exitCode: -1, stderr: "", usage: emptyUsage() };
	return new Promise((resolve, reject) => {
		const grouped = process.platform !== "win32" && options.depth === 1;
		const child = spawn(options.invocation.command, [...options.invocation.args, ...options.args], {
			cwd: options.cwd,
			shell: false,
			detached: grouped,
			stdio: ["pipe", "pipe", "pipe"],
			env: subagentEnvironment(options.depth, options.scope),
		});
		let buffer = "",
			bytes = 0,
			timer: NodeJS.Timeout | undefined,
			failure: Error | undefined;
		let closed = false;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (grouped && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
			}
		};
		const stop = () => {
			kill("SIGTERM");
			timer ??= setTimeout(() => kill("SIGKILL"), 1000);
		};
		const abort = () => stop();
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) abort();

		const line = (text: string) => {
			if (!text.trim()) return;
			let event: z.infer<typeof childEventSchema>;
			try {
				event = childEventSchema.parse(JSON.parse(text));
			} catch {
				failure ??= new Error("Invalid JSON from subagent stdout");
				stop();
				return;
			}
			if (event.type === "message_end" && event.message) {
				const message = event.message;
				if (message.role === "assistant" || message.role === "toolResult") addUsage(result.usage, message.usage);
				if (message.role === "assistant") {
					result.output = (Array.isArray(message.content) ? message.content : [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n");
					if (result.output.length > 1_000_000)
						result.output = `${result.output.slice(0, 1_000_000)}\n[Output exceeded the 1 MB retention limit.]`;
					result.stopReason = message.stopReason;
					result.error = message.errorMessage;
					options.onProgress?.(limitOutput(result.output, 2000) || "Working…");
				}
			} else if (event.type === "tool_execution_start") {
				options.onProgress?.(`Running ${event.toolName}…`);
			} else if (event.type === "agent_settled" && event.aborted) {
				result.stopReason = "aborted";
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			if (failure) return;
			bytes += Buffer.byteLength(data);
			buffer += data;
			if (bytes > 64 * 1024 * 1024 || buffer.length > 8 * 1024 * 1024) {
				failure = new Error("Subagent event stream exceeded its limit");
				stop();
				return;
			}
			while (true) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				line(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (failure) break;
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			result.stderr = (result.stderr + text).slice(-32_000);
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") {
				failure = error;
				stop();
			}
		});
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code, signal) => {
			closed = true;
			options.signal.removeEventListener("abort", abort);
			if (!failure && buffer.trim()) line(buffer);
			if (timer) clearTimeout(timer);
			// A root cancellation must also terminate descendants that outlive the Pi process.
			if (grouped && (options.signal.aborted || failure || code !== 0 || signal)) kill("SIGKILL");
			if (options.signal.aborted) reject(new Error("Subagent aborted", { cause: options.signal.reason }));
			else if (failure) reject(failure);
			else {
				result.exitCode = code ?? 1;
				if (signal) result.error ??= `Subagent terminated by ${signal}`;
				if (!result.output && !result.error)
					result.error = result.stderr || "Subagent exited without a final text response";
				resolve(result);
			}
		});
		// stdin avoids command-line size limits and keeps delegated context out of process arguments.
		if (!closed) child.stdin.end(`Task:\n${options.task}\n`);
	});
}
