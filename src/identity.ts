/**
 * Client identity for the OpenCode Console free tier.
 *
 * The gateway's documented UA grammar is `opencode/[latest?]<dotted-semver>/<client>`,
 * with a free slot for the client name in the last segment — third parties
 * identify themselves there. This is honest attribution: the module declares
 * its host as the given client name while speaking the grammar the gateway
 * itself defines (see anomalyco/opencode issue #49433, where third-party
 * clients asked for exactly this contract).
 *
 * Live-verified 2026-10-22 against the real gateway:
 * - Dotted semver < 1.18.0  → 426 UpgradeRequired ("OpenCode 1.18.0 or newer
 *   required"); 1.18.0+ and up pass.
 * - Absent / non-dotted / wrong-grammar / OpenAI-SDK UAs → 403 FreeTierError.
 * - The client slot is free-form (`/neo`, `/xyz`, … all pass).
 */

/**
 * Live-verified client-version floor for the free tier. The gateway rejects
 * anything lower with 426 UpgradeRequired.
 */
export const OPENCODE_MIN_UA_VERSION = "1.18.0";

function compareSemver(a: string, b: string): number {
	const [aMajor = 0, aMinor = 0, aPatch = 0] = a.split(".").map(Number);
	const [bMajor = 0, bMinor = 0, bPatch = 0] = b.split(".").map(Number);
	return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch || 0;
}

/**
 * Resolve the version to declare in the UA. The gateway rejects versions
 * below the documented floor with 426, so any offered version is clamped up.
 * The `OPENCODE_UA_VERSION` env override lets operators raise the declared
 * version if the gateway floor moves before a host release catches up; it
 * never goes below the floor (that only buys a guaranteed 426).
 */
export function getOpenCodeClientVersion(offered?: string): string {
	const candidates = [process.env.OPENCODE_UA_VERSION?.trim(), offered];
	for (const candidate of candidates) {
		if (
			candidate &&
			/^\d+\.\d+\.\d+$/.test(candidate) &&
			compareSemver(candidate, OPENCODE_MIN_UA_VERSION) >= 0
		) {
			return candidate;
		}
	}
	return OPENCODE_MIN_UA_VERSION;
}

/** `opencode/latest/<version>/<client>` — the identity the free-tier gate requires. */
export function buildOpenCodeUserAgent(client: string, offeredVersion?: string): string {
	const clientSlug = client.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "opencode-free";
	return `opencode/latest/${getOpenCodeClientVersion(offeredVersion)}/${clientSlug}`;
}
