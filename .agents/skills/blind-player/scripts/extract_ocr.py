#!/usr/bin/env python3
"""Extract private OCR geometry from immutable blind-player vault sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from inventory_sources import (
    PRIVATE_SCHEMA,
    _exclusive_write_bytes,
    _is_link_or_junction,
    file_identity,
    remove_owned_output,
    redirect_process_output,
)
from validate_bundle import VAULT_BLOB_REF_PATTERN, _blob_digest_and_length
from validate_safe_report import (
    SafeArgumentParser,
    load_json_no_duplicates,
    load_private_run_context,
    load_run_root_marker,
)


OCR_SCHEMA = "blind-ocr-private/1.0"
MANIFEST_RELATIVE = Path("private") / "source-inventory.json"
OUTPUT_RELATIVE = Path("vault") / "ocr.json"
LOG_RELATIVE = Path("private") / "ocr-process.log"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    tokens = list(sys.argv[1:] if argv is None else argv)
    run_root_options = sum(
        token == "--run-root" or token.startswith("--run-root=") for token in tokens
    )
    if run_root_options != 1:
        raise ValueError("ARGUMENT_ERROR")
    parser = SafeArgumentParser(description="Extract OCR into the private vault.")
    parser.add_argument("--run-root", required=True, type=Path)
    return parser.parse_args(tokens)


def fixed_artifacts(run_root: Path) -> tuple[Path, Path, Path]:
    manifest = run_root / MANIFEST_RELATIVE
    output = run_root / OUTPUT_RELATIVE
    log = run_root / LOG_RELATIVE
    for parent in (manifest.parent, output.parent, log.parent):
        if not parent.is_dir() or _is_link_or_junction(parent):
            raise ValueError("UNSAFE_OCR_LOCATION")
    for path in (manifest, output, log):
        if _is_link_or_junction(path) or path.is_dir():
            raise ValueError("UNSAFE_OCR_LOCATION")
    if not manifest.is_file():
        raise ValueError("MISSING_PRIVATE_INVENTORY")
    return manifest, output, log


def load_ocr_dependencies() -> tuple[Any, Any, Any]:
    import cv2
    import fitz
    import numpy as np
    from rapidocr import RapidOCR

    return RapidOCR, cv2, (fitz, np)


def normalized_polygon(box: Any, width: int, height: int) -> list[list[float]]:
    if width <= 0 or height <= 0:
        raise ValueError("INVALID_IMAGE_SIZE")
    points = box.tolist() if hasattr(box, "tolist") else box
    if not isinstance(points, list) or len(points) != 4:
        raise ValueError("INVALID_OCR_BOX")
    normalized: list[list[float]] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("INVALID_OCR_BOX")
        x = min(1.0, max(0.0, float(point[0]) / width))
        y = min(1.0, max(0.0, float(point[1]) / height))
        normalized.append([round(x, 6), round(y, 6)])
    return normalized


def extract_lines(engine: Any, image: Any, width: int, height: int, page_id: str) -> list[dict[str, Any]]:
    result = engine(image)
    texts = [] if result.txts is None else list(result.txts)
    scores = [] if result.scores is None else list(result.scores)
    boxes = [] if result.boxes is None else list(result.boxes)
    if not (len(texts) == len(scores) == len(boxes)):
        raise ValueError("OCR_RESULT_LENGTH_MISMATCH")
    lines: list[dict[str, Any]] = []
    for index, (text, score, box) in enumerate(zip(texts, scores, boxes)):
        if not isinstance(text, str):
            raise ValueError("INVALID_OCR_TEXT")
        token = hashlib.sha256(f"{page_id}\0{index}".encode("ascii")).hexdigest()[:16]
        lines.append(
            {
                "line_id": f"ocr_{token}",
                "order": index,
                "text": text,
                "confidence": round(float(score), 6),
                "polygon": normalized_polygon(box, width, height),
            }
        )
    return lines


def image_page(engine: Any, blob_path: Path, record: dict[str, Any]) -> dict[str, Any]:
    metadata = record.get("image")
    if not isinstance(metadata, dict) or metadata.get("metadata_status") != "ok":
        raise ValueError("IMAGE_METADATA_NOT_VERIFIED")
    width = int(metadata["width"])
    height = int(metadata["height"])
    page_id = "page_" + hashlib.sha256(
        f"{record['source_id']}\0image\00".encode("ascii")
    ).hexdigest()[:16]
    return {
        "page_id": page_id,
        "source_id": record["source_id"],
        "index": 0,
        "width": width,
        "height": height,
        "rotation": 0,
        "render_sha256": record["sha256"],
        "lines": extract_lines(engine, str(blob_path), width, height, page_id),
    }


def pdf_pages(
    engine: Any,
    blob_path: Path,
    record: dict[str, Any],
    fitz: Any,
    np: Any,
    cv2: Any,
) -> list[dict[str, Any]]:
    metadata = record.get("pdf")
    if not isinstance(metadata, dict) or metadata.get("metadata_status") != "ok":
        raise ValueError("PDF_METADATA_NOT_VERIFIED")
    document = fitz.open(stream=blob_path.read_bytes(), filetype="pdf")
    try:
        if len(document) != metadata.get("page_count"):
            raise ValueError("PDF_PAGE_COUNT_CHANGED")
        pages: list[dict[str, Any]] = []
        for index, source_page in enumerate(document):
            pixmap = source_page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            rgb = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            rendered = pixmap.tobytes("png")
            page_id = "page_" + hashlib.sha256(
                f"{record['source_id']}\0pdf\0{index}".encode("ascii")
            ).hexdigest()[:16]
            pages.append(
                {
                    "page_id": page_id,
                    "source_id": record["source_id"],
                    "index": index,
                    "width": int(pixmap.width),
                    "height": int(pixmap.height),
                    "rotation": int(source_page.rotation) % 360,
                    "render_sha256": "sha256:"
                    + hashlib.sha256(rendered).hexdigest(),
                    "lines": extract_lines(
                        engine, bgr, int(pixmap.width), int(pixmap.height), page_id
                    ),
                }
            )
        return pages
    finally:
        document.close()


def build_ocr_artifact(run_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schema") != PRIVATE_SCHEMA or not isinstance(manifest.get("sources"), list):
        raise ValueError("INVALID_PRIVATE_INVENTORY")
    RapidOCR, cv2, extra = load_ocr_dependencies()
    fitz, np = extra
    engine = RapidOCR()
    pages: list[dict[str, Any]] = []
    for record in sorted(manifest["sources"], key=lambda item: item.get("path_ref", "")):
        if not isinstance(record, dict):
            raise ValueError("INVALID_PRIVATE_INVENTORY")
        blob_ref = record.get("vault_blob_ref")
        if not isinstance(blob_ref, str) or not VAULT_BLOB_REF_PATTERN.fullmatch(blob_ref):
            raise ValueError("INVALID_VAULT_BLOB_REF")
        digest, byte_length = _blob_digest_and_length(run_root, blob_ref)
        if digest != record.get("sha256") or byte_length != record.get("byte_length"):
            raise ValueError("VAULT_COPY_MISMATCH")
        blob_path = run_root / "vault" / Path(blob_ref.removeprefix("vault:"))
        if record.get("kind") == "image":
            pages.append(image_page(engine, blob_path, record))
        elif record.get("kind") == "pdf":
            pages.extend(pdf_pages(engine, blob_path, record, fitz, np, cv2))
        else:
            raise ValueError("UNSUPPORTED_SOURCE_KIND")
    return {
        "schema": OCR_SCHEMA,
        "pack_id": manifest.get("pack_id"),
        "classification": "RAW_SECRET",
        "engine": {"name": "rapidocr", "version": "3.9.2", "backend": "onnxruntime-1.29.0"},
        "pages": pages,
    }


def _emit_failure() -> None:
    try:
        sys.stderr.write('{"code":"OCR_EXTRACTION_FAILED","status":"failed"}\n')
        sys.stderr.flush()
    except (BrokenPipeError, OSError):
        pass


def main(argv: list[str] | None = None) -> int:
    output_path: Path | None = None
    output_identity: tuple[int, int] | None = None
    try:
        args = parse_args(argv)
        run_root, marker = load_private_run_context(args.run_root)
        manifest_path, output_path, log_path = fixed_artifacts(run_root)
        with redirect_process_output(log_path):
            try:
                manifest = load_json_no_duplicates(manifest_path)
                artifact = build_ocr_artifact(run_root, manifest)
            except Exception:
                traceback.print_exc()
                raise
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        rendered = json.dumps(
            artifact,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8") + b"\n"
        output_identity = _exclusive_write_bytes(output_path, rendered)
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        acknowledgement = '{"code":"OCR_ARTIFACT_WRITTEN","status":"private"}\n'
        if sys.stdout.write(acknowledgement) != len(acknowledgement):
            raise OSError("SHORT_STDOUT_WRITE")
        sys.stdout.flush()
        return 0
    except Exception:
        remove_owned_output(output_path, output_identity is not None, output_identity)
        _emit_failure()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
