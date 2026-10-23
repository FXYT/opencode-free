# Changelog

## 0.1.0 — 2026-10-23

Initial extraction from an agent-internal, live-verified integration
(first-party probes against the real OpenCode gateway on 2026-10-22).

- Keyless free-model chat: `conversation(id).chat()` /
  `conversation(id).stream()` with typed streaming events.
- OpenCode-document UA attribution with the live-verified client-version
  floor (`1.18.0`, env override `OPENCODE_UA_VERSION` may only raise).
- `ses_...` session-id minting (upstream `Identifier.descending()` law)
  pinned per host conversation; four-session-header family.
- Retry budget (5 attempts, linear backoff) for 429/5xx pre-content.
- Typed, actionable `OpenCodeFreeError` taxonomy.
- Local fail-fast validation: `-free` model ids, `read` tool presence.
- SSE parser: text/reasoning deltas, tool-call fragment accumulation,
  in-stream gateway-error objects, `usage` when present.
- 46 deterministic tests; env-gated live test (`OPENCODE_FREE_LIVE=1`).
