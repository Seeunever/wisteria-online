# Page-first private ingestion

Use this path for scanned PDFs, image folders, printable role books, and clue sheets. The goal is a reliable authorized page map, not a prose transcription of the story.

## Why this is the default

The website can render an original page or a verified crop through a server-side authorization check. Therefore a playable import usually needs structural mapping, source evidence, and access rules; it does not need every sentence converted to text. Avoiding full-pack OCR reduces runtime, transcription errors, semantic drift, and the amount of secret text handled by intermediate tools.

OCR remains useful for small title, identifier, boundary, negation, or rule regions when visual structure alone is insufficient. It is a targeted verification tool, not the primary content format.

## Fixed interpretation boundary

The isolated worker writes exactly one private map at `RUN_ROOT/private/page-map.json`. It is `RAW_SECRET`, never committed, logged, summarized, or served. It is consumed only to create `RUN_ROOT/vault/bundle.json`.

The map uses opaque local keys such as `role-01`, `stage-01`, `location-01`, and `clue-01`. Keys must not be derived from names or story text. It contains:

- a locale and a source-evidenced title label;
- ordered role slots with source-evidenced display labels;
- ordered stages and role sections;
- player-rule pages available to joined room members;
- locations with ordered clue pools and search policy;
- clue faces, verified pairings, holder visibility, and publication behavior;
- optional role restrictions and the room-scoped investigation flow;
- optional host-only sections and release conditions;
- one or more page references for every visible label, section, rule, location, face, and rule grant.

Each page reference contains only an inventoried `sourceId`, zero-based page index, normalized crop, side, and reading order. A full-page reference uses `[0, 0, 1, 1]`. Do not use mutable paths in the page map.

## Discovery order

1. Group immutable vault sources by media type, page count, dimensions, repeated layout, and numeric sequence.
2. Propose packet boundaries from folder and filename structure without treating them as verified.
3. Inspect covers, title regions, first pages, boundary pages, rule headings, and clue-sheet identifiers privately.
4. Use targeted local OCR only where a short region is needed to distinguish two structural mappings.
5. Verify every player-visible mapping from at least one direct source region. Critical rules, card pairing, and restrictions require direct review even when OCR confidence is high.
6. Quarantine any source or crop whose owner, stage, side, order, audience, or release condition remains ambiguous.

Do not ask a player to resolve story-semantic ambiguity. A safe logistics question may ask for a page boundary or whether a copy completed, but it must not quote nearby text or identify a secret-bearing object.

## Mapping rules

- Preserve pages at readable resolution; crop only to separate mixed pages or independent card faces.
- One source may support several page references, but a region cannot belong to two logical clues unless an alternate-representation relation is explicitly verified.
- Role sections use role and stage compartments and unlock only for the assigned role after the stage is reached.
- A clue face initially uses a clue-holder grant. A separate room-after-publication grant may expose only the face IDs listed by that clue's publication rule.
- Player rules are L1 session material only after their source is verified as `player_rules`.
- Host instructions, answers, and final resolution remain L3 and never gain a player grant merely because the site has no human host.
- A shared folder, print packet, adjacent numbering, or similar filename is never evidence that player instructions and final resolution have the same audience. Review those sources separately and encode final resolution through an explicit `session_completed` host release.
- Location order and clue-pool order are explicit fields. Array adjacency in source files is never implicit authorization or pairing evidence.

## Translation and validation

Translate the page map deterministically where tooling exists: generate opaque canonical IDs, source/page records, image content blocks, assets, evidence, grants, conditions, hashes, and the investigation graph without reinterpreting story content.

The page map cannot authorize publication. `validate_bundle.py` remains the structural and provenance gate, followed by actual-pack runtime access-matrix testing. Any correction abandons the run and creates a new page map and bundle rather than overwriting an earlier result.

## Output discipline

Before safe validation, emit only fixed process codes. Never print the page map, source paths, labels, crops, OCR snippets, or generated private IDs. Synthetic tests must use generated content-free fixtures and must not encode any real pack's counts or layout fingerprint.
