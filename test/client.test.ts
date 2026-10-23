import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createOpenCodeFree } from "../src/index.js";
import { OpenCodeFreeError } from "../src/errors.js";
import { resetSessionIdCache } from "../src/session.js";
import {
	startMockGateway,
	stopMockGateway,
	textChunk,
	usageChunk,
	READ_TOOL,
	type MockGateway,
} from "./helpers.js";

let active: MockGateway | undefined;

afterEach(async () => {
	if (active) {
		await stopMockGateway(active);
		active = undefined;
	}
	resetSessionIdCache();
});

function makeClient(baseUrl: string) {
	// Tiny backoff keeps retry tests fast.
	return createOpenCodeFree({ client: "testhost", clientVersion: "2.1.0", baseUrl, retryBackoffMs: 1 });
}

const QUICK_REQUEST = {
	model: "glm-5.3-flash-free",
	system: "You are testhost, a tiny coding agent.",
	messages: [{ role: "user" as const, content: "hi" }],
	tools: [READ_TOOL],
};

const OK_FRAMES = [
	textChunk({ content: "Hel" }),
	textChunk({ content: "lo" }),
	textChunk({}, "stop"),
];

describe("client request shape (the live-verified gate contract)", () => {
	it("sends the OpenCode UA, one shared ses_ id on four headers, no Authorization", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }]);
		const client = makeClient(active.baseUrl);
		await client.conversation("conv-ua").chat(QUICK_REQUEST);

		assert.strictEqual(active.requests.length, 1);
		const req = active.requests[0]!;
		assert.ok(req.url.endsWith("/v1/chat/completions"));
		assert.strictEqual(req.headers["user-agent"], "opencode/latest/2.1.0/testhost");
		assert.strictEqual(req.headers.authorization, undefined);

		const ids = [
			req.headers["x-opencode-session"],
			req.headers["x-opencode-session-id"],
			req.headers["x-session-id"],
			req.headers["x-session-affinity"],
		];
		assert.ok(new Set(ids).size === 1, "all four session headers carry one id");
		assert.match(String(ids[0]), /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
	});

	it("pins one session id across turns of the same conversation", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }, { sse: OK_FRAMES }]);
		const client = makeClient(active.baseUrl);
		const conversation = client.conversation("conv-pin");
		await conversation.chat(QUICK_REQUEST);
		await conversation.chat(QUICK_REQUEST);

		const [first, second] = active.requests;
		assert.strictEqual(first!.headers["x-opencode-session"], second!.headers["x-opencode-session"]);
	});

	it("body carries stream:true, system first, and the host's real tools", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }]);
		const client = makeClient(active.baseUrl);
		await client.conversation().chat(QUICK_REQUEST);

		const body = JSON.parse(active.requests[0]!.body);
		assert.strictEqual(body.model, "glm-5.3-flash-free");
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.tools, [READ_TOOL]);
		assert.strictEqual(body.messages[0].role, "system");
		assert.strictEqual(body.messages[0].content, QUICK_REQUEST.system);
		assert.strictEqual(body.messages[1].role, "user");
		assert.strictEqual(body.messages[1].content, "hi");
	});
});

describe("streaming and accumulation", () => {
	it("streams text deltas in order and finishes with done", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }]);
		const client = makeClient(active.baseUrl);
		const events = [];
		for await (const event of client.conversation().stream(QUICK_REQUEST)) events.push(event);

		assert.deepStrictEqual(events.map((e) => e.type), ["text", "text", "done"]);
		assert.deepStrictEqual(events[0], { type: "text", delta: "Hel" });
		assert.deepStrictEqual(events[2], { type: "done", finishReason: "stop" });
	});

	it("chat() accumulates text, reasoning, finishReason and usage", async () => {
		active = await startMockGateway([
			{
				sse: [
					textChunk({ reasoning_content: "hmm" }),
					textChunk({ content: "answer" }),
					usageChunk({ total_tokens: 123 }),
				],
			},
		]);
		const client = makeClient(active.baseUrl);
		const result = await client.conversation().chat(QUICK_REQUEST);
		assert.strictEqual(result.text, "answer");
		assert.strictEqual(result.reasoning, "hmm");
		assert.strictEqual(result.finishReason, "stop");
		assert.deepStrictEqual(result.usage, { total_tokens: 123 });
	});

	it("returns complete tool calls for the host to execute", async () => {
		active = await startMockGateway([
			{
				sse: [
					textChunk({
						tool_calls: [
							{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
						],
					}),
					textChunk({
						tool_calls: [{ index: 0, function: { arguments: ' "/tmp/x.txt"}' } }],
					}),
					textChunk({}, "tool_calls"),
				],
			},
		]);
		const client = makeClient(active.baseUrl);
		const result = await client.conversation().chat(QUICK_REQUEST);
		assert.strictEqual(result.text, "");
		assert.strictEqual(result.toolCalls.length, 1);
		assert.strictEqual(result.toolCalls[0]!.id, "call_1");
		assert.strictEqual(result.toolCalls[0]!.name, "read");
		// Arguments streamed as fragments arrive fully accumulated.
		assert.strictEqual(result.toolCalls[0]!.arguments, '{"path": "/tmp/x.txt"}');
		assert.strictEqual(JSON.parse(result.toolCalls[0]!.arguments).path, "/tmp/x.txt");
	});
});

