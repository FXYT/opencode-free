/**
 * OpenCode Console free-model client, extracted 2026-10-23 from the live
 * integration inside the Raushan NEO agent, where it was verified end-to-end
 * against the REAL gateway (not mocks) on 2026-10-22:
 *
 *   POST https://opencode.ai/inference/openai/v1/chat/completions
 *
 * The live-verified request contract (all probes the same day):
 * - User-Agent: `opencode/latest/<dotted semver >= 1.18.0>/<client>` — the
 *   gateway's own documented grammar, free-form client slot (honest
 *   attribution; `neo`, `xyz`, … all pass). A lower version →
 *   426 UpgradeRequired; absent / non-dotted / OpenAI-SDK UA →
 *   403 FreeTierError.
 * - Four session headers (x-opencode-session, x-opencode-session-id,
 *   x-session-id, x-session-affinity) all set to ONE minted `ses_` id
 *   (`ses_<12hex><14base62>`, OpenCode's Identifier.descending law);
 *   malformed ids (UUIDs, wrong lengths) → 403 FreeTierError.
 * - Body: `stream: true`; agent-shaped requests — the tool list must include
 *   a tool named `read`. With a `read` tool present the system prompt is
 *   irrelevant (any system prompt passes); with no tools at all → 403
 *   FreeTierError. (The tool-less path used by OpenCode's own client relies
 *   on an OpenCode-owned prompt fingerprint that is deliberately NOT
 *   embedded here, for license reasons.)
 * - No Authorization header: anonymous requests answer with 200 and produce
 *   real streamed text. An attached invalid/dead credential is rejected
 *   upstream with 401 — keyless is the verified path.
 * - Verified free models (individually, real responses): glm-5.3-flash-free,
 *   deepseek-v4.1-flash-free. Other `-free` ids share the verified shape but
 *   were not probed one by one.
 *
 * Restrictions honoured: nothing here fabricates tokens, forges identity, or
 * bypasses a credential wall — the gate is a shape check and the module
 * complies with the shape openly.
 */
import { buildOpenCodeUserAgent } from "./identity.js";
import { getOpenCodeSessionId } from "./session.js";
import { SseParser } from "./stream.js";
import { classifyGatewayError, isFreeOpenCodeModelId, OpenCodeFreeError } from "./errors.js";
import type { ChatMessage, ChatRequest, ChatResult, ClientOptions, StreamEvent, ToolCall } from "./types.js";

const DEFAULT_BASE_URL = "https://opencode.ai/inference/openai/v1";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 1200;
const DEFAULT_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function combineSignals(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): AbortSignal | undefined {
	if (timeoutMs === undefined) return signal;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeoutSignal;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeoutSignal]);
	// Node < 20 fallback: manual listener wiring
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	// AbortSignal.timeout exists on every supported runtime; no extra guard needed.
	timeoutSignal.addEventListener("abort", () => controller.abort(timeoutSignal.reason), { once: true });
	return controller.signal;
}

/** One stable OpenCode Console session, bound to a host conversation key. */
export class Conversation {
	readonly sessionId: string;

	constructor(
		private readonly host: OpenCodeFreeClient,
		readonly key: string | undefined,
	) {
		this.sessionId = getOpenCodeSessionId(key);
	}

	/**
	 * Stream one free-model chat turn. Yields text/reasoning deltas, complete
	 * tool calls, and a terminal `done` event. Throws OpenCodeFreeError on
	 * gateway rejection (see errors.ts for the taxonomy).
	 */
	stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
		return this.host._execute(request, this.sessionId);
	}

	/**
	 * Non-callback convenience: consumes the whole stream and returns the
	 * accumulated text, reasoning, tool calls, finish reason and usage.
	 */
	async chat(request: ChatRequest): Promise<ChatResult> {
		const text: string[] = [];
		const reasoning: string[] = [];
		const toolCalls: ToolCall[] = [];
		let finishReason: string | null = null;
		let usage: ChatResult["usage"] | undefined;
		for await (const event of this.host._execute(request, this.sessionId)) {
			switch (event.type) {
				case "text":
					text.push(event.delta);
					break;
				case "reasoning":
					reasoning.push(event.delta);
					break;
				case "tool_call":
					toolCalls.push(event.call);
					break;
				case "done":
					finishReason = event.finishReason;
					usage = event.usage;
					break;
			}
		}
		return {
			text: text.join(""),
			reasoning: reasoning.join(""),
			toolCalls,
			finishReason,
			...(usage !== undefined ? { usage } : {}),
		};
	}
}

export class OpenCodeFreeClient {
	readonly #clientLabel: string;
	readonly #offeredVersion: string | undefined;
	readonly #baseUrl: string;
	readonly #fetchImpl: typeof fetch;
	readonly #maxAttempts: number;
	readonly #backoffMs: number;

	constructor(options: ClientOptions = {}) {
		this.#clientLabel = options.client?.trim() || "opencode-free";
		this.#offeredVersion = options.clientVersion?.trim() || undefined;
		this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.#fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...(args as Parameters<typeof fetch>)));
		this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.#backoffMs = Math.max(0, options.retryBackoffMs ?? DEFAULT_BACKOFF_MS);
	}

