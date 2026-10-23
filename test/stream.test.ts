import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser } from "../src/stream.js";

interface Log {
	text: string[];
	reasoning: string[];
	toolCalls: { id: string; name: string; arguments: string }[];
	finishReasons: (string | null)[];
	usages: Record<string, unknown>[];
	errors: unknown[];
}

function makeParser() {
	const log: Log = { text: [], reasoning: [], toolCalls: [], finishReasons: [], usages: [], errors: [] };
	const parser = new SseParser({
		onText: (delta) => log.text.push(delta),
		onReasoning: (delta) => log.reasoning.push(delta),
		onToolCall: (call) => log.toolCalls.push(call),
		onFinishReason: (reason) => log.finishReasons.push(reason),
		onUsage: (usage) => log.usages.push(usage),
		onError: (error) => log.errors.push(error),
	});
	return { parser, log };
}

describe("SSE parser", () => {
	it("parses text deltas across split network chunks", () => {
		const { parser, log } = makeParser();
		const dataLine =
			'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';
		// Split the frame across two feeds like a real TCP stream would.
		parser.feed(dataLine.slice(0, 25));
		parser.feed(dataLine.slice(25));
		assert.deepStrictEqual(log.text, ["Hello"]);
	});

	it("handles reasoning_content deltas (proven free-model behaviour)", () => {
		const { parser, log } = makeParser();
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n',
		);
		parser.feed('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
		assert.deepStrictEqual(log.reasoning, ["thinking"]);
		assert.deepStrictEqual(log.text, ["hi"]);
	});

	it("terminates on [DONE] and ignores comment/event lines", () => {
		const { parser, log } = makeParser();
		parser.feed(": keep-alive comment\n\n");
		parser.feed('event: message\ndata: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n');
		parser.feed("data: [DONE]\n\n");
		assert.deepStrictEqual(log.text, ["x"]);
		assert.deepStrictEqual(log.finishReasons, ["stop"]);
	});

	it("captures usage when the final chunk carries it (not guaranteed by the gateway)", () => {
		const { parser, log } = makeParser();
		parser.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"total_tokens":42}}\n\n');
		assert.deepStrictEqual(log.usages, [{ total_tokens: 42 }]);
	});

	it("accumulates streamed tool_call fragments and emits them once on finish_reason tool_calls", () => {
		const { parser, log } = makeParser();
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}\n\n',
		);
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
		);
		// Nothing emitted yet — args still streaming.
		assert.deepStrictEqual(log.toolCalls, []);
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
		);
		assert.strictEqual(log.toolCalls.length, 1);
		assert.strictEqual(log.toolCalls[0]!.id, "call_1");
		assert.strictEqual(log.toolCalls[0]!.name, "read");
		assert.strictEqual(log.toolCalls[0]!.arguments, '{"path": "a.txt"}');
	});

	it("does not emit the same buffered call twice", () => {
		const { parser, log } = makeParser();
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
		);
		parser.feed(
			'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
		);
		assert.strictEqual(log.toolCalls.length, 1);
	});

	it("surfaces in-stream gateway error objects", () => {
		const { parser, log } = makeParser();
		parser.feed('data: {"error":{"type":"server_error","message":"boom"}}\n\n');
		assert.strictEqual(log.errors.length, 1);
		assert.strictEqual((log.errors[0] as { message: string }).message, "boom");
	});

	it("ignores unparseable data lines instead of crashing", () => {
		const { parser, log } = makeParser();
		parser.feed("data: {broken json...\n\n");
		parser.feed('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
		assert.deepStrictEqual(log.text, ["ok"]);
	});

	it("flushes a trailing buffered line on end()", () => {
		const { parser, log } = makeParser();
		// No trailing newline: the frame stays buffered until end() flushes it.
		parser.feed('data: {"choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":null}]}');
		assert.deepStrictEqual(log.text, []);
		parser.end();
		assert.deepStrictEqual(log.text, ["tail"]);
	});
});
