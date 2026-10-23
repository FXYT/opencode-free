import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	getOpenCodeSessionId,
	mintOpenCodeSessionId,
	resetSessionIdCache,
} from "../src/session.js";

const SESSION_SHAPE = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/;
const HEX = "0123456789abcdef";

describe("session id minting (proven OpenCode law)", () => {
	it("mints ids in the ses_<12hex><14base62> shape", () => {
		const id = mintOpenCodeSessionId();
		assert.match(id, SESSION_SHAPE);
		const body = id.slice(4);
		for (const ch of body.slice(0, 12)) assert.ok(HEX.includes(ch), `hex: ${ch}`);
	});

	it("mints distinct ids within the same millisecond (descending counter)", () => {
		const ms = Date.now();
		const a = mintOpenCodeSessionId(ms);
		const b = mintOpenCodeSessionId(ms);
		assert.notStrictEqual(a, b);
		assert.match(a, SESSION_SHAPE);
		assert.match(b, SESSION_SHAPE);
	});

	it("timestamps follow the 48-bit descending law (low 36 ms bits survive the mask)", () => {
		const id = mintOpenCodeSessionId(1_792_748_121_244);
		const raw = BigInt("0x" + id.slice(4, 16));
		// stored = ~(ms<<12|counter) & (2^48-1): the top bits of ms are masked
		// away by construction, so invert and compare the surviving slices.
		const inverted = ~raw & ((1n << 48n) - 1n);
		const low36ofMs = BigInt(1_792_748_121_244) & ((1n << 36n) - 1n);
		assert.strictEqual(inverted >> 12n, low36ofMs);
	});

	it("maps the same conversation key to the same Console id, others differ", () => {
		resetSessionIdCache();
		const first = getOpenCodeSessionId("conv-1");
		const again = getOpenCodeSessionId("conv-1");
		const other = getOpenCodeSessionId("conv-2");
		assert.strictEqual(first, again);
		assert.notStrictEqual(first, other);
		assert.match(first, SESSION_SHAPE);
	});

	it("mints per call with no conversation key", () => {
		resetSessionIdCache();
		assert.notStrictEqual(getOpenCodeSessionId(), getOpenCodeSessionId());
	});
});
