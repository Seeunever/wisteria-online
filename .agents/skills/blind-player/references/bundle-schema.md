# Canonical Blind Bundle

Use one logical model and physically separate its safe, internal, and vault projections. All object keys are stable opaque IDs with a type prefix and an 8–64 character lowercase hexadecimal suffix, for example `role_a1b2c3d4`. Do not derive IDs from titles, names, answers, or locations.

## Top-level shape

```json
{
  "schemaVersion": "blind-script/1.0",
  "script": {},
  "sources": {},
  "assets": {},
  "contentBlocks": {},
  "roles": {},
  "stages": {},
  "locations": {},
  "clues": {},
  "hostPack": {},
  "policy": {},
  "validation": { "profile": "blind-player/1.0" }
}
```

Collections are objects keyed by ID, not arrays whose position carries meaning.

The snippets below show object shape. Any `evidence: []` placeholder must be replaced by at least one full evidence object before validation, except for a publication that is explicitly disabled or a host pack that contains no host material.

## Script and version

Required fields:

```json
{
  "scriptId": "scr_a1b2c3d4",
  "versionId": "ver_b2c3d4e5",
  "parentVersionId": null,
  "titleContentId": "cnt_c3d4e5f6",
  "locale": "zh-CN",
  "playerCount": { "min": 1, "max": 1 },
  "state": "draft",
  "sourceSetHash": "sha256:...",
  "canonicalPayloadHash": null
}
```

States are `draft`, `validated`, or `frozen`. A frozen version is immutable. Any OCR correction, file replacement, mapping change, or rule correction creates a new `versionId`. Canonical hashing excludes volatile timestamps.

Optional `createdAt` and `frozenAt` values use real UTC RFC 3339 timestamps ending in `Z`. A frozen version requires `frozenAt`; a non-frozen version must not contain it. Player counts are integers from 1 through 128. Role slots must exactly cover `1..playerCount.max`.

`parentVersionId` cannot equal the current version. Historical parent existence and frozen-version immutability are enforced by the application's append-only version registry; a standalone bundle cannot prove either property.

Compute `sourceSetHash` as SHA-256 of canonical JSON containing rows `[sourceId, sha256, byteLength]` sorted by `sourceId`. Compute `canonicalPayloadHash` after setting that hash field to `null` and removing `createdAt` and `frozenAt`. The validation profile remains inside the canonical payload. Both hashes are required before the validator can declare a version freeze-ready.

`blind-canonical-json/1.0` is defined by `scripts/validate_bundle.py::canonical_json`: UTF-8; object keys sorted by Unicode code point; no insignificant whitespace; ordinary JSON string escaping; base-10 integers; and finite decimal numbers written without an exponent, redundant trailing zeroes, or negative zero. Valid confidence and normalized-coordinate values have at most six decimal places. Use the included function and golden tests when generating bundles; do not substitute a platform's default JSON serializer.

## Sources and provenance

Each source stores its private path only in the vault:

```json
{
  "sourceId": "src_d4e5f6a7",
  "safeLabel": "source-0042",
  "originalPathRef": "vault:path:0042",
  "mediaType": "image/jpeg",
  "sha256": "sha256:...",
  "byteLength": 123,
  "sourceClass": {
    "kind": "role_book",
    "subjectId": "role_e5f6a7b8"
  },
  "classification": {
    "status": "proposed",
    "method": "layout",
    "confidence": 0.0
  },
  "pages": [
    {
      "pageId": "page_f6a7b8c9",
      "index": 0,
      "width": 1,
      "height": 1,
      "rotation": 0,
      "sha256": "sha256:..."
    }
  ]
}
```

Allowed source kinds are `role_book`, `clue_face`, `clue_sheet`, `player_rules`, `public_material`, `host_guide`, `solution`, and `unknown`. `layout` and `ocr` are heuristic methods and can create only `proposed` classifications. `verified` requires a trusted `manifest` or explicit `review`; player-visible content requires verified classification.

`safeLabel` values are unique `source-NNNN` identifiers. `originalPathRef` is a vault reference such as `vault:path:0042`, never a raw path. Media types are restricted to supported image types and PDF. Page indexes are unique and contiguous from zero.

The private inventory assigns the corresponding `path_ref` before any semantic extraction. Bundle validation compares the exact source-ID set plus each source's `originalPathRef`, media type, byte length, and SHA-256 against that inventory, then re-hashes the immutable opaque vault blob. Images must also match their verified dimensions and single-page hash; PDFs must match the inventoried page count. A missing manifest, extra blob, changed blob, or any disagreement produces the fixed blocking code `INVENTORY_PROVENANCE_MISMATCH`.

`role_book` requires a valid role `subjectId`; `clue_face` requires a valid clue `subjectId`; all other source kinds require `subjectId: null`.

