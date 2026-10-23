/**
 * Typed errors + gateway-response classification, extracted from the
 * live-verified behaviour of the OpenCode Console free tier
 * (wire-captured 2026-10-22). Every failure keeps the gateway's verdict
 * visible while adding an actionable hint — no silent swallowing.
 */

export type OpenCodeErrorCode =
	/** Your request lacked the client shape the free tier requires. */
	| "free_tier_rejected"
	/** UA below the 1.18.0 floor (or the gateway raised its floor). */
	| "upgrade_required"
	/** No usable credential (only reachable when the host sent one). */
	| "invalid_credential"
	/** The key was accepted as a credential object but expired upstream. */
	| "expired_credential"
	/** Transient upstream load; safe to retry (the client already tried). */
	| "rate_limited"
	/** The local call was malformed (e.g. no `read` tool — no network). */
	| "invalid_request"
	/** Anything else; `status` and the plain body are preserved. */
	| "gateway_error";

export class OpenCodeFreeError extends Error {
	readonly code: OpenCodeErrorCode;
	readonly status: number | undefined;
	/** First 300 chars of the raw gateway body, for support screenshots. */
	readonly detail: string | undefined;

	constructor(code: OpenCodeErrorCode, message: string, status?: number, detail?: string) {
		super(message);
		this.name = "OpenCodeFreeError";
		this.code = code;
		this.status = status;
		this.detail = detail;
	}
}

function shortenDetail(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * The gateway forwards the upstream verdict on a supplied credential verbatim:
 * `{"error":{"type":"server_error","message":"Upstream request failed: Invalid
 * credential"}}` (wire-captured 2026-10-22). Distinct from Console-issued
 * auth failures (`api_key_expired`, `AuthError`) — this is the upstream's
 * verdict on the credential value itself.
 */
export function isOpenCodeStaleCredentialError(text: string): boolean {
	return /Upstream request failed: Invalid credential/i.test(text);
}

/** Free ids (the only ids this module targets) end in `-free`. */
export function isFreeOpenCodeModelId(modelId: string): boolean {
	return /-free$/.test(modelId);
}

/**
 * Classify a non-OK gateway response into a typed, actionable error.
 * Message rules mirror the wire-captured shapes; the raw status and a
 * truncated body are always preserved.
 */
export function classifyGatewayError(status: number, body: string): OpenCodeFreeError {
	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	const errorType = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined;
	const errorCode = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;

	if (errorType === "FreeTierError" || /free tier can only be used from within OpenCode/i.test(body)) {
		return new OpenCodeFreeError(
			"free_tier_rejected",
			"OpenCode's gateway rejected this request under its free-tier client checks (403). " +
				"This module sends the documented client identity (User-Agent + session headers + streaming + a `read` tool), " +
				"so this is unexpected; retry once, then check for a newer module release. " +
				"The gateway's free-tier gate is a de-facto contract that OpenCode may change.",
			403,
			shortenDetail(body),
		);
	}
	if (errorType === "UpgradeRequired" || /UpgradeRequired|OpenCode \d[\d.]* or newer required/i.test(body)) {
		return new OpenCodeFreeError(
			"upgrade_required",
			"OpenCode's gateway requires a newer OpenCode-compatible client version " +
				"(minimum 1.18.0 at the time of this release). If the gateway just raised its floor, " +
				"set OPENCODE_UA_VERSION to a higher dotted version (e.g. 1.19.0) until the module updates.",
			status || 426,
			shortenDetail(body),
		);
	}
	if (errorCode === "api_key_expired" || /API key has expired/i.test(body)) {
		return new OpenCodeFreeError(
			"expired_credential",
			"The OpenCode API key you supplied has expired. Free models do not need a key — omit the credential.",
			status || 401,
			shortenDetail(body),
		);
	}
	if (isOpenCodeStaleCredentialError(body)) {
		return new OpenCodeFreeError(
			"invalid_credential",
			"The supplied credential was rejected upstream. Free models do not need a key — omit the credential.",
			status || 401,
			shortenDetail(body),
		);
	}
	if (status === 429 || /rate.?limit|slow down/i.test(body)) {
		return new OpenCodeFreeError(
			"rate_limited",
			`OpenCode rate limit hit (429). ${shortenDetail(body)}`,
			429,
		);
	}
	if (status === 401) {
		return new OpenCodeFreeError(
			"invalid_credential",
			`OpenCode authentication failed (401): ${shortenDetail(body)}`,
			401,
		);
	}
	return new OpenCodeFreeError(
		"gateway_error",
		`OpenCode gateway error (${status}): ${shortenDetail(body)}`,
		status,
	);
}
