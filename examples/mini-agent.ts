#!/usr/bin/env node
/**
 * Minimal working example: a tiny keyless coding agent on top of
 * opencode-free, running against the REAL OpenCode gateway.
 *
 *   node --import tsx examples/mini-agent.ts "what does src/errors.ts contain?"
 *
 * How the loop works (all communicating with the gateway via ONE `read`
 * tool, exactly as an agent would):
 *   1. The user's question plus THE AGENT'S OWN system prompt and its real
 *      `read` tool go to the free model (no API key needed).
 *   2. If the model calls `read`, the example executes it locally with
 *      fs.readFile — the only tool the gateway requires to exist.
 *   3. The tool result goes back to the model; the final answer streams.
 *
 * No OpenCode Desktop, no installed CLI, no credentials.
 */
import { readFile } from "node:fs/promises";
import { createOpenCodeFree } from "../src/index.js";
import type { ChatMessage } from "../src/types.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
	console.error("usage: node --import tsx examples/mini-agent.ts <question>");
	process.exit(2);
}

const client = createOpenCodeFree({
	// Honest attribution: your agent's name in the gateway's UA client slot.
	client: "mini-agent",
	clientVersion: "0.1.0",
});

// The example's REAL code-reading tool. Every host agent maps its own
// reader here; the gateway only requires that `tools` contains one named
// `read` — and it must actually work, because the model can call it.
const readTool = {
	type: "function" as const,
	function: {
		name: "read",
		description: "Read a text file from disk. Returns the file contents.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute or cwd-relative file path" },
			},
			required: ["path"],
		},
	},
};

async function executeRead(argsJson: string): Promise<string> {
	try {
		const { path } = JSON.parse(argsJson) as { path: string };
		return await readFile(path, "utf8");
	} catch (error) {
		return `tool error: ${String(error)}`; // errors are returned to the model, not thrown
	}
}

const system = [
	"You are mini-agent, an interactive coding agent running in a terminal.",
	"You answer questions about the user's codebase.",
	"To consult a file you have exactly one tool: `read`.",
	"Use it when the answer depends on file contents; otherwise answer directly.",
].join(" ");

async function main(): Promise<void> {
	const conversation = client.conversation("example-session");
	const messages: ChatMessage[] = [{ role: "user", content: question }];

	// Up to 3 model turns so the model can call `read` and then answer.
	for (let turn = 0; turn < 3; turn++) {
		let answer = "";
		let reasoning = "";
		const toolCalls: { id: string; name: string; arguments: string }[] = [];

		process.stdout.write(turn === 0 ? "" : "\n"); // keep output tidy between turns
		for await (const event of conversation.stream({
			model: "glm-5.3-flash-free", // live-verified free model
			system,
			messages,
			tools: [readTool],
			timeoutMs: 120_000,
		})) {
			switch (event.type) {
				case "reasoning":
					reasoning += event.delta;
					break;
				case "text":
					answer += event.delta;
					process.stdout.write(event.delta);
					break;
				case "tool_call":
					toolCalls.push(event.call);
					break;
				case "done":
					break;
			}
		}

		if (toolCalls.length === 0) return; // plain answer finished the loop

		messages.push({
			role: "assistant",
			content: answer,
			tool_calls: toolCalls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: call.arguments },
			})),
		});
		for (const call of toolCalls) {
			const result = await executeRead(call.arguments);
			console.error(`\n[tool ${call.name}] → ${String(result).length} bytes read`);
			messages.push({ role: "tool", content: result.slice(0, 4_000), tool_call_id: call.id });
		}
	}
}

main().catch((error: unknown) => {
	console.error(`\nfailed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
