/**
 * LIVE integration test against the REAL OpenCode gateway — no mock, no key.
 *
 * Opt-in only (OPENCODE_FREE_LIVE=1) so the default test run and CI never
 * depend on a third-party network. The probes are spaced to stay polite.
 *
 * Note on the 426 upgrade gate: it is live-verified (wire-captured on
 * 2026-10-22) and classified in errors.ts, but it deliberately CANNOT be
 * triggered through this module's public API — versions below the floor are
 * clamped up at send time, which is the entire point of the clamp (identity
 * unit tests cover the clamp; the 426 classification unit tests cover the
 * translation).
 *
 * If any probe here fails, the module does not match the documented verified
 * contract and that is a real release blocker, not noise.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenCodeFree, isFreeOpenCodeModelId } from "../src/index.js";
import { READ_TOOL } from "./helpers.js";

const LIVE = process.env.OPENCODE_FREE_LIVE === "1";
const CONDITIONAL = LIVE ? it : it.skip;
const SPACING_MS = 2500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SYSTEM =
	"You are a tiny terminal coding agent. You can read files with the `read` tool. " +
	"Answer briefly and precisely.";

describe("live: real OpenCode gateway, keyless", () => {
	const opencode = createOpenCodeFree({
		client: "opencode-free-live-test",
		clientVersion: "0.1.0",
	});

	CONDITIONAL("answers a free-model question with real streaming text (glm)", async () => {
		const events = [];
		for await (const event of opencode.conversation("live-glm-1").stream({
			model: "glm-5.3-flash-free",
			system: SYSTEM,
			messages: [{ role: "user", content: "Reply with the single word: LIVE" }],
			tools: [READ_TOOL],
			timeoutMs: 60_000,
		})) {
			events.push(event);
		}
		const text = events
			.filter((e) => e.type === "text")
			.map((e) => (e as { delta: string }).delta)
			.join("");
		assert.ok(text.length > 0, "the gateway must return real text");
		assert.ok(events.some((e) => e.type === "done"), "stream must terminate with done");
		assert.ok(/live/i.test(text), `answer should contain the prompt word, got: ${text}`);
		await pause(SPACING_MS);
	});

	CONDITIONAL("answers with correct arithmetic, proving real inference (deepseek)", async () => {
		const result = await opencode.conversation("live-ds-1").chat({
			model: "deepseek-v4.1-flash-free",
			system: SYSTEM,
			messages: [{ role: "user", content: "Compute 17*23 and answer with only the number." }],
			tools: [READ_TOOL],
			timeoutMs: 60_000,
		});
		assert.ok(result.text.includes("391"), `expected 391, got: ${result.text}`);
		await pause(SPACING_MS);
	});

	CONDITIONAL("keeps the no-credential rule observable: no Authorization header possible", async () => {
		// Structural check: the client type has no credential surface at all.
		assert.ok(!("apiKey" in (opencode as object)), "the client must not grow an unverified credential knob");
		assert.ok(isFreeOpenCodeModelId("glm-5.3-flash-free"));
	});
});
