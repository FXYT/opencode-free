/**
 * Standalone client for OpenCode Console free models — keyless.
 *
 * Zero runtime dependencies: uses the platform `fetch` (Node >= 18, Bun,
 * Deno, modern bundlers). See README.md for the verified contract,
 * limitations and integration guide.
 */
import { OpenCodeFreeClient } from "./client.js";
import type { ClientOptions } from "./types.js";

export { OpenCodeFreeClient, Conversation } from "./client.js";
export {
	OpenCodeFreeError,
	classifyGatewayError,
	isOpenCodeStaleCredentialError,
	isFreeOpenCodeModelId,
	type OpenCodeErrorCode,
} from "./errors.js";
export { getOpenCodeClientVersion, buildOpenCodeUserAgent, OPENCODE_MIN_UA_VERSION } from "./identity.js";
export { getOpenCodeSessionId, mintOpenCodeSessionId, resetSessionIdCache } from "./session.js";
export { SseParser, type SseChunkHandler } from "./stream.js";
export type { ChatMessage, ChatRequest, ChatResult, ClientOptions, StreamEvent, Tool, ToolCall } from "./types.js";

/** Convenience factory: `const opencode = createOpenCodeFree({ client: "youragent" }).` */
export function createOpenCodeFree(options?: ClientOptions): OpenCodeFreeClient {
	return new OpenCodeFreeClient(options);
}