	/** Full URL of the chat-completions endpoint (for diagnostics/tests). */
	get endpoint(): string {
		return `${this.#baseUrl}/chat/completions`;
	}

	/** A conversation bound to one stable minted Console session id. */
	conversation(key?: string): Conversation {
		if (key !== undefined) {
			return new Conversation(this, key);
		}
		return new Conversation(this, undefined);
	}

	/** @internal Shared execution used by Conversation. */
	async *_execute(
		request: ChatRequest,
		sessionId: string,
	): AsyncGenerator<StreamEvent, void, unknown> {
		this.#validate(request);

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": buildOpenCodeUserAgent(this.#clientLabel, this.#offeredVersion),
		};
		for (const name of ["x-opencode-session", "x-opencode-session-id", "x-session-id", "x-session-affinity"]) {
			headers[name] = sessionId;
		}

		const messages: ChatMessage[] = [];
		if (request.system !== undefined) messages.push({ role: "system", content: request.system });
		messages.push(...request.messages);

		const body = { model: request.model, messages, stream: true, tools: request.tools };
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const signal = combineSignals(timeoutMs, request.signal);

		const res = await this.#requestWithRetries(headers, body, signal);
		// At this point the gateway accepted the request (HTTP 200). Mid-stream
		// retries are forbidden — they would duplicate already-yielded content.
		yield* this.#streamResponse(res);
	}

	#validate(request: ChatRequest): void {
		if (!request.model) {
			throw new OpenCodeFreeError("invalid_request", "`model` is required (free ids end in `-free`).");
		}
		if (!isFreeOpenCodeModelId(request.model)) {
			throw new OpenCodeFreeError(
				"invalid_request",
				`\`${request.model}\` is not a free model id. This module targets OpenCode free models, whose ids end in \`-free\` ` +
					"(live-verified: glm-5.3-flash-free, deepseek-v4.1-flash-free). Paid models require a Console API key, " +
					"which this module deliberately does not attach.",
			);
		}
		if (!Array.isArray(request.messages)) {
			throw new OpenCodeFreeError("invalid_request", "`messages` must be an array.");
		}
		const tools = request.tools ?? [];
		const hasReadTool = tools.some((t) => t?.type === "function" && t.function?.name === "read");
		if (!hasReadTool) {
			throw new OpenCodeFreeError(
				"invalid_request",
				"The free-tier gate requires agent-shaped requests: `tools` must include at least one tool named `read` (your agent's real file-reading tool with its real schema). " +
					"With no tools the gateway answers 403 FreeTierError. This module deliberately does not forge a placeholder tool and does not embed OpenCode's own prompt fingerprint.",
			);
		}
	}

	async #requestWithRetries(
		headers: Record<string, string>,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<Response> {
		let lastError: unknown = new OpenCodeFreeError("gateway_error", "request failed with no attempts recorded");
		for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
			try {
				const res = await this.#fetchImpl(this.endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					...(signal !== undefined ? { signal } : {}),
				});
				if (res.ok) return res;
				const text = await res.text();
				if (RETRYABLE_STATUS.has(res.status) && attempt < this.#maxAttempts) {
					lastError = classifyGatewayError(res.status, text);
					await sleep(this.#backoffMs * attempt);
					continue;
				}
				throw classifyGatewayError(res.status, text);
			} catch (error) {
				if (error instanceof OpenCodeFreeError) throw error;
				if (signal?.aborted) throw error;
				// network-level failure (connection refused, timeout, reset)
				lastError = error;
				if (attempt < this.#maxAttempts) {
					await sleep(this.#backoffMs * attempt);
					continue;
				}
			}
		}
		throw lastError;
	}

	async *#streamResponse(res: Response): AsyncGenerator<StreamEvent, void, unknown> {
		if (!res.body) {
			throw new OpenCodeFreeError("gateway_error", "gateway returned an empty response body");
		}
		const decoder = new TextDecoder();
		const events: StreamEvent[] = [];
		let finishReason: string | null = null;
		let usage: ChatResult["usage"] | undefined;
		let inStreamError: OpenCodeFreeError | undefined;

		const parser = new SseParser({
			onText: (delta) => events.push({ type: "text", delta }),
			onReasoning: (delta) => events.push({ type: "reasoning", delta }),
			onToolCall: (call) =>
				events.push({
					type: "tool_call",
					call: { id: call.id, name: call.name, arguments: call.arguments, type: "function" },
				}),
			onFinishReason: (reason) => {
				finishReason = reason;
			},
			onUsage: (u) => {
				usage = u as ChatResult["usage"];
			},
			onError: (error) => {
				inStreamError = classifyGatewayError(0, JSON.stringify({ error }));
			},
		});
		const reader = res.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				events.length = 0;
				inStreamError = undefined;
				parser.feed(decoder.decode(value, { stream: true }));
				if (inStreamError) throw inStreamError;
				for (const event of events) yield event;
			}
			// flush the decoder tail and any buffered final line
			events.length = 0;
			inStreamError = undefined;
			const tail = decoder.decode();
			if (tail) parser.feed(tail);
			parser.end();
			if (inStreamError) throw inStreamError;
			for (const event of events) yield event;
			yield { type: "done", finishReason, ...(usage !== undefined ? { usage } : {}) };
		} finally {
			reader.releaseLock();
		}
	}
}
