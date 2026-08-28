# Runtime Access Contract

Read this only when importing a validated bundle into a player application.

`freeze_ready: true` proves only the private bundle's static ingestion contract. It does not authorize publication. The application must pass this runtime contract and its own canary/access-matrix run before any player can receive story content.

## Storage split

- Store structured room state, immutable version metadata, opaque object mappings, assignments, stages, clue ownership, and reveal events in the server database.
- Store original and derived bytes in private object storage under opaque keys.
- Keep semantic story payload out of static builds. Fetch it only after a request-time authorization decision.
- Never place role books, clue faces, solution material, OCR, or complete bundle JSON in `public/` or client bundles.

## Authorization tuple

Authorize every request from server-trusted identity and current state:

```text
(user_id, room_id, version_id, membership_id, role_assignment,
 stage_state, clue_ownership, reveal_ledger, authorization_version)
```

Client-provided room, role, stage, clue, and asset IDs are selectors, not evidence. Missing or ambiguous state denies access.

## Required behavior

- Before assignment, return only a verified lobby projection independent of every role compartment.
- After assignment, return only the assigned role and currently unlocked sections.
- A found clue is visible only to its holder until a verified reveal event commits.
- Reveal operations are server-side, ownership-checked, idempotent, and append to an auditable room ledger.
- Role locking and search-limit deduction use database uniqueness/conditional updates, not read-then-write client logic.
- Switching roles, leaving a room, or changing authorization invalidates old capabilities and signed URLs.
- Room owner, project owner, importer, and player do not automatically receive host-secret access.
- Unauthorized and nonexistent protected objects use the same response shape.

## Response and cache controls

- Use `Cache-Control: private, no-store` for every private response.
- Disable route prefetch for protected future content.
- Do not put story content in URLs, query strings, object keys, error messages, analytics, or logs.
- Do not persist private content in local storage, session storage, service workers, or client-side global state beyond the currently rendered authorized projection.
- If short-lived object URLs are used, bind them to the current authorization version and keep expiry narrow.

## Test matrix

Test anonymous, signed-in but not joined, joined but unassigned, each role, room owner, departed member, and non-player operator across:

- before/after assignment;
- every stage transition;
- before/after clue acquisition and reveal;
- role change and reconnect;
- same route in two different rooms;
- stale signed URL and stale cache;
- tampered room, role, stage, clue, version, and object IDs.

Inspect HTML, RSC payloads, network responses, browser storage, static assets, source maps, snapshots, logs, and build output with synthetic canaries. A hidden but delivered secret is a failure.
