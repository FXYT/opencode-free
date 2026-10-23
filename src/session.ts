/**
 * OpenCode Console session ids for third-party harnesses.
 *
 * The official harness documentation (opencode.ai/docs, Console "Sessions")
 * asks every client to send "a stable session ID with every request so Console
 * can route a conversation consistently and reuse its prompt cache", shaped
 * `x-opencode-session: ses_...`.
 *
 * The accepted shape is the one OpenCode's own clients mint with
 * `Identifier.descending()` (github.com/anomalyco/opencode,
 * packages/schema/src/identifier.ts): a 48-bit descending counter encoded as
 * 6 hex bytes plus 14 random base62 characters (`ses_` + 12 hex + 14 base62).
 * Live-verified 2026-10-22 against the real gateway: ids minted with this
 * exact law pass, while malformed shapes (UUIDs, all-same characters, wrong
 * lengths) are rejected with 403 FreeTierError.
 *
 * A host conversation gets one stable Console id for the process lifetime,
 * so Console pins the whole conversation to one upstream route and reuses
 * its prompt cache.
 */
import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Counter within the current millisecond (mirrors Identifier.descending). */
let lastMs = 0n;
let lastCounter = 0n;

/** Mint a fresh session id in OpenCode's own `ses_...` shape. */
export function mintOpenCodeSessionId(nowMs: number = Date.now()): string {
	const ms = BigInt(nowMs);
	if (ms === lastMs) lastCounter += 1n;
	else {
		lastMs = ms;
		lastCounter = 1n;
	}
	// value = ~(ms << 12 | counter) truncated to 48 bits, then 6 hex bytes.
	const value = ~(ms * 0x1000n + lastCounter) & ((1n << 48n) - 1n);
	const hex = value.toString(16).padStart(12, "0");
	const tail = Array.from(randomBytes(14), (b) => BASE62[b % 62]).join("");
	return `ses_${hex}${tail}`;
}

const sessionCache = new Map<string, string>();
const SESSION_CACHE_MAX = 256;

/**
 * Stable Console session id for a host conversation. The same conversation
 * key always maps to the same minted Console id; without a key an id is
 * minted per call (still one id per request — the downgrade is cache loss,
 * never a gate failure).
 */
export function getOpenCodeSessionId(conversationKey?: string): string {
	if (!conversationKey) return mintOpenCodeSessionId();
	const cached = sessionCache.get(conversationKey);
	if (cached) return cached;
	const minted = mintOpenCodeSessionId();
	if (sessionCache.size >= SESSION_CACHE_MAX) {
		// Bound process memory; oldest conversations lose cache affinity.
		const oldest = sessionCache.keys().next().value;
		if (oldest !== undefined) sessionCache.delete(oldest);
	}
	sessionCache.set(conversationKey, minted);
	return minted;
}

/** Reset the process-level cache (used by tests). */
export function resetSessionIdCache(): void {
	sessionCache.clear();
}