## Assets

Assets only connect logical content to one or more source records; they never carry a path or URL:

```json
{
  "assetId": "asset_a3b4c5d6",
  "sourceIds": ["src_d4e5f6a7"]
}
```

`sourceIds` is non-empty, unique, and fully included in the taint set of every content block that uses the asset. Original and derived bytes remain in the private vault.

Every extracted or inferred field carries evidence:

```json
{
  "sourceId": "src_d4e5f6a7",
  "pageId": "page_f6a7b8c9",
  "region": {
    "unit": "normalized",
    "x": 0.0,
    "y": 0.0,
    "width": 1.0,
    "height": 1.0
  },
  "side": "single",
  "readingOrder": 1
}
```

Coordinates are between 0 and 1, have at most six decimal places, and width/height are positive. The exact decimal sums must satisfy `x + width <= 1` and `y + height <= 1`; no floating-point tolerance may extend a region beyond the page. Page ordering, card pairing, stage mapping, and permissions need evidence just as text fields do.

## Content blocks

All semantic values, including display names and labels, live in content blocks rather than entity indexes:

```json
{
  "contentId": "cnt_c3d4e5f6",
  "kind": "text",
  "payload": { "text": "vault content" },
  "assetIds": [],
  "classification": {
    "level": "L2",
    "compartments": ["role:role_e5f6a7b8", "stage:stage_a7b8c9d0"],
    "taintSourceIds": ["src_d4e5f6a7"]
  },
  "visibility": {
    "default": "deny",
    "grants": []
  },
  "trace": {
    "evidence": [],
    "ocrExtractionId": null,
    "reviewStatus": "unreviewed"
  }
}
```

Allowed levels are `L0`, `L1`, `L2`, `L3`, and `L4`. L2 needs at least one `role:`, `clue:`, or `stage:` compartment whose target exists and at least one matching player grant. A role-book or clue-face source taint automatically requires the matching role or clue compartment. L3 and L4 cannot have player grants; a `system_only` grant is allowed but never authorizes a player.

Content payloads have only `text` and optional `language`. Every content block has at least one evidence region and at least one taint source. All evidence and asset sources must be included in `taintSourceIds`; duplicates are rejected.

Track OCR separately from structural confidence. `ocrExtractionId` is an opaque reference to the private vault's OCR record, not a browser-resolvable or public bundle object:

```json
{
  "method": "ocr",
  "engine": "opaque-engine-id",
  "engineVersion": "opaque-version",
  "languageHints": ["zh-Hans"],
  "rawTextRef": "vault:text:0042",
  "normalizedTextRef": "vault:text:0043",
  "confidence": {
    "aggregate": 0.0,
    "minimumToken": 0.0,
    "coverage": 0.0,
    "basis": "engine-reported"
  },
  "review": {
    "status": "needs-review",
    "reasonCodes": []
  }
}
```

Do not combine OCR confidence, source classification, page order, face pairing, and semantic mapping into one score. Critical rules require verified review even at high OCR confidence.

## Roles and stages

```json
{
  "roleId": "role_e5f6a7b8",
  "slot": 1,
  "displayNameContentId": "cnt_c3d4e5f6",
  "sections": [
    {
      "sectionId": "section_b8c9d0e1",
      "kind": "background",
      "stageId": "stage_a7b8c9d0",
      "order": 1,
      "contentIds": ["cnt_c3d4e5f6"],
      "unlockWhen": { "op": "stage_reached", "stageId": "stage_a7b8c9d0" },
      "evidence": []
    }
  ]
}
```

```json
{
  "stageId": "stage_a7b8c9d0",
  "sequence": 1,
  "labelContentId": "cnt_c3d4e5f6",
  "enterWhen": { "op": "always" },
  "completeWhen": { "op": "host_release", "releaseId": "release_c9d0e1f2" },
  "allowedActions": ["read_role_section", "search", "publish_clue"],
  "locationIds": [],
  "evidence": []
}
```

The script title is L1. A role display name is L1 or belongs to that role's L2 compartment. Role sections cannot contain L3/L4 content, and every L2 section block belongs to the enclosing role. Stage labels are L1 or belong to the enclosing stage compartment.

Allowed condition operations are:

- `always`
- `all`, `any`, `not`
- `stage_active`, `stage_reached`
- `role_assigned`
- `clue_held`, `clue_published`
- `host_release`
- `session_completed`

Unknown operations are blocking. Never evaluate executable expressions.

`host_release` IDs must exist in `hostPack.releasePlan`. Required dependencies use Boolean polarity: `all` contributes the union of required references, `any` contributes only references required by every branch, and negation is reduced with De Morgan semantics so double negation restores a positive dependency. Cycles across stage entry, host release, clue acquisition, and clue publication are blocking. A stage-entry condition cannot require the same or a later stage sequence. Every condition-bearing field—including role-section unlocks, location availability, grants, faces, and host resolutions—is checked for required dependencies on impossible events; none may require publication of a clue whose publication is disabled.

