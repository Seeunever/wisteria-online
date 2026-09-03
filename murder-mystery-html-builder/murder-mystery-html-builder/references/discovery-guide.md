# Structure discovery guide

Use this guide before writing the manifest. The goal is a reliable page map, not a story summary.

## Reporting mode

Choose `participant-safe` whenever the user says they may play, asks to avoid spoilers, or has not clearly accepted spoilers. In that mode:

- Report file types, page counts, role counts, stage counts, clue counts, crop counts, ambiguities, and QA outcomes.
- Do not quote or paraphrase plot, motives, secrets, solutions, culprit identity, relationships, or clue substance.
- Use neutral temporary identifiers and do not put extracted story text in filenames or terminal output.
- Inspect only the pages or title regions needed to establish boundaries.

Use organizer reporting only after the user explicitly says story spoilers are acceptable.

## Discovery order

1. Run `scripts/inspect_sources.py` and review the structural inventory.
2. Map obvious folder and filename groupings.
3. Use PDF page counts, dimensions, bookmarks, and short text-layer prefixes.
4. Render representative covers, first pages, boundary pages, and clue sheets for visual inspection.
5. Use targeted OCR on title regions only when the prior signals are insufficient and OCR tooling is available.

Do not full-OCR every document by default. Do not decide ownership from plot meaning when a title or page boundary remains uncertain.

## Mapping decisions

| Source pattern | Preferred mapping |
|---|---|
| One PDF per role | Role from filename; stages from bookmarks, headings, or verified page ranges |
| Several roles in one PDF | Use verified page ranges; crop only mixed boundary pages |
| One page containing several cards | Create one normalized crop reference per card side |
| Front/back card sheets | Preserve ordering and pair cards structurally |
| Manual mixed with final reveal | Separate manual steps and assign unlock stages |
| Covers absent | Use a non-secret introduction page or a text-only role tile |

## Ambiguity stop condition

Stop before generation when two plausible mappings would change any role, stage, clue group, card pairing, manual reveal level, or crop boundary. Preserve the inventory and ask one focused question such as:

> “文件 A 的第 6 页与第 7 页之间是否是第二阶段的边界？只需要回答页码，不需要描述内容。”

Continue only after the mapping is reliable or the user explicitly accepts the stated assumption.

## Output choice

- Default: `guided-single`.
- Use `open-single` when all participants may directly access everything.
- Use `split` when unrevealed content must be absent from the delivered file rather than hidden by the interface.

If the single file becomes impractically large, reduce DPI or JPEG quality while retaining readable text. Changing to split output is a user-visible trade-off and should be reported.
