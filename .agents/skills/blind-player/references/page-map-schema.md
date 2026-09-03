# Private page-map schema

`RUN_ROOT/private/page-map.json` is a strict UTF-8 JSON object with schema `blind-page-map/1.0`. It is `RAW_SECRET`. Only the isolated worker authors it, and only `scripts/build_page_bundle.py` consumes it.

Unknown fields, incomplete source classification, non-contiguous ordering, unreviewed card pairing, and references outside the immutable inventory fail closed.

## Page reference

Every evidence or page field uses:

```json
{
  "sourceId": "src_0123456789abcdef",
  "pageIndex": 0,
  "region": [0, 0, 1, 1],
  "side": "single",
  "readingOrder": 0
}
```

`sourceId` must exist in `private/source-inventory.json`. Page indexes are zero-based. Regions are normalized `[x, y, width, height]` with at most six decimal places. Sides are `front`, `back`, `single`, or `unknown`.

## Root shape

```json
{
  "schema": "blind-page-map/1.0",
  "locale": "zh-CN",
  "playerCount": {"min": 1, "max": 1},
  "sourceClasses": {},
  "title": {},
  "roles": [],
  "stages": [],
  "playerGuide": [],
  "resolution": {},
  "locations": [],
  "clues": []
}
```

`resolution` is optional. When present, it contains only reviewed ending or answer-reveal pages and a release condition. Sources in this field must be classified as `solution`; they must not also appear in `playerGuide`, role sections, or clues.

Local keys are opaque ordinals: `role-01`, `stage-01`, `location-01`, `clue-01`, `face-01`, and `section-01`. Do not derive them from story text.

## Source classifications

Every inventoried source ID must appear exactly once:

```json
"sourceClasses": {
  "src_0123456789abcdef": {
    "kind": "player_rules",
    "subject": null,
    "confidence": 1.0
  }
}
```

Kinds are `public_material`, `player_rules`, `role_book`, `clue_face`, `clue_sheet`, `host_guide`, `solution`, or `unknown`. A verified `role_book` uses a role local key as `subject`; a verified `clue_face` uses a clue local key. Every other kind uses `null`. Confidence `1.0` means the isolated worker directly reviewed the relevant source evidence; heuristic-only classifications must not use it.

## Labels

Labels contain only text and evidence:

```json
{"text": "private display label", "evidence": {"sourceId": "src_0123456789abcdef", "pageIndex": 0, "region": [0, 0, 1, 0.2], "side": "single", "readingOrder": 0}}
```

The title is always session-visible and therefore needs L1-compatible evidence. Role names choose `displayNameScope: "session"` or `"role"`. Stage labels choose `labelScope: "session"` or `"stage"`. Location labels are stage-scoped.

## Roles and sections

```json
{
  "key": "role-01",
  "slot": 1,
  "displayName": {"text": "private", "evidence": {}},
  "displayNameScope": "session",
  "introduction": [{}],
  "sections": [
    {
      "key": "section-01",
      "kind": "background",
      "stage": "stage-01",
      "order": 1,
      "pages": [{}],
      "evidence": {}
    }
  ]
}
```

`introduction` is an optional ordered list of reviewed page/crop references from `public_material`. It becomes an always-available L1 lobby profile and must not contain role-only information. Section kinds are `profile`, `background`, `timeline`, `objective`, `memory`, or `other`. Section orders are contiguous per role. Private section content is granted only to the matching role after its stage is reached.

## Stages

```json
{
  "key": "stage-01",
  "sequence": 1,
  "label": {"text": "private", "evidence": {}},
  "labelScope": "session",
  "enterWhen": {"op": "always"},
  "completeWhen": {"op": "investigation_complete", "stage": "stage-01"},
  "allowedActions": ["read_role_section", "search", "publish_clue"],
  "locations": ["location-01"],
  "evidence": {},
  "investigation": {
    "searchesPerPlayer": 1,
    "maxPrivateCount": 1,
    "blockedActions": ["vote_location", "search"],
    "completion": "consent_vote",
    "roleRestrictions": [
      {"role": "role-01", "locations": ["location-01"], "clues": []}
    ]
  }
}
```

Sequences are contiguous. `investigation` is optional. When present it deterministically enables room voting, player-selected clues in seat order, a stage-scoped per-player acquisition quota, already-investigated location exclusion, optional publication obligations, and optional role restrictions. `searchesPerPlayer` is a positive integer. `completion` and `roleRestrictions` may be omitted.

## Player guide

`playerGuide` is an ordered list of page references. Each source must be verified as `player_rules`; the compiler grants it to joined room members without widening any other source.

Physical proximity is not a visibility grant. When instructions and ending material share a directory, print packet, archive, or naming pattern, review and classify each source independently.

## End-of-game resolution

```json
"resolution": {
  "pages": [{}],
  "releaseWhen": {"op": "session_completed"}
}
```

Resolution pages stay L3 and system-only in the general content model. The application may project only the pages referenced by the matching host release, only to joined room members, and only after `releaseWhen` evaluates true. For ordinary player games, use `session_completed`; do not substitute a stage-reached or always-visible condition for convenience.

## Locations

```json
{
  "key": "location-01",
  "stage": "stage-01",
  "name": {"text": "private", "evidence": {}},
  "availableWhen": {"op": "stage_active", "stage": "stage-01"},
  "searchPolicy": {
    "mode": "fixed_sequence",
    "perPlayerLimit": null,
    "globalLimit": null,
    "resetAtStages": []
  },
  "clues": [
    {"clue": "clue-01", "order": 1, "copies": 1, "availableWhen": {"op": "always"}}
  ],
  "evidence": {}
}
```

Search modes are `draw_without_replacement`, `fixed_sequence`, `all_visible`, or `host_dealt`. Investigation-flow locations cannot use `host_dealt` and cannot have an empty pool.

## Clues

```json
{
  "key": "clue-01",
  "kind": "card",
  "faces": [
    {
      "key": "face-01",
      "side": "single",
      "pages": [{}],
      "revealWhen": {"op": "clue_held", "clue": "clue-01"},
      "evidence": {}
    }
  ],
  "pairing": {"status": "verified", "method": "review", "confidence": 1.0, "evidence": {}},
  "acquisition": {"when": {"op": "always"}},
  "publication": {
    "allowed": true,
    "publishWhen": {"op": "clue_held", "clue": "clue-01"},
    "revealedFaces": ["face-01"],
    "mandatory": false,
    "evidence": {}
  }
}
```

Clue kinds are `card`, `document`, `memory`, `item`, or `other`. Only verified `manifest` or `review` pairing is accepted. Holder and post-publication grants are generated separately; only listed faces become visible on the public clue board.

## Conditions

Conditions use local references:

- `always`, `session_completed`
- `all`/`any` with `args`; `not` with `arg`
- `stage_active`, `stage_reached`, `investigation_complete`, `completion_vote_satisfied` with `stage`
- `role_assigned` with `role`
- `clue_held`, `clue_acquired_in_room`, `clue_published` with `clue`
- `host_release` with `release`

The compiler translates local keys into opaque canonical IDs. Unknown operations or references block generation.
