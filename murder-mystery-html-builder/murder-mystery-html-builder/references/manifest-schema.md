# Project manifest schema

The UTF-8 JSON manifest separates structural interpretation from deterministic generation. Paths are relative to the supplied source folder. IDs must be unique across roles, stages, clue groups, cards, and manual steps.

## Complete example

```json
{
  "schemaVersion": 1,
  "title": "示例游戏",
  "mode": "guided-single",
  "roles": [
    {
      "id": "role-a",
      "name": "角色甲",
      "cover": {"source": "角色封面.pdf", "page": 1},
      "stages": [
        {
          "id": "role-a-opening",
          "title": "第一阶段",
          "items": [
            {"source": "剧本/角色甲.pdf", "page": 1},
            {"source": "剧本/角色甲.pdf", "page": 2, "crop": [0, 0, 1, 0.72]}
          ]
        },
        {
          "id": "role-a-followup",
          "title": "第二阶段",
          "items": [{"source": "剧本/角色甲.pdf", "page": 3}]
        }
      ]
    }
  ],
  "clueGroups": [
    {
      "id": "round-one",
      "title": "第一轮资料",
      "unlockStage": 1,
      "cards": [
        {
          "id": "round-one-card-one",
          "label": "资料 01",
          "front": {"source": "线索/第一轮.pdf", "page": 1},
          "back": {"source": "线索/第一轮.pdf", "page": 2}
        }
      ]
    }
  ],
  "manualSteps": [
    {
      "id": "prepare",
      "title": "准备与规则",
      "unlockStage": 0,
      "items": [{"source": "组织者手册.pdf", "page": 1}]
    },
    {
      "id": "finish",
      "title": "结算流程",
      "unlockStage": 2,
      "items": [{"source": "组织者手册.pdf", "page": 2}]
    }
  ],
  "settings": {
    "progressKey": "example-game-progress",
    "dpi": 120,
    "quality": 84,
    "intro": "请选择角色，并按游戏流程共同推进。"
  }
}
```

## Fields

| Field | Required | Rules |
|---|---:|---|
| `schemaVersion` | yes | Integer `1` |
| `title` | yes | Non-empty display title |
| `mode` | yes | `guided-single`, `open-single`, or `split` |
| `roles` | yes | Non-empty ordered list |
| `roles[].id` | yes | Stable unique ID; filename-safe ASCII is recommended |
| `roles[].name` | yes | User-facing label |
| `roles[].cover` | no | Media reference |
| `roles[].stages` | yes | Non-empty ordered list; order defines unlock order |
| `roles[].stages[].items` | yes | Non-empty ordered media references |
| `clueGroups` | no | Ordered list; use `[]` when absent |
| `clueGroups[].unlockStage` | yes | Between `1` and the shortest role's stage count |
| `cards[].front` | yes | Media reference |
| `cards[].back` | no | Media reference for reveal interaction |
| `manualSteps` | no | Ordered list; use `[]` when absent |
| `manualSteps[].unlockStage` | yes | `0` means always available; otherwise no greater than the shortest role's stage count |
| `settings.progressKey` | no | Local storage namespace; default is generic |
| `settings.dpi` | no | `72`–`240`; default `120` |
| `settings.quality` | no | JPEG `50`–`95`; default `84` |
| `settings.intro` | no | Non-secret home-page instruction |

## Media reference

```json
{"source": "relative/path.pdf", "page": 3, "crop": [0.05, 0.1, 0.9, 0.8]}
```

- `source` must be a local relative path inside the source folder. URLs, absolute paths, and `..` escapes are rejected.
- PDF references require a one-based positive `page`.
- Image references omit `page`.
- `crop` is optional `[x, y, width, height]`, normalized to `0..1`. Width and height must be positive and the rectangle must remain inside the page.
- Supported images: JPEG, PNG, WebP, BMP, and TIFF.

## Mode behavior

- `guided-single`: one HTML; selection confirmation, sequential unlocks, per-role progress, and local backup.
- `open-single`: one HTML; each role begins with every stage accessible.
- `split`: an entry page plus independent role-stage, clue-group, and manual-step HTML files. The output directory must be absent or empty.

## Validation boundary

The manifest validator checks structure and source existence. PDF page-range errors are reported during rendering. Keep labels structural and spoiler-safe when the player may see the manifest or diagnostic output.
