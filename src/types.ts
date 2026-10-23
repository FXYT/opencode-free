/**
 * Minimal host-agent-facing types, kept structurally compatible with the
 * OpenAI chat-completions shapes most agents already use, so a host can pass
 * its own message/tool objects through with little or no adaptation.
 */

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | { type: "text"; text: string }[];
	/** Required for `role: "tool"` — the id of the tool call being answered. */
	tool_call_id?: string;
	/**
	 * Assistant tool calls in the standard OpenAI wire shape — hosts that
	 * already store their own messages in this shape can pass them through
	 * unchanged.
	 */
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

/** Flat, host-friendly form of a completed tool call (module results use this). */
export interface ToolCall {
	/** Upstream-assigned tool-call id (echoed back with `role: "tool"`). */
	id: string;
	name: string;
	arguments: string;
	type: "function";
}

export interface Tool {
	type: "function";
	function: {
		name: string;
		description?: string;
		/** JSON schema for the tool's parameters. */
		parameters?: Record<string, unknown>;
	};
}

export interface ChatRequest {
	/** Model id, e.g. `glm-5.3-flash-free`. Free ids end in `-free`. */
	model: string;
	/** The host agent's own system prompt. Sent verbatim. */
	system?: string;
	messages: ChatMessage[];
	/**
	 * The host agent's REAL tools. At least one tool must be named `read`
	 * — the free-tier gate rejects tool-less requests and requests whose
	 * tools never include a file-reading tool (live-verified 2026-10-22).
	 */
	tools: Tool[];
	/** Epoch-ms timeout for the whole request, default 120_000. */
	timeoutMs?: number;
	/** AbortSignal from the host (cancels the request and the stream). */
	signal?: AbortSignal;
}

export type StreamEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	/** Emitted once per complete tool call, after its arguments finish streaming. */
	| { type: "tool_call"; call: ToolCall }
	/** Terminal event. `usage` is present only when the gateway included it. */
	| { type: "done"; finishReason: string | null; usage?: ChatResult["usage"] | undefined };


export interface ChatResult {
	text: string;
	reasoning: string;
	toolCalls: ToolCall[];
	finishReason: string | null;
	/** Present only when the gateway includes a usage object in its final chunk. */
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

export interface ClientOptions {
	/**
	 * Client label used in the documented OpenCode User-Agent grammar
	 * `opencode/latest/<version>/<client>`. Free-form slot; declare your
	 * agent honestly, e.g. "youragent". Default: "opencode-free".
	 */
	client?: string;
	/**
	 * Your agent's own dotted semver, if ≥ 1.18.0. The gateway rejects
	 * versions below the 1.18.0 floor (426), so smaller values are clamped
	 * up to the floor. Env override: OPENCODE_UA_VERSION (may only raise).
	 */
	clientVersion?: string;
	/** Injectable fetch (tests / non-node hosts). Default: globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/**
	 * Base URL override (tests, proxies, or if the gateway endpoint moves).
	 * Default: the official `https://opencode.ai/inference/openai/v1`.
	 */
	baseUrl?: string;
	/** Attempts for retryable gateway failures (429 / 5xx). Default 5. */
	maxAttempts?: number;
	/** Base for linear retry backoff in ms (attempt-th multiplier × 1200). */
	retryBackoffMs?: number;
}

export type ConversationId = string;
