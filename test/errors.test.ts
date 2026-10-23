import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyGatewayError,
	isFreeOpenCodeModelId,
	isOpenCodeStaleCredentialError,
	OpenCodeFreeError,
} from "../src/errors.js";

describe("gateway error classification (wire-captured shapes)", () => {
	it("classifies the free-tier gate", () => {
		const err = classifyGatewayError(
			403,
			'{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}',
		);
		assert.strictEqual(err.code, "free_tier_rejected");
		assert.strictEqual(err.status, 403);
		assert.match(err.message, /free-tier client checks/);
		assert.match(err.detail!, /FreeTierError/);
	});

	it("classifies the 426 upgrade gate", () => {
		const err = classifyGatewayError(
			426,
			'{"type":"error","error":{"type":"UpgradeRequired","message":"OpenCode 1.18.0 or newer required"}}',
		);
		assert.strictEqual(err.code, "upgrade_required");
		assert.match(err.message, /OPENCODE_UA_VERSION/);
		assert.strictEqual(err.status, 426);
	});

	it("classifies the upstream invalid-credential verdict", () => {
		const err = classifyGatewayError(
			401,
			'{"error":{"type":"server_error","message":"Upstream request failed: Invalid credential"}}',
		);
		assert.strictEqual(err.code, "invalid_credential");
	});

	it("classifies expired keys on the documented code", () => {
		const err = classifyGatewayError(
			401,
			'{"error":{"type":"authentication_error","code":"api_key_expired","message":"This API key has expired."}}',
		);
		assert.strictEqual(err.code, "expired_credential");
	});

	it("classifies 429s as rate limits", () => {
		const err = classifyGatewayError(429, '{"error":{"message":"slow down"}}');
		assert.strictEqual(err.code, "rate_limited");
		assert.strictEqual(err.status, 429);
	});

	it("keeps unknown failures visible, not swallowed", () => {
		const err = classifyGatewayError(502, "upstream exploded");
		assert.strictEqual(err.code, "gateway_error");
		assert.strictEqual(err.status, 502);
		assert.match(err.message, /upstream exploded/);
	});

	it("preserves only a 300-char detail", () => {
		const err = classifyGatewayError(500, "x".repeat(1000));
		assert.ok((err.detail?.length ?? 0) <= 301);
	});
});

describe("stale credential matcher", () => {
	it("matches the wire-captured verdict", () => {
		assert.strictEqual(
			isOpenCodeStaleCredentialError('401 {"error":{"message":"Upstream request failed: Invalid credential"}}'),
			true,
		);
		assert.strictEqual(isOpenCodeStaleCredentialError("this API key has expired"), false);
		assert.strictEqual(isOpenCodeStaleCredentialError(""), false);
	});
});

describe("free model predicate", () => {
	it("accepts -free ids and rejects paid ones", () => {
		assert.strictEqual(isFreeOpenCodeModelId("glm-5.3-flash-free"), true);
		assert.strictEqual(isFreeOpenCodeModelId("deepseek-v4.1-flash-free"), true);
		assert.strictEqual(isFreeOpenCodeModelId("glm-5.3-flash"), false);
		assert.strictEqual(isFreeOpenCodeModelId("free"), false);
	});
});

describe("error type shape", () => {
	it("is instanceof Error with a stable name", () => {
		const err = new OpenCodeFreeError("gateway_error", "boom", 500);
		assert.ok(err instanceof Error);
		assert.strictEqual(err.name, "OpenCodeFreeError");
		assert.strictEqual(err.message, "boom");
	});
});
