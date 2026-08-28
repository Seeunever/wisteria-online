# Website Publication Workflow

Read this only when turning a validated blind bundle into a playable website or adding a new pack to an existing player application.

## Stable split

Keep the reusable application independent of story content. A new pack should normally require a private append-only install and runtime QA, not a source-code rewrite.

- Application code owns authentication, rooms, assignments, stages, searches, clue ownership, publication events, authorization versions, and server projections.
- The private pack owns the immutable entity graph, text, evidence, assets, conditions, and sensitivity policy.
- The database stores opaque IDs and current room state. It does not widen any bundle grant.
- Original bundles and source objects remain in server-private storage. Never copy them into a repository, static build, public directory, client cache, or diagnostic snapshot.

## Installation gate

Install only after the deterministic validation report says `freeze_ready: true` with zero blocking issues.

1. Use one fixed bundle path and one fixed validated safe-report path inside the fresh run root.
2. Record a byte hash before the copy, copy to a newly created opaque version directory with exclusive creation, and verify the source and destination byte hashes afterward.
3. Register the bundle's opaque `versionId` and canonical payload hash in an append-only version registry. Never overwrite an installed version.
4. Store only a safe public label outside the private bundle. Do not derive filenames, URLs, database keys, or logs from story text.
5. A failed copy or registry transaction must not leave an apparently installed version.

Installing a bundle does not publish it and does not grant the importer, application owner, room owner, or operator access to host material.

## Runtime model

Every protected request re-derives authorization from server-trusted state. Keep viewer state distinct from room-global event state:

- viewer assignment versus the set of all assigned roles;
- clues held by this viewer versus clues held anywhere in the room;
- current stage versus all reached stages;
- private clue ownership versus room publication events.

Use database uniqueness constraints and transactions for role claims, search-limit deduction, no-replacement draws, clue publication, stage transitions, and authorization-version changes. Reject stale state by checking the expected authorization version in the same transaction.

Return only a request-time projection. An opaque ID is a selector, never proof of access. Protected missing and unauthorized objects use the same response shape. Private routes and responses use `Cache-Control: private, no-store`; protected data does not enter URLs, logs, browser storage, service workers, or static assets.

## Publication gate

Have an isolated content-aware worker run the access matrix from `runtime-access.md` against the actual production build and actual validated pack. The player-facing thread receives only a fixed pass/block/failure code or a separately validated safe report.

The matrix must use private canaries derived from every role compartment and host-only content, then inspect HTML, RSC/network payloads, build output, logs, caches, and browser storage. At minimum cover anonymous, non-member, unassigned, every role, room owner, departed member, two-room isolation, all stages, clue held/published transitions, stale authorization, and tampered selectors.

Any missing capability, incomplete matrix row, or leak blocks publication. Do not waive the matrix because a sample pack is familiar to the player.

## Deployment and future packs

Production deployment remains an external mutation and needs the user's authorization even when local build, bundle validation, and runtime QA pass. Preserve the existing database and private version registry, back them up before risky changes, deploy application code separately from private pack bytes, and verify the public service without returning story content to the player thread.

For later packs, start from a fresh run root and repeat inventory, OCR, extraction, deterministic validation, exclusive installation, and the actual-pack runtime matrix. Existing rooms remain pinned to their original immutable version.
