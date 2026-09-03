# QA checklist

Do not call the deliverable complete until the structural audit passes. Browser checks are proportional to the output mode and risk.

## Automated checks

Run:

```powershell
python scripts/validate_output.py <output>
```

Confirm:

- Every referenced image decodes.
- Embedded media count matches the mapped content.
- No external script, stylesheet, font, image, or media dependency exists.
- Single-file content resides in `content-data` and is created only for the current view.
- Split output contains a unique part ID per HTML file and an `index.html` entry.
- Role, stage, clue-group, card, and manual-step counts match the manifest.

## Interaction checks for single-file modes

1. Home shows every role in manifest order.
2. Role selection and switching require confirmation.
3. After selection, main navigation contains only the current-role destinations.
4. Direct navigation cannot bypass a locked stage.
5. Unlocking is sequential and persists after reload when storage works.
6. `?storage-off` shows the fallback warning and keeps the current session usable.
7. Progress export/import round-trips and rejects another content fingerprint.
8. Reset actions require confirmation.
9. Locked clue groups and manual steps create no content images.
10. Front/back cards, zoom, back links, and browser history work.

## Responsive and accessibility checks

- Test at `390 × 844` and a normal desktop viewport.
- Require `document.documentElement.scrollWidth <= innerWidth` for the page; intentional horizontal tab scrolling is allowed inside the tab strip.
- Dialog bounds stay inside the viewport.
- All controls have accessible names and visible keyboard focus.
- Images have structural alt text that does not add story content.
- Closing zoom and canceling confirmation return focus safely.

## Final spoiler-safe report

Report only:

- deliverable path and mode;
- file size and file count;
- role, stage, clue, manual-step, and crop counts;
- whether local storage fallback and progress codes are present;
- automated/browser verification outcomes;
- unresolved structural limitations.

Do not include sampled page text or plot conclusions in a participant-safe report.
