/**
 * Shared mock helpers: a local OpenAI-compatible SSE server for
 * deterministic, network-free tests of the whole client pipeline
 * (headers, body, retries, streaming, parsing, tool calls).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export interface MockGateway {
	server: Server;
	baseUrl: string;
	requests: CapturedRequest[];
}

export interface MockRoute {
	/* Send `frames` as SSE data lines (each JSON-stringified), then [DONE]. */
	sse?: unknown[];
	/* Or respond with an HTTP error status + raw body. */
	status?: number;
	body?: string;
	/* Headers for the response (defaults: text/event-stream). */
	responseHeaders?: Record<string, string>;
	/* Raw additional text appended verbatim after the frames (unfinished lines). */
	rawTail?: string;
}

/**
 * Start a mock gateway. `routes[i]` is used for the i-th request; the last
 * route repeats for any further requests.
 */
export function startMockGateway(routes: MockRoute[]): Promise<MockGateway> {
	const state: { requests: CapturedRequest[] } = { requests: [] };
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			state.requests.push({
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			const route = routes[Math.min(state.requests.length - 1, routes.length - 1)];
			if (route.status !== undefined && route.status !== 200) {
				res.writeHead(route.status, { "Content-Type": "application/json" });
				res.end(route.body ?? "");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream", ...(route.responseHeaders ?? {}) });
			for (const frame of route.sse ?? []) res.write(`data: ${JSON.stringify(frame)}\n\n`);
			if (route.rawTail) res.write(route.rawTail);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, requests: state.requests });
		});
	});
}

export function stopMockGateway(gateway: MockGateway): Promise<void> {
	return new Promise((resolve) => gateway.server.close(() => resolve()));
}

interface MockDeltaFrame {
	choices: {
		index: number;
		delta: Record<string, unknown>;
		finish_reason: string | null;
	}[];
	usage?: Record<string, unknown>;
}

export function textChunk(delta: Record<string, unknown>, finishReason: string | null = null): MockDeltaFrame {
	return {
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

export function usageChunk(usage: Record<string, unknown>): MockDeltaFrame {
	return { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
}

export const READ_TOOL = {
	type: "function",
	function: {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
} as const;
