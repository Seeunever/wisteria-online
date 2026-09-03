---
name: murder-mystery-html-builder
description: Use when a user provides a local folder containing 剧本杀, murder-mystery, role scripts, clue cards, PDFs, images, or an organizer manual and wants an offline interactive HTML player or shareable game package.
---

# Murder Mystery HTML Builder

## Overview

Turn a source folder into a data-driven offline game interface while preserving the original pages. The manifest is the boundary: interpret structure cautiously, then let the tested scripts generate and audit the output deterministically.

Default to `participant-safe` when the user may play. Only report 文件类型、角色数量、阶段数量、线索数量、页数、结构歧义和验证结果；不要复述剧情、秘密、解答或线索内容。

## Non-negotiable constraints

- Preserve source pages as rendered images or targeted crops. Use filenames, bookmarks, short title regions, and selected-page inspection to map structure; never full-OCR the whole game by default.
- Keep role views and stage views isolated. `guided-single` provides interface-level isolation; use `split` when unrevealed media must be physically absent from another role or stage file.
- Put clues in independent `clueGroups`, not inside role-script pages. In `split` mode, each clue group becomes an independent HTML part.
- Produce a pure offline package: no CDN, web font, remote image, analytics, server, login, or network dependency.
- Support hostless play by converting non-secret setup, round progression, clue release, and final resolution into staged `manualSteps` with neutral labels and explicit `unlockStage` values. Keep final-reveal material locked until the last intended stage.
- Do not expose participant-unsafe story text in filenames, manifests, terminal output, alt text, progress codes, or the final report.

## Workflow

1. Read [references/discovery-guide.md](references/discovery-guide.md). Inventory the folder without modifying it:
   `python scripts/inspect_sources.py <source-folder> --output <inventory.json>`
2. Establish role, stage, clue, and manual boundaries from filenames, PDF metadata/text-layer headings, then selected page inspection. Do not run full OCR by default.
3. If two mappings remain plausible, 停止生成 and ask one concise structural question. Do not resolve the ambiguity through plot interpretation.
4. Read [references/manifest-schema.md](references/manifest-schema.md), create `project.json`, and choose `guided-single` (default), `open-single`, or `split` from the user's requirements. For hostless play, map facilitation into staged `manualSteps` rather than requiring a live organizer.
5. Build with `python scripts/build_interactive.py <source-folder> <project.json> <output>`.
6. Read [references/qa-checklist.md](references/qa-checklist.md), then run `python scripts/validate_output.py <output>`. Do not present a failed audit as complete.

## Quick reference

| Need | Mode or action |
|---|---|
| One mobile-shareable file with progress | `guided-single` |
| One file with unrestricted content | `open-single` |
| Strong spoiler separation | `split` |
| User may participate | `participant-safe`; report 结构数量 only |
| User explicitly accepts spoilers | organizer reporting may summarize requested content |
| Mixed content on one page | use normalized `crop` coordinates |

## Example

User: “Use this folder to make a phone-friendly offline version; I will also play.”

Action: inventory in `participant-safe`, report only structural counts, create a guided manifest, build one HTML, audit it, and return the deliverable without plot commentary.

## Common mistakes

- Hard-coding sample role names, page counts, stages, or clue totals instead of describing them in `project.json`.
- Treating CSS-hidden content as physical separation; use `split` when stronger spoiler boundaries are requested.
- Copying full PDF text into chat or HTML when source-page images preserve fidelity.
- Guessing uncertain boundaries. A material 结构歧义 requires a focused user question.
- Relying only on `localStorage`; keep progress-code export/import available.
