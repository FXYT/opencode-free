import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	buildOpenCodeUserAgent,
	OPENCODE_MIN_UA_VERSION,
	getOpenCodeClientVersion,
} from "../src/identity.js";

const saved = process.env.OPENCODE_UA_VERSION;

afterEach(() => {
	if (saved === undefined) delete process.env.OPENCODE_UA_VERSION;
	else process.env.OPENCODE_UA_VERSION = saved;
});

describe("client identity (UA grammar + version floor)", () => {
	it("exposes the live-verified floor", () => {
		assert.strictEqual(OPENCODE_MIN_UA_VERSION, "1.18.0");
	});

	it("defaults to the floor with the host's client slug, honest attribution", () => {
		assert.strictEqual(buildOpenCodeUserAgent("neo"), "opencode/latest/1.18.0/neo");
		assert.strictEqual(buildOpenCodeUserAgent("mycli"), "opencode/latest/1.18.0/mycli");
	});

	it("accepts a raised env override", () => {
		process.env.OPENCODE_UA_VERSION = "2.1.0";
		assert.strictEqual(getOpenCodeClientVersion(), "2.1.0");
		assert.strictEqual(buildOpenCodeUserAgent("neo"), "opencode/latest/2.1.0/neo");
	});

	it("clamps versions below the floor (avoids a guaranteed 426)", () => {
		process.env.OPENCODE_UA_VERSION = "0.9.0";
		assert.strictEqual(getOpenCodeClientVersion(), "1.18.0");
	});

	it("falls back to the floor on malformed overrides", () => {
		process.env.OPENCODE_UA_VERSION = "banana";
		assert.strictEqual(getOpenCodeClientVersion(), "1.18.0");
	});

	it("clamps small offered client versions up to the floor", () => {
		assert.strictEqual(getOpenCodeClientVersion("1.0.0"), "1.18.0");
		assert.strictEqual(getOpenCodeClientVersion("2.2.0"), "2.2.0");
	});

	it("sanitizes the client slug into the grammar's [A-Za-z0-9_-] slot", () => {
		assert.strictEqual(buildOpenCodeUserAgent("My Agent/1.0!"), "opencode/latest/1.18.0/MyAgent10");
		assert.strictEqual(buildOpenCodeUserAgent("   "), "opencode/latest/1.18.0/opencode-free");
	});
});