## Locations and clues

```json
{
  "locationId": "loc_d0e1f2a3",
  "nameContentId": "cnt_c3d4e5f6",
  "availableWhen": { "op": "stage_active", "stageId": "stage_a7b8c9d0" },
  "searchPolicy": {
    "mode": "draw_without_replacement",
    "perPlayerLimit": null,
    "globalLimit": null,
    "resetAtStageIds": []
  },
  "cluePool": [],
  "evidence": []
}
```

Search modes are `draw_without_replacement`, `fixed_sequence`, `all_visible`, and `host_dealt`. A clue need not belong to a location.

```json
{
  "clueId": "clue_e1f2a3b4",
  "kind": "card",
  "faces": [
    {
      "faceId": "face_f2a3b4c5",
      "side": "front",
      "assetIds": ["asset_a3b4c5d6"],
      "contentIds": ["cnt_c3d4e5f6"],
      "revealWhen": { "op": "clue_held", "clueId": "clue_e1f2a3b4" },
      "evidence": []
    }
  ],
  "pairing": {
    "status": "proposed",
    "method": "visual-match",
    "confidence": 0.0,
    "evidence": []
  },
  "acquisition": {
    "when": { "op": "always" },
    "initialAudience": "holder"
  },
  "publication": {
    "allowed": false,
    "publishWhen": { "op": "clue_held", "clueId": "clue_e1f2a3b4" },
    "revealedFaceIds": [],
    "evidence": []
  }
}
```

Pairing statuses are `unpaired`, `proposed`, `verified`, and `conflict`. Each face has independent access rules. A printable sheet and a single card image may be alternate representations of one face.

Each face has at least one content block. Every face asset must also appear in one of those content blocks so the asset inherits that block's default-deny policy, source taint, and compartment checks.

`initialAudience` is exactly `holder`. Broader clue visibility exists only through an explicit, evidence-backed publication event; assignment or room membership alone never reveals a newly acquired clue.

## Host pack

```json
{
  "hostPackId": "host_a3b4c5d6",
  "instructionContentIds": [],
  "resolutionSections": [],
  "answerKeys": [],
  "releasePlan": [],
  "evidence": []
}
```

Host instructions, resolutions, accepted answers, and released host material reference only L3 content blocks. Resolution sections may name only a declared `releaseId`. Release IDs are unique, and release conditions participate in the same dependency-cycle analysis as stage-entry conditions. A non-empty host pack requires source evidence.

## Grants

Every grant contains a principal, a finite condition, and verified evidence:

```json
{
  "policyId": "policy_b4c5d6e7",
  "principal": {
    "kind": "role_assignee",
    "subjectId": "role_e5f6a7b8"
  },
  "when": { "op": "stage_reached", "stageId": "stage_a7b8c9d0" },
  "evidence": []
}
```

Principal kinds are `room_member`, `role_assignee`, `clue_holder`, `room_after_event`, and `system_only`. Importer, room owner, player, and host are distinct principals. Owning or importing a pack never grants access to its solution.

For L2 player grants, the principal must match every role or clue compartment, and every stage compartment must be a required positive dependency of the grant condition. Stage-only content may use a room principal only when the condition implies every stage compartment. A single grant cannot weaken an intersection of compartments. Policy IDs are globally unique.

## Validation profile

The bundle contains exactly this validator selector:

```json
{ "profile": "blind-player/1.0" }
```

This is not a self-attestation. `validate_bundle.py` derives structural, provenance, review, pairing, compartment, condition-graph, and canonical-hash results itself. Runtime access-matrix and canary tests are a separate publication gate because they require the target application and authenticated room states.

The top-level policy is exactly:

```json
{ "default": "deny", "conditionLanguage": "blind-ast/1.0" }
```

## Physical projections

- `manifest.safe.json`: L0 and explicitly approved L1 metadata only.
- `bundle.internal.json`: server policy and entity graph; never static.
- `vault.content.json`: original-name mapping, OCR, role text, clues, solutions, and host material.
- private object storage: original and derived bytes under opaque keys.

The browser receives only a request-time server projection for one authenticated room member.

## Freeze gate

Bundle freezing requires unique IDs, valid references, explicit contiguous order, a stable canonical hash, verified visible-source classification, verified content review, verified card pairing, acyclic required dependencies, complete role slots, no L3/L4 player grants, and zero blocking issues.

Application publication additionally requires the runtime access matrix and canary scan in `runtime-access.md`. Bundle validation alone must never be presented as proof that a deployed application is spoiler-safe.
