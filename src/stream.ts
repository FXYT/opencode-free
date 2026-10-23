/**
 * Minimal OpenAI-compatible SSE chunk reader + delta accumulator.
 *
 * The free-tier gateway emits standard `data: {json}` lines terminated by
 * `data: [DONE]`. This parser handles cross-chunk line splits, ignores
 * `event:`/comment lines, surfaces `usage` when the final chunk carries it,
 * and accumulates streamed tool_call deltas into complete calls.
 */

export interface SseChunkHandler {
	/** Called for each assistant content delta. */
	onText?: (delta: string) => void;
	/** Called for each reasoning delta (models that emit `reasoning_content`). */
	onReasoning?: (delta: string) => void;
	/** Called once per complete tool call, when its arguments finish streaming. */
	onToolCall?: (call: { id: string; name: string; arguments: string }) => void;
	/** Called with `finish_reason` when the final choice chunk arrives. */
	onFinishReason?: (finishReason: string | null) => void;
	/** Called when the final chunk carries a usage object. */
	onUsage?: (usage: Record<string, unknown>) => void;
	/** Gateway error object delivered in-stream; should typically throw. */
	onError?: (error: unknown) => void;
}

interface ToolCallBuffer {
	id: string;
	name: string;
	arguments: string;
	/** flushing guard: a call is emitted exactly once */
	emitted: boolean;
}

export class SseParser {
	#buffer = "";
	#toolCalls = new Map<number | string, ToolCallBuffer>();

	constructor(private readonly handlers: SseChunkHandler) {}

	/** Feed one raw HTTP-chunk worth of text; returns remaining partial line. */
	feed(text: string): void {
		this.#buffer += text;
		let sep: number;
		while ((sep = this.#buffer.indexOf("\n")) !== -1) {
			const line = this.#buffer.slice(0, sep).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(sep + 1);
			this.#handleLine(line);
		}
	}

	/** Process any trailing buffered line (call after the stream truly ends). */
	end(): void {
		if (this.#buffer.trim()) this.#handleLine(this.#buffer.replace(/\r$/, ""));
		this.#buffer = "";
	}

	#handleLine(line: string): void {
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") return;
		let parsed: any;
		try {
			parsed = JSON.parse(payload);
		} catch {
			// Unparseable data line: ignore (documented behaviour).
			return;
		}
		if (parsed.error !== undefined) {
			this.handlers.onError?.(parsed.error);
			return;
		}
		const usage = parsed.usage;
		if (usage && typeof usage === "object") {
			this.handlers.onUsage?.(usage);
		}
		const choice = parsed.choices?.[0];
		if (!choice) return;
		const finishReason: string | null = choice.finish_reason ?? null;
		const delta = choice.delta ?? {};
		if (typeof finishReason === "string" && finishReason) this.handlers.onFinishReason?.(finishReason);
		// Consume the deltas FIRST, then treat `finish_reason: "tool_calls"` as
		// the completion signal (tool-call arguments stream as fragments).
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls as any[]) this.#accumulateToolCall(tc);
		}
		if (typeof delta.content === "string" && delta.content) this.handlers.onText?.(delta.content);
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
			this.handlers.onReasoning?.(delta.reasoning_content);
		}
		if (finishReason === "tool_calls") this.#flushToolCalls();
	}

	#accumulateToolCall(tc: any): void {
		const streamIndex = typeof tc.index === "number" ? tc.index : undefined;
		const key: number | string = streamIndex !== undefined ? streamIndex : (tc.id ?? "");
		let buf = key === "" && this.#toolCalls.size > 0 ? undefined : this.#toolCalls.get(key);
		if (!buf && tc.id) buf = this.#toolCalls.get(tc.id);
		if (!buf) {
			buf = { id: tc.id ?? "", name: "", arguments: "", emitted: false };
			this.#toolCalls.set(key, buf);
			if (tc.id && key !== tc.id) {
				// index-keyed primary, id-keyed shadow so index splits rejoin by id
				this.#toolCalls.set(tc.id, buf);
			}
		}
		if (!buf.id && tc.id) buf.id = tc.id;
		if (!buf.name && tc.function?.name) buf.name = tc.function.name;
		if (typeof tc.function?.arguments === "string") buf.arguments += tc.function.arguments;
	}

	#flushToolCalls(): void {
		for (const buf of this.#toolCalls.values()) {
			if (buf.emitted) continue;
			buf.emitted = true;
			this.handlers.onToolCall?.({ id: buf.id, name: buf.name, arguments: buf.arguments });
		}
	}
}
