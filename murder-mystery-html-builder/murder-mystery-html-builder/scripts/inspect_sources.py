from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image
from pypdf import PdfReader


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
DOCUMENT_SUFFIXES = {".docx", ".doc", ".odt", ".rtf"}
TITLE_LIMIT = 240


def _outline_titles(value: Any) -> list[str]:
    titles: list[str] = []
    if isinstance(value, list):
        for child in value:
            titles.extend(_outline_titles(child))
    else:
        title = getattr(value, "title", None)
        if isinstance(title, str) and title.strip():
            titles.append(title.strip())
    return titles


def _text_candidate(page: Any) -> str:
    try:
        text = page.extract_text() or ""
    except Exception:
        return ""
    return re.sub(r"\s+", " ", text).strip()[:TITLE_LIMIT]


def _inspect_pdf(path: Path) -> dict[str, Any]:
    try:
        reader = PdfReader(path)
        dimensions = [
            {
                "width": round(float(page.mediabox.width), 2),
                "height": round(float(page.mediabox.height), 2),
            }
            for page in reader.pages
        ]
        try:
            bookmarks = _outline_titles(reader.outline)
        except Exception:
            bookmarks = []
        return {
            "type": "pdf",
            "pageCount": len(reader.pages),
            "pageDimensions": dimensions,
            "bookmarks": bookmarks,
            "titleCandidates": [_text_candidate(page) for page in reader.pages],
        }
    except Exception as error:
        return {"type": "pdf", "error": str(error)}


def _inspect_image(path: Path) -> dict[str, Any]:
    try:
        with Image.open(path) as image:
            return {
                "type": "image",
                "width": image.width,
                "height": image.height,
                "format": image.format,
            }
    except Exception as error:
        return {"type": "image", "error": str(error)}


def inspect_folder(source_root: Path) -> dict[str, Any]:
    root = Path(source_root).resolve()
    if not root.is_dir():
        raise ValueError(f"来源文件夹不存在：{root}")
    files: list[dict[str, Any]] = []
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix().lower()):
        suffix = path.suffix.lower()
        if suffix == ".pdf":
            details = _inspect_pdf(path)
        elif suffix in IMAGE_SUFFIXES:
            details = _inspect_image(path)
        elif suffix in DOCUMENT_SUFFIXES:
            details = {"type": "document"}
        else:
            details = {"type": "other"}
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "suffix": suffix,
                "size": path.stat().st_size,
                **details,
            }
        )
    return {"sourceRoot": str(root), "fileCount": len(files), "files": files}


def main() -> None:
    parser = argparse.ArgumentParser(description="Inventory script-game source files without full OCR.")
    parser.add_argument("source_root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = inspect_folder(args.source_root)
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
        print(args.output)
    else:
        print(serialized)


if __name__ == "__main__":
    main()
