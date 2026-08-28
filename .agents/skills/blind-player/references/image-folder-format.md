# Mixed Image/PDF Folder Adapter

Use this adapter for packs made of numbered JPG/PNG pages, printable clue sheets, separate card-face images, accessory art, and one or more image-only PDFs.

## Inventory before interpretation

- Capture a non-following tree snapshot, copy every regular file into an opaque per-run vault while hashing, and inspect only the fixed copy. Compare a final source-tree snapshot before committing the vault set. Any added, removed, replaced, or changed entry blocks the run; later extraction rechecks the committed vault hashes rather than reopening the mutable source directory.
- Group byte-identical duplicates without deleting either source.
- Natural-sort numeric page stems, but preserve the original path and observed order in the vault.
- Detect missing numbers, duplicate page numbers, unexpected extensions, unreadable images, encryption, and PDF page counts. Bound numeric-stem length and sequence span before integer conversion or range expansion; an excessive sequence is quarantined with a fixed code.
- Record image width, height, mode, EXIF orientation, and hash, and run a full decoder integrity check rather than trusting headers alone. Preserve originals; normalize only private derivatives.
- Treat directory and filename words as hints only. A folder that appears to mean “solution,” “role,” “front,” or “back” remains unverified.

## Typical structures to detect

- Repeated subdirectories containing a numeric page sequence often represent role packets. Detect the repeated structure without exposing subdirectory names.
- Composite printable sheets may contain multiple cards or multiple sides. One file is not necessarily one logical clue.
- Separate card images can represent a whole sheet, a face, a cover, or a combined layout. Segment by verified borders and printed identifiers.
- Accessory folders can mix public art, player references, maps, relationship diagrams, host instructions, and solution pages. Classify each file independently.
- PDFs produced by an image-conversion plug-in often have no useful text layer. Render each page privately and use OCR/vision with coordinates.

## Synthetic regression fixtures only

Never copy observations, dimensions, counts, folder patterns, or pairing characteristics from a real pack into this skill. Loading the skill must not disclose a fingerprint of any previously processed game. Regression tests use generated, content-free fixtures that exercise these generic cases:

- portrait and landscape pages, rotated text, and multi-column reading order;
- sparse and full card grids with varying row and column counts;
- logical pages embedded in a physical PDF page;
- exact duplicates, derived duplicates, and composite reuse;
- repeated identifiers that cannot be paired by position alone;
- color-dependent control regions retained in RGB;
- absent or unreliable DPI metadata, using pixel and normalized geometry instead.

Real-pack layout profiles and contact sheets belong only in that pack's vault and must never be promoted into reusable skill references, tests, logs, or chat.

## Extraction sequence

1. Build a private contact sheet containing opaque IDs only; never overlay original filenames.
2. Detect layout families by geometry, typography regions, borders, and repeated templates before reading semantics.
3. Detect logical pages inside physical PDF pages before OCR. Record both coordinate systems.
4. Detect grid occupancy and crop each card before OCR; whole-sheet OCR is not an acceptable substitute.
5. Render PDFs at sufficient resolution for Chinese text. Keep rendered pages private and map them back to the PDF source/page.
6. OCR each region and preserve raw and normalized versions separately. Do not silently repair names, dates, negation, numbers, or clue codes.
7. Identify headings, page numbers, card identifiers, stage markers, colored control blocks, and side markers as structured fields with their own confidence and evidence.
8. Cross-check repeated identifiers across print sheets, standalone faces, rules, and role packets. Visual adjacency is not proof of identity.
9. Quarantine any crop whose boundaries, reading order, pairing, or audience cannot be verified.

## Format-specific validation

- Every detected numeric sequence has an explicit first/last page and missing/duplicate count.
- Every page belongs to at most one role packet unless a verified shared-page rule exists.
- Every logical clue face has at least one source representation.
- No source region is assigned to two different logical clues without an explicit alternate-representation relation.
- A multi-card sheet has stable crop coordinates, reading order, and identifiers.
- PDF render count equals PDF page count.
- OCR coverage and minimum confidence are reported by layout family, not only as a global average.
- Printed identifiers, critical rule numbers, negation, and unlock conditions receive independent review.

Do not hardcode a player count, page count, folder language, front/back convention, or fixed number of stages from any source pack.