describe("fail-fast validation (no network)", () => {
	it("rejects requests whose tools never include `read`", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }]);
		const client = makeClient(active.baseUrl);
		await assert.rejects(
			client.conversation().chat({ ...QUICK_REQUEST, tools: [{ ...READ_TOOL, function: { ...READ_TOOL.function, name: "editor" } }] } as any),
			(error: OpenCodeFreeError) => {
				assert.strictEqual(error.code, "invalid_request");
				assert.match(error.message, /tool named `read`/);
				return true;
			},
		);
		assert.strictEqual(active.requests.length, 0, "no request may leave for a locally invalid request");
	});

	it("rejects paid model ids", async () => {
		const client = createOpenCodeFree();
		await assert.rejects(
			client.conversation().chat({ ...QUICK_REQUEST, model: "claude-opus-4-6", tools: [READ_TOOL] } as any),
			(error: OpenCodeFreeError) => {
				assert.strictEqual(error.code, "invalid_request");
				assert.match(error.message, /free model id/);
				return true;
			},
		);
	});
});

describe("gateway error handling and retries", () => {
	it("surfaces a 403 free-tier rejection as a typed actionable error", async () => {
		active = await startMockGateway([
			{
				status: 403,
				body: '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}',
			},
		]);
		const client = makeClient(active.baseUrl);
		await assert.rejects(client.conversation().chat(QUICK_REQUEST), (error: OpenCodeFreeError) => {
			assert.strictEqual(error.code, "free_tier_rejected");
			assert.strictEqual(error.status, 403);
			return true;
		});
	});

	it("surfaces a 426 upgrade gate with the override hint", async () => {
		active = await startMockGateway([{ status: 426, body: '{"type":"error","error":{"type":"UpgradeRequired","message":"OpenCode 1.18.0 or newer required"}}' }]);
		const client = makeClient(active.baseUrl);
		await assert.rejects(client.conversation().chat(QUICK_REQUEST), (error: OpenCodeFreeError) => {
			assert.strictEqual(error.code, "upgrade_required");
			assert.match(error.message, /OPENCODE_UA_VERSION/);
			return true;
		});
	});

	it("retries a transient 500 then succeeds before any content", async () => {
		active = await startMockGateway([
			{ status: 500, body: '{"error":{"message":"cold start"}}' },
			{ sse: OK_FRAMES },
		]);
		const client = makeClient(active.baseUrl);
		const result = await client.conversation().chat(QUICK_REQUEST);
		assert.strictEqual(result.text, "Hello");
		assert.strictEqual(active.requests.length, 2);
	});

	it("retries 429s with backoff and ultimately surfaces rate_limited", async () => {
		active = await startMockGateway([{ status: 429, body: '{"error":{"message":"slow down"}}' }]);
		const client = makeClient(active.baseUrl);
		await assert.rejects(client.conversation().chat(QUICK_REQUEST), (error: OpenCodeFreeError) => {
			assert.strictEqual(error.code, "rate_limited");
			return true;
		});
		assert.strictEqual(active.requests.length, 5, "Default retry budget: 5 attempts");
	});

	it("retries a 502 pre-chunk failure and succeeds", async () => {
		active = await startMockGateway([
			{ status: 502, body: "bad gateway" },
			{ sse: [textChunk({ content: "ok" }), textChunk({}, "stop")] },
		]);
		const client = makeClient(active.baseUrl);
		await assert.doesNotReject(client.conversation().chat(QUICK_REQUEST));
		assert.strictEqual(active.requests.length, 2);
	});

	it("accepts an upstream error object injected into the SSE stream as a typed error", async () => {
		active = await startMockGateway([
			{
				rawTail: 'data: {"error":{"type":"server_error","message":"Upstream request failed: Invalid credential"}}\n\n',
				sse: [],
			},
		]);
		const client = makeClient(active.baseUrl);
		await assert.rejects(client.conversation().chat(QUICK_REQUEST), (error: OpenCodeFreeError) => {
			assert.strictEqual(error.code, "invalid_credential");
			return true;
		});
	});

	it("respects the host AbortSignal", async () => {
		active = await startMockGateway([{ sse: OK_FRAMES }]);
		const controller = new AbortController();
		controller.abort();
		const client = makeClient(active.baseUrl);
		await assert.rejects(
			client.conversation().chat({ ...QUICK_REQUEST, signal: controller.signal, timeoutMs: 5000 }),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				return true;
			},
		);
	});
});
