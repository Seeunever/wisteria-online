#!/usr/bin/env python3
"""Compile one private page map into the canonical blind bundle.

The page map and generated bundle are private artifacts. This command emits only
fixed process codes and never includes source-derived values in stdout/stderr.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from typing import Any

from PIL import Image

from validate_bundle import (
    compute_canonical_payload_hash,
    compute_source_set_hash,
    validate_bundle as validate_compiled_bundle,
)
from validate_safe_report import (
    SafeArgumentParser,
    load_json_no_duplicates,
    load_private_run_context,
)


PAGE_MAP_SCHEMA = "blind-page-map/1.0"
PRIVATE_INVENTORY_SCHEMA = "blind-private-inventory/1.0"
PAGE_MAP_RELATIVE = Path("private") / "page-map.json"
INVENTORY_RELATIVE = Path("private") / "source-inventory.json"
BUNDLE_RELATIVE = Path("vault") / "bundle.json"
PROCESS_LOG_RELATIVE = Path("private") / "page-map-build.log"
RENDERED_RELATIVE = Path("vault") / "rendered"
MAX_PAGE_MAP_BYTES = 64 * 1024 * 1024
MAX_INVENTORY_BYTES = 128 * 1024 * 1024
LOCAL_KEY = re.compile(r"^[a-z]+-[0-9]{2,6}$")
SOURCE_ID = re.compile(r"^src_[0-9a-f]{16}$")
ALLOWED_SOURCE_KINDS = {
    "public_material",
    "player_rules",
    "role_book",
    "clue_face",
    "clue_sheet",
    "host_guide",
    "solution",
    "unknown",
}
ALLOWED_SECTION_KINDS = {"profile", "background", "timeline", "objective", "memory", "other"}
ALLOWED_CLUE_KINDS = {"card", "document", "memory", "item", "other"}
ALLOWED_SIDES = {"front", "back", "single", "unknown"}
ALLOWED_SEARCH_MODES = {"draw_without_replacement", "fixed_sequence", "all_visible", "host_dealt"}
ALLOWED_ACTIONS = {"read_role_section", "search", "publish_clue"}
SOURCE_CEILING = {
    "public_material": "L1",
    "player_rules": "L1",
    "role_book": "L2",
    "clue_face": "L2",
    "clue_sheet": "L2",
    "host_guide": "L3",
    "solution": "L3",
    "unknown": "L4",
}


class PageMapError(ValueError):
    pass


def _find_pdftoppm() -> Path:
    discovered = shutil.which("pdftoppm")
    candidates = [Path(discovered)] if discovered else []
    candidates.extend(
        sorted(
            (Path.home() / ".cache" / "codex-runtimes").glob(
                "*/dependencies/native/poppler/Library/bin/pdftoppm.exe"
            )
        )
    )
    for candidate in candidates:
        try:
            metadata = candidate.lstat()
            if stat.S_ISREG(metadata.st_mode) and not candidate.is_symlink():
                return candidate.resolve(strict=True)
        except OSError:
            continue
    raise PageMapError("PDF_RENDERER_UNAVAILABLE")


def _exclusive_write_bytes(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def _render_pdf_pages(
    run_root: Path,
    blob: Path,
    source_id: str,
    page_ids: list[str],
) -> list[dict[str, Any]]:
    rendered_root = run_root / RENDERED_RELATIVE
    rendered_root.mkdir(mode=0o700, parents=False, exist_ok=True)
    scratch = run_root / "private" / f"render-{source_id}"
    scratch.mkdir(mode=0o700, parents=False, exist_ok=False)
    prefix = scratch / "page"
    try:
        result = subprocess.run(
            [str(_find_pdftoppm()), "-r", "144", "-png", str(blob), str(prefix)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=600,
            check=False,
        )
        if result.returncode != 0:
            raise PageMapError("PDF_RENDER_FAILED")
        rendered: list[dict[str, Any]] = []
        for index, page_id in enumerate(page_ids, 1):
            input_path = scratch / f"page-{index}.png"
            metadata = input_path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or input_path.is_symlink():
                raise PageMapError("PDF_RENDER_INCOMPLETE")
            with Image.open(input_path) as image:
                image.load()
                if image.width < 1 or image.height < 1 or image.width * image.height > 100_000_000:
                    raise PageMapError("PDF_RENDER_SIZE_REJECTED")
                rgb = image.convert("RGB")
                buffer = BytesIO()
                rgb.save(buffer, format="WEBP", quality=92, method=6)
                payload = buffer.getvalue()
                width, height = rgb.size
            destination = rendered_root / f"{source_id}.{page_id}.webp"
            _exclusive_write_bytes(destination, payload)
            rendered.append(
                {
                    "sourceId": source_id,
                    "pageId": page_id,
                    "mediaType": "image/webp",
                    "sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
                    "byteLength": len(payload),
                    "width": width,
                    "height": height,
                }
            )
        if len(list(scratch.glob("page-*.png"))) != len(page_ids):
            raise PageMapError("PDF_RENDER_PAGE_COUNT_MISMATCH")
        return rendered
    except (OSError, subprocess.SubprocessError) as error:
        raise PageMapError("PDF_RENDER_FAILED") from error
    finally:
        for candidate in scratch.glob("page-*.png"):
            try:
                candidate.unlink()
            except OSError:
                pass
        try:
            scratch.rmdir()
        except OSError:
            pass


def _render_image_page(
    run_root: Path,
    blob: Path,
    source_id: str,
    page_id: str,
) -> dict[str, Any]:
    rendered_root = run_root / RENDERED_RELATIVE
    rendered_root.mkdir(mode=0o700, parents=False, exist_ok=True)
    try:
        with Image.open(blob) as image:
            image.load()
            if image.width < 1 or image.height < 1 or image.width * image.height > 100_000_000:
                raise PageMapError("IMAGE_RENDER_SIZE_REJECTED")
            rgb = image.convert("RGB")
            buffer = BytesIO()
            rgb.save(buffer, format="WEBP", quality=92, method=6)
            payload = buffer.getvalue()
            width, height = rgb.size
        destination = rendered_root / f"{source_id}.{page_id}.webp"
        _exclusive_write_bytes(destination, payload)
        return {
            "sourceId": source_id,
            "pageId": page_id,
            "mediaType": "image/webp",
            "sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
            "byteLength": len(payload),
            "width": width,
            "height": height,
        }
    except OSError as error:
        raise PageMapError("IMAGE_RENDER_FAILED") from error


def _require_keys(value: Any, required: set[str], optional: set[str] | None = None) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not required.issubset(value)
        or not set(value).issubset(required | (optional or set()))
    ):
        raise PageMapError("INVALID_SHAPE")
    return value


def _require_list(value: Any, *, nonempty: bool = False) -> list[Any]:
    if not isinstance(value, list) or (nonempty and not value):
        raise PageMapError("INVALID_LIST")
    return value


def _require_text(value: Any, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise PageMapError("INVALID_TEXT")
    return value.strip()


def _require_local_key(value: Any, prefix: str) -> str:
    if not isinstance(value, str) or not value.startswith(prefix + "-") or not LOCAL_KEY.fullmatch(value):
        raise PageMapError("INVALID_LOCAL_KEY")
    return value


def _require_int(value: Any, minimum: int, maximum: int = 10**9) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise PageMapError("INVALID_INTEGER")
    return value


def _read_regular_json(path: Path, maximum: int) -> Any:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or metadata.st_size > maximum:
        raise PageMapError("PRIVATE_INPUT_REJECTED")
    return load_json_no_duplicates(path)


def _opaque_id(nonce: str, prefix: str, local_key: str) -> str:
    digest = hashlib.sha256(f"{nonce}\0{prefix}\0{local_key}".encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def _decimal_coordinate(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PageMapError("INVALID_REGION")
    try:
        decimal = Decimal(str(value))
    except InvalidOperation as error:
        raise PageMapError("INVALID_REGION") from error
    if not decimal.is_finite() or decimal < 0 or decimal > 1 or decimal.as_tuple().exponent < -6:
        raise PageMapError("INVALID_REGION")
    if decimal == 0:
        decimal = Decimal(0)
    return float(decimal)


def _vault_blob(run_root: Path, reference: Any) -> Path:
    if not isinstance(reference, str) or not reference.startswith("vault:sources/src_") or not reference.endswith(".blob"):
        raise PageMapError("INVALID_VAULT_REFERENCE")
    root = (run_root / "vault").resolve(strict=True)
    candidate = (root / reference.removeprefix("vault:")).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise PageMapError("INVALID_VAULT_REFERENCE") from error
    metadata = candidate.lstat()
    if not stat.S_ISREG(metadata.st_mode) or candidate.is_symlink():
        raise PageMapError("INVALID_VAULT_REFERENCE")
    return candidate


def _pdf_dimensions(blob: Path, expected_count: int) -> list[tuple[int, int, int]]:
    try:
        from pypdf import PdfReader

        reader = PdfReader(blob, strict=False)
        if reader.is_encrypted or len(reader.pages) != expected_count:
            raise PageMapError("PDF_PROVENANCE_MISMATCH")
        result: list[tuple[int, int, int]] = []
        for page in reader.pages:
            width = max(1, int(round(float(page.mediabox.width))))
            height = max(1, int(round(float(page.mediabox.height))))
            rotation = int(getattr(page, "rotation", 0) or 0) % 360
            if rotation not in {0, 90, 180, 270}:
                raise PageMapError("INVALID_PDF_ROTATION")
            if rotation in {90, 270}:
                width, height = height, width
            result.append((width, height, rotation))
        return result
    except PageMapError:
        raise
    except Exception as error:
        raise PageMapError("PDF_INSPECTION_FAILED") from error


def _normalize_condition(
    value: Any,
    *,
    stage_ids: dict[str, str],
    role_ids: dict[str, str],
    clue_ids: dict[str, str],
    release_ids: dict[str, str],
    depth: int = 0,
) -> dict[str, Any]:
    if depth > 20 or not isinstance(value, dict) or not isinstance(value.get("op"), str):
        raise PageMapError("INVALID_CONDITION")
    op = value["op"]
    if op in {"always", "session_completed"}:
        _require_keys(value, {"op"})
        return {"op": op}
    if op in {"all", "any"}:
        _require_keys(value, {"op", "args"})
        args = _require_list(value["args"], nonempty=True)
        return {
            "op": op,
            "args": [
                _normalize_condition(
                    item,
                    stage_ids=stage_ids,
                    role_ids=role_ids,
                    clue_ids=clue_ids,
                    release_ids=release_ids,
                    depth=depth + 1,
                )
                for item in args
            ],
        }
    if op == "not":
        _require_keys(value, {"op", "arg"})
        return {
            "op": op,
            "arg": _normalize_condition(
                value["arg"],
                stage_ids=stage_ids,
                role_ids=role_ids,
                clue_ids=clue_ids,
                release_ids=release_ids,
                depth=depth + 1,
            ),
        }
    if op in {"stage_active", "stage_reached", "investigation_complete", "completion_vote_satisfied"}:
        _require_keys(value, {"op", "stage"})
        stage = _require_local_key(value["stage"], "stage")
        if stage not in stage_ids:
            raise PageMapError("UNKNOWN_STAGE")
        return {"op": op, "stageId": stage_ids[stage]}
    if op == "role_assigned":
        _require_keys(value, {"op", "role"})
        role = _require_local_key(value["role"], "role")
        if role not in role_ids:
            raise PageMapError("UNKNOWN_ROLE")
        return {"op": op, "roleId": role_ids[role]}
    if op in {"clue_held", "clue_acquired_in_room", "clue_published"}:
        _require_keys(value, {"op", "clue"})
        clue = _require_local_key(value["clue"], "clue")
        if clue not in clue_ids:
            raise PageMapError("UNKNOWN_CLUE")
        return {"op": op, "clueId": clue_ids[clue]}
    if op == "host_release":
        _require_keys(value, {"op", "release"})
        release = _require_local_key(value["release"], "release")
        if release not in release_ids:
            raise PageMapError("UNKNOWN_RELEASE")
        return {"op": op, "releaseId": release_ids[release]}
    raise PageMapError("UNKNOWN_CONDITION")


def build_bundle(run_root: Path, *, render_media: bool = True) -> dict[str, Any]:
    root, marker = load_private_run_context(run_root)
    page_map = _read_regular_json(root / PAGE_MAP_RELATIVE, MAX_PAGE_MAP_BYTES)
    inventory = _read_regular_json(root / INVENTORY_RELATIVE, MAX_INVENTORY_BYTES)
    if not isinstance(page_map, dict) or page_map.get("schema") != PAGE_MAP_SCHEMA:
        raise PageMapError("INVALID_PAGE_MAP")
    if not isinstance(inventory, dict) or inventory.get("schema") != PRIVATE_INVENTORY_SCHEMA:
        raise PageMapError("INVALID_INVENTORY")
    _require_keys(
        page_map,
        {
            "schema",
            "locale",
            "playerCount",
            "sourceClasses",
            "title",
            "roles",
            "stages",
            "playerGuide",
            "locations",
            "clues",
        },
        {"resolution"},
    )
    nonce = marker["nonce"]
    roles_raw = _require_list(page_map["roles"], nonempty=True)
    stages_raw = _require_list(page_map["stages"], nonempty=True)
    locations_raw = _require_list(page_map["locations"])
    clues_raw = _require_list(page_map["clues"])

    role_keys = [_require_local_key(item.get("key") if isinstance(item, dict) else None, "role") for item in roles_raw]
    stage_keys = [_require_local_key(item.get("key") if isinstance(item, dict) else None, "stage") for item in stages_raw]
    location_keys = [_require_local_key(item.get("key") if isinstance(item, dict) else None, "location") for item in locations_raw]
    clue_keys = [_require_local_key(item.get("key") if isinstance(item, dict) else None, "clue") for item in clues_raw]
    if any(len(values) != len(set(values)) for values in (role_keys, stage_keys, location_keys, clue_keys)):
        raise PageMapError("DUPLICATE_LOCAL_KEY")
    role_ids = {key: _opaque_id(nonce, "role", key) for key in role_keys}
    stage_ids = {key: _opaque_id(nonce, "stage", key) for key in stage_keys}
    location_ids = {key: _opaque_id(nonce, "loc", key) for key in location_keys}
    clue_ids = {key: _opaque_id(nonce, "clue", key) for key in clue_keys}
    release_ids: dict[str, str] = {}
    resolution_raw = page_map.get("resolution")
    if resolution_raw is not None:
        release_ids["release-01"] = _opaque_id(nonce, "release", "release-01")

    source_records = _require_list(inventory.get("sources"), nonempty=True)
    inventory_by_id: dict[str, dict[str, Any]] = {}
    for record in source_records:
        if not isinstance(record, dict) or not isinstance(record.get("source_id"), str) or not SOURCE_ID.fullmatch(record["source_id"]):
            raise PageMapError("INVALID_INVENTORY_SOURCE")
        if record["source_id"] in inventory_by_id:
            raise PageMapError("DUPLICATE_INVENTORY_SOURCE")
        inventory_by_id[record["source_id"]] = record
    source_classes = page_map["sourceClasses"]
    if not isinstance(source_classes, dict) or set(source_classes) != set(inventory_by_id):
        raise PageMapError("INCOMPLETE_SOURCE_CLASSIFICATION")

    sources: dict[str, Any] = {}
    page_ids_by_source: dict[str, list[str]] = {}
    page_objects_by_source: dict[str, list[dict[str, Any]]] = {}
    source_kinds: dict[str, str] = {}
    for source_index, (source_id, record) in enumerate(inventory_by_id.items(), 1):
        classification = _require_keys(source_classes[source_id], {"kind", "subject", "confidence"})
        kind = classification["kind"]
        if kind not in ALLOWED_SOURCE_KINDS:
            raise PageMapError("INVALID_SOURCE_KIND")
        confidence = classification["confidence"]
        if confidence != 1 and confidence != 1.0:
            raise PageMapError("SOURCE_REVIEW_REQUIRED")
        subject_key = classification["subject"]
        if kind == "role_book":
            subject_key = _require_local_key(subject_key, "role")
            if subject_key not in role_ids:
                raise PageMapError("UNKNOWN_SOURCE_SUBJECT")
            subject_id = role_ids[subject_key]
        elif kind == "clue_face":
            subject_key = _require_local_key(subject_key, "clue")
            if subject_key not in clue_ids:
                raise PageMapError("UNKNOWN_SOURCE_SUBJECT")
            subject_id = clue_ids[subject_key]
        else:
            if subject_key is not None:
                raise PageMapError("INVALID_SOURCE_SUBJECT")
            subject_id = None
        source_kinds[source_id] = kind
        record_kind = record.get("kind")
        pages: list[dict[str, Any]] = []
        page_objects: list[dict[str, Any]] = []
        if record_kind == "image":
            metadata = record.get("image")
            if not isinstance(metadata, dict) or metadata.get("metadata_status") != "ok":
                raise PageMapError("IMAGE_METADATA_REQUIRED")
            dimensions = [(int(metadata["width"]), int(metadata["height"]), 0)]
        elif record_kind == "pdf":
            metadata = record.get("pdf")
            if not isinstance(metadata, dict) or metadata.get("metadata_status") != "ok" or metadata.get("encrypted") is not False:
                raise PageMapError("PDF_METADATA_REQUIRED")
            dimensions = _pdf_dimensions(_vault_blob(root, record.get("vault_blob_ref")), int(metadata["page_count"]))
        else:
            raise PageMapError("UNSUPPORTED_SOURCE")
        page_ids: list[str] = []
        for index, _dimensions in enumerate(dimensions):
            page_id = _opaque_id(nonce, "page", f"{source_id}:{index}")
            page_ids.append(page_id)
        if record_kind == "pdf" and render_media:
            page_objects = _render_pdf_pages(
                root,
                _vault_blob(root, record.get("vault_blob_ref")),
                source_id,
                page_ids,
            )
        elif record_kind == "image" and render_media:
            page_objects = [
                _render_image_page(
                    root,
                    _vault_blob(root, record.get("vault_blob_ref")),
                    source_id,
                    page_ids[0],
                )
            ]
        else:
            page_objects = [
                {
                    "sourceId": source_id,
                    "pageId": page_ids[index],
                    "mediaType": "image/webp",
                    "sha256": record["sha256"] if record_kind == "image" else (
                        "sha256:" + hashlib.sha256(
                            f"{record['sha256']}\0{index}".encode("ascii")
                        ).hexdigest()
                    ),
                    "byteLength": 1,
                    "width": width,
                    "height": height,
                }
                for index, (width, height, _rotation) in enumerate(dimensions)
            ]
        for index, (width, height, rotation) in enumerate(dimensions):
            page_id = page_ids[index]
            if record_kind == "pdf":
                width = page_objects[index]["width"]
                height = page_objects[index]["height"]
                rotation = 0
            page_hash = record["sha256"] if record_kind == "image" else (
                page_objects[index]["sha256"]
            )
            pages.append(
                {
                    "pageId": page_id,
                    "index": index,
                    "width": width,
                    "height": height,
                    "rotation": rotation,
                    "sha256": page_hash,
                }
            )
        page_ids_by_source[source_id] = page_ids
        page_objects_by_source[source_id] = page_objects
        sources[source_id] = {
            "sourceId": source_id,
            "safeLabel": f"source-{source_index:04d}",
            "originalPathRef": record.get("path_ref"),
            "mediaType": record.get("media_type"),
            "sha256": record.get("sha256"),
            "byteLength": record.get("byte_length"),
            "sourceClass": {"kind": kind, "subjectId": subject_id},
            "classification": {"status": "verified", "method": "review", "confidence": 1.0},
            "pages": pages,
        }

    assets: dict[str, Any] = {}
    asset_id_by_source: dict[str, str] = {}
    for source_id in sources:
        asset_id = _opaque_id(nonce, "asset", source_id)
        asset_id_by_source[source_id] = asset_id
        asset = {"assetId": asset_id, "sourceIds": [source_id]}
        asset["pageObjects"] = page_objects_by_source[source_id]
        assets[asset_id] = asset

    def evidence(reference: Any) -> dict[str, Any]:
        ref = _require_keys(reference, {"sourceId", "pageIndex", "region", "side", "readingOrder"})
        source_id = ref["sourceId"]
        if source_id not in sources:
            raise PageMapError("UNKNOWN_EVIDENCE_SOURCE")
        page_index = _require_int(ref["pageIndex"], 0)
        if page_index >= len(page_ids_by_source[source_id]):
            raise PageMapError("UNKNOWN_EVIDENCE_PAGE")
        region = _require_list(ref["region"])
        if len(region) != 4:
            raise PageMapError("INVALID_REGION")
        x, y, width, height = [_decimal_coordinate(item) for item in region]
        if width <= 0 or height <= 0 or Decimal(str(x)) + Decimal(str(width)) > 1 or Decimal(str(y)) + Decimal(str(height)) > 1:
            raise PageMapError("INVALID_REGION")
        side = ref["side"]
        if side not in ALLOWED_SIDES:
            raise PageMapError("INVALID_SIDE")
        return {
            "sourceId": source_id,
            "pageId": page_ids_by_source[source_id][page_index],
            "region": {"unit": "normalized", "x": x, "y": y, "width": width, "height": height},
            "side": side,
            "readingOrder": _require_int(ref["readingOrder"], 0),
        }

    content_blocks: dict[str, Any] = {}

    def add_content(
        local_key: str,
        *,
        kind: str,
        payload: dict[str, Any],
        evidence_items: list[dict[str, Any]],
        level: str,
        compartments: list[str],
        grants: list[tuple[str, str | None, dict[str, Any]]],
    ) -> str:
        content_id = _opaque_id(nonce, "cnt", local_key)
        if content_id in content_blocks or not evidence_items:
            raise PageMapError("INVALID_CONTENT")
        taints = list(dict.fromkeys(item["sourceId"] for item in evidence_items))
        asset_refs = [asset_id_by_source[source_id] for source_id in taints] if kind == "image" else []
        grant_rows = []
        for index, (principal_kind, subject_id, condition) in enumerate(grants, 1):
            grant_rows.append(
                {
                    "policyId": _opaque_id(nonce, "policy", f"{local_key}:{index}"),
                    "principal": {"kind": principal_kind, "subjectId": subject_id},
                    "when": condition,
                    "evidence": evidence_items,
                }
            )
        content_blocks[content_id] = {
            "contentId": content_id,
            "kind": kind,
            "payload": payload,
            "assetIds": asset_refs,
            "classification": {"level": level, "compartments": compartments, "taintSourceIds": taints},
            "visibility": {"default": "deny", "grants": grant_rows},
            "trace": {"evidence": evidence_items, "ocrExtractionId": None, "reviewStatus": "verified"},
        }
        return content_id

    def label_content(local_key: str, label: Any, scope: str, subject_key: str | None = None) -> str:
        value = _require_keys(label, {"text", "evidence"})
        item = evidence(value["evidence"])
        if scope == "session":
            level = "L1"
            compartments: list[str] = []
            grants = [("room_member", None, {"op": "always"})]
        elif scope == "role" and subject_key in role_ids:
            level = "L2"
            compartments = [f"role:{role_ids[subject_key]}"]
            grants = [("role_assignee", role_ids[subject_key], {"op": "always"})]
        elif scope == "stage" and subject_key in stage_ids:
            level = "L2"
            compartments = [f"stage:{stage_ids[subject_key]}"]
            grants = [("room_after_event", None, {"op": "stage_reached", "stageId": stage_ids[subject_key]})]
        else:
            raise PageMapError("INVALID_LABEL_SCOPE")
        return add_content(
            local_key,
            kind="text",
            payload={"text": _require_text(value["text"])},
            evidence_items=[item],
            level=level,
            compartments=compartments,
            grants=grants,
        )

    title_content_id = label_content("script:title", page_map["title"], "session")

    stages: dict[str, Any] = {}
    stage_rows: dict[str, dict[str, Any]] = {}
    for raw in stages_raw:
        row = _require_keys(
            raw,
            {"key", "sequence", "label", "labelScope", "enterWhen", "completeWhen", "allowedActions", "locations", "evidence"},
            {"investigation"},
        )
        key = _require_local_key(row["key"], "stage")
        stage_rows[key] = row
        label_scope = row["labelScope"]
        if label_scope not in {"session", "stage"}:
            raise PageMapError("INVALID_LABEL_SCOPE")
        label_id = label_content(f"stage:{key}:label", row["label"], label_scope, key if label_scope == "stage" else None)
        actions = _require_list(row["allowedActions"], nonempty=True)
        if len(actions) != len(set(actions)) or any(action not in ALLOWED_ACTIONS for action in actions):
            raise PageMapError("INVALID_ACTIONS")
        locations_for_stage = [_require_local_key(item, "location") for item in _require_list(row["locations"])]
        if any(item not in location_ids for item in locations_for_stage) or len(locations_for_stage) != len(set(locations_for_stage)):
            raise PageMapError("INVALID_STAGE_LOCATIONS")
        stage = {
            "stageId": stage_ids[key],
            "sequence": _require_int(row["sequence"], 1),
            "labelContentId": label_id,
            "enterWhen": _normalize_condition(row["enterWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
            "completeWhen": _normalize_condition(row["completeWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
            "allowedActions": actions,
            "locationIds": [location_ids[item] for item in locations_for_stage],
            "evidence": [evidence(row["evidence"])],
        }
        investigation = row.get("investigation")
        if investigation is not None:
            flow = _require_keys(
                investigation,
                {"maxPrivateCount", "blockedActions", "searchesPerPlayer"},
                {"roleRestrictions", "completion"},
            )
            blocked = _require_list(flow["blockedActions"], nonempty=True)
            if len(blocked) != len(set(blocked)) or any(item not in {"vote_location", "search"} for item in blocked):
                raise PageMapError("INVALID_INVESTIGATION")
            normalized_flow: dict[str, Any] = {
                "locationSelection": {"mode": "vote", "scope": "room_scoped", "resolution": "plurality_all_cast", "tieBreak": "seat_cursor_choice"},
                "turnOrder": {"mode": "seat_order"},
                "clueDeal": {"mode": "verified_pool_order", "commit": "one_per_turn"},
                "acquisitionLimit": {
                    "scope": "stage",
                    "perPlayer": _require_int(flow["searchesPerPlayer"], 1, 128),
                },
                "publicationDuty": {
                    "predicate": "round_scoped_private_holding_count",
                    "maxPrivateCount": _require_int(flow["maxPrivateCount"], 0),
                    "action": "publish_one_held",
                    "blockedActions": blocked,
                },
            }
            restrictions = flow.get("roleRestrictions")
            if restrictions is not None:
                normalized_restrictions = []
                for restriction in _require_list(restrictions):
                    item = _require_keys(restriction, {"role", "locations", "clues"})
                    role_key = _require_local_key(item["role"], "role")
                    location_refs = [_require_local_key(value, "location") for value in _require_list(item["locations"])]
                    clue_refs = [_require_local_key(value, "clue") for value in _require_list(item["clues"])]
                    if role_key not in role_ids or any(value not in location_ids for value in location_refs) or any(value not in clue_ids for value in clue_refs):
                        raise PageMapError("INVALID_INVESTIGATION_RESTRICTION")
                    normalized_restrictions.append(
                        {
                            "principalRoleId": role_ids[role_key],
                            "restrictedLocationIds": [location_ids[value] for value in location_refs],
                            "restrictedClueIds": [clue_ids[value] for value in clue_refs],
                            "mode": "deny_unless_only_remaining_eligible",
                        }
                    )
                normalized_flow["roleRestrictions"] = normalized_restrictions
            if flow.get("completion") is not None:
                if flow["completion"] != "consent_vote":
                    raise PageMapError("INVALID_INVESTIGATION_COMPLETION")
                normalized_flow["completion"] = {
                    "mode": "consent_vote",
                    "exhaustive": "per_player_quota",
                }
            stage["investigationFlow"] = normalized_flow
        stages[stage_ids[key]] = stage

    roles: dict[str, Any] = {}
    first_stage_key = min(stage_keys, key=lambda stage_key: stage_rows[stage_key]["sequence"])
    for raw in roles_raw:
        row = _require_keys(
            raw,
            {"key", "slot", "displayName", "displayNameScope", "sections"},
            {"introduction"},
        )
        key = _require_local_key(row["key"], "role")
        name_scope = row["displayNameScope"]
        if name_scope not in {"session", "role"}:
            raise PageMapError("INVALID_LABEL_SCOPE")
        display_id = label_content(f"role:{key}:name", row["displayName"], name_scope, key if name_scope == "role" else None)
        sections = []
        introduction_source_refs = row.get("introduction")
        if introduction_source_refs is None:
            introduction_source_refs = [
                _require_keys(row["displayName"], {"text", "evidence"})["evidence"]
            ]
        introduction_refs = [
            evidence(item) for item in _require_list(introduction_source_refs, nonempty=True)
        ]
        if introduction_refs:
            if any(source_kinds[item["sourceId"]] != "public_material" for item in introduction_refs):
                raise PageMapError("ROLE_INTRODUCTION_SOURCE_REJECTED")
            introduction_content_ids = [
                add_content(
                    f"role:{key}:introduction:page:{index}",
                    kind="image",
                    payload={},
                    evidence_items=[item],
                    level="L1",
                    compartments=[],
                    grants=[("room_member", None, {"op": "always"})],
                )
                for index, item in enumerate(introduction_refs, 1)
            ]
            sections.append(
                {
                    "sectionId": _opaque_id(nonce, "section", f"{key}:introduction"),
                    "kind": "profile",
                    "stageId": stage_ids[first_stage_key],
                    "order": 1,
                    "contentIds": introduction_content_ids,
                    "unlockWhen": {"op": "always"},
                    "evidence": introduction_refs,
                }
            )
        for raw_section in _require_list(row["sections"], nonempty=True):
            section = _require_keys(raw_section, {"key", "kind", "stage", "order", "pages", "evidence"})
            section_key = _require_local_key(section["key"], "section")
            stage_key = _require_local_key(section["stage"], "stage")
            if stage_key not in stage_ids or section["kind"] not in ALLOWED_SECTION_KINDS:
                raise PageMapError("INVALID_ROLE_SECTION")
            page_refs = [evidence(item) for item in _require_list(section["pages"], nonempty=True)]
            content_ids = [
                add_content(
                    f"role:{key}:section:{section_key}:page:{index}",
                    kind="image",
                    payload={},
                    evidence_items=[item],
                    level="L2",
                    compartments=[f"role:{role_ids[key]}", f"stage:{stage_ids[stage_key]}"],
                    grants=[("role_assignee", role_ids[key], {"op": "stage_reached", "stageId": stage_ids[stage_key]})],
                )
                for index, item in enumerate(page_refs, 1)
            ]
            sections.append(
                {
                    "sectionId": _opaque_id(nonce, "section", f"{key}:{section_key}"),
                    "kind": section["kind"],
                    "stageId": stage_ids[stage_key],
                    "order": _require_int(section["order"], 1) + (1 if introduction_refs else 0),
                    "contentIds": content_ids,
                    "unlockWhen": {"op": "stage_reached", "stageId": stage_ids[stage_key]},
                    "evidence": [evidence(section["evidence"])],
                }
            )
        roles[role_ids[key]] = {
            "roleId": role_ids[key],
            "slot": _require_int(row["slot"], 1, 128),
            "displayNameContentId": display_id,
            "sections": sections,
        }

    for index, raw_ref in enumerate(_require_list(page_map["playerGuide"]), 1):
        item = evidence(raw_ref)
        if source_kinds[item["sourceId"]] != "player_rules":
            raise PageMapError("PLAYER_GUIDE_SOURCE_REJECTED")
        add_content(
            f"guide:page:{index}",
            kind="image",
            payload={},
            evidence_items=[item],
            level="L1",
            compartments=[],
            grants=[("room_member", None, {"op": "always"})],
        )

    resolution_sections: list[dict[str, Any]] = []
    release_plan: list[dict[str, Any]] = []
    host_evidence: list[dict[str, Any]] = []
    if resolution_raw is not None:
        resolution = _require_keys(resolution_raw, {"pages", "releaseWhen"})
        resolution_refs = [
            evidence(item) for item in _require_list(resolution["pages"], nonempty=True)
        ]
        if any(source_kinds[item["sourceId"]] != "solution" for item in resolution_refs):
            raise PageMapError("RESOLUTION_SOURCE_REJECTED")
        release_id = release_ids["release-01"]
        release_when = _normalize_condition(
            resolution["releaseWhen"],
            stage_ids=stage_ids,
            role_ids=role_ids,
            clue_ids=clue_ids,
            release_ids=release_ids,
        )
        resolution_content_ids = [
            add_content(
                f"resolution:page:{index}",
                kind="image",
                payload={},
                evidence_items=[item],
                level="L3",
                compartments=[],
                grants=[("system_only", None, release_when)],
            )
            for index, item in enumerate(resolution_refs, 1)
        ]
        resolution_sections.append(
            {
                "sectionId": _opaque_id(nonce, "section", "resolution-01"),
                "contentIds": resolution_content_ids,
                "releaseId": release_id,
                "evidence": resolution_refs,
            }
        )
        release_plan.append(
            {
                "releaseId": release_id,
                "contentIds": resolution_content_ids,
                "when": release_when,
                "evidence": resolution_refs,
            }
        )
        host_evidence = resolution_refs

    locations: dict[str, Any] = {}
    for raw in locations_raw:
        row = _require_keys(raw, {"key", "stage", "name", "availableWhen", "searchPolicy", "clues", "evidence"})
        key = _require_local_key(row["key"], "location")
        stage_key = _require_local_key(row["stage"], "stage")
        if stage_key not in stage_ids:
            raise PageMapError("UNKNOWN_STAGE")
        name_id = label_content(f"location:{key}:name", row["name"], "stage", stage_key)
        policy = _require_keys(row["searchPolicy"], {"mode", "perPlayerLimit", "globalLimit", "resetAtStages"})
        if policy["mode"] not in ALLOWED_SEARCH_MODES:
            raise PageMapError("INVALID_SEARCH_POLICY")
        for value in (policy["perPlayerLimit"], policy["globalLimit"]):
            if value is not None:
                _require_int(value, 0)
        reset_keys = [_require_local_key(value, "stage") for value in _require_list(policy["resetAtStages"])]
        if any(value not in stage_ids for value in reset_keys):
            raise PageMapError("INVALID_SEARCH_POLICY")
        clue_pool = []
        for raw_pool in _require_list(row["clues"]):
            pool = _require_keys(raw_pool, {"clue", "order", "copies", "availableWhen"})
            clue_key = _require_local_key(pool["clue"], "clue")
            if clue_key not in clue_ids:
                raise PageMapError("UNKNOWN_CLUE")
            clue_pool.append(
                {
                    "clueId": clue_ids[clue_key],
                    "order": _require_int(pool["order"], 1),
                    "copies": _require_int(pool["copies"], 1),
                    "availableWhen": _normalize_condition(pool["availableWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
                }
            )
        locations[location_ids[key]] = {
            "locationId": location_ids[key],
            "nameContentId": name_id,
            "availableWhen": _normalize_condition(row["availableWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
            "searchPolicy": {
                "mode": policy["mode"],
                "perPlayerLimit": policy["perPlayerLimit"],
                "globalLimit": policy["globalLimit"],
                "resetAtStageIds": [stage_ids[value] for value in reset_keys],
            },
            "cluePool": clue_pool,
            "evidence": [evidence(row["evidence"])],
        }

    clues: dict[str, Any] = {}
    for raw in clues_raw:
        row = _require_keys(raw, {"key", "kind", "faces", "pairing", "acquisition", "publication"})
        key = _require_local_key(row["key"], "clue")
        if row["kind"] not in ALLOWED_CLUE_KINDS:
            raise PageMapError("INVALID_CLUE_KIND")
        publication_raw = _require_keys(row["publication"], {"allowed", "publishWhen", "revealedFaces", "mandatory", "evidence"})
        if not isinstance(publication_raw["allowed"], bool) or not isinstance(publication_raw["mandatory"], bool):
            raise PageMapError("INVALID_PUBLICATION")
        revealed_keys = [_require_local_key(value, "face") for value in _require_list(publication_raw["revealedFaces"])]
        faces = []
        local_face_ids: dict[str, str] = {}
        pending_face_content: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for raw_face in _require_list(row["faces"], nonempty=True):
            face = _require_keys(raw_face, {"key", "side", "pages", "revealWhen", "evidence"})
            face_key = _require_local_key(face["key"], "face")
            if face_key in local_face_ids or face["side"] not in ALLOWED_SIDES:
                raise PageMapError("INVALID_FACE")
            local_face_ids[face_key] = _opaque_id(nonce, "face", f"{key}:{face_key}")
            pending_face_content.append((face, [evidence(item) for item in _require_list(face["pages"], nonempty=True)]))
        if any(value not in local_face_ids for value in revealed_keys):
            raise PageMapError("UNKNOWN_REVEALED_FACE")
        for face, page_refs in pending_face_content:
            face_key = face["key"]
            content_ids = []
            for index, item in enumerate(page_refs, 1):
                grants: list[tuple[str, str | None, dict[str, Any]]] = [
                    ("clue_holder", clue_ids[key], {"op": "clue_held", "clueId": clue_ids[key]})
                ]
                if publication_raw["allowed"] and face_key in revealed_keys:
                    grants.append(("room_after_event", None, {"op": "clue_published", "clueId": clue_ids[key]}))
                content_ids.append(
                    add_content(
                        f"clue:{key}:face:{face_key}:page:{index}",
                        kind="image",
                        payload={},
                        evidence_items=[item],
                        level="L2",
                        compartments=[f"clue:{clue_ids[key]}"],
                        grants=grants,
                    )
                )
            asset_ids = list(dict.fromkeys(asset_id_by_source[item["sourceId"]] for item in page_refs))
            faces.append(
                {
                    "faceId": local_face_ids[face_key],
                    "side": face["side"],
                    "assetIds": asset_ids,
                    "contentIds": content_ids,
                    "revealWhen": _normalize_condition(face["revealWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
                    "evidence": [evidence(face["evidence"])],
                }
            )
        pairing = _require_keys(row["pairing"], {"status", "method", "confidence", "evidence"})
        if pairing["status"] != "verified" or pairing["method"] not in {"manifest", "review"} or pairing["confidence"] not in {1, 1.0}:
            raise PageMapError("PAIRING_REVIEW_REQUIRED")
        acquisition = _require_keys(row["acquisition"], {"when"})
        publication: dict[str, Any] = {
            "allowed": publication_raw["allowed"],
            "publishWhen": _normalize_condition(publication_raw["publishWhen"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
            "revealedFaceIds": [local_face_ids[value] for value in revealed_keys],
            "evidence": [evidence(publication_raw["evidence"])] if publication_raw["allowed"] else [],
        }
        if publication_raw["mandatory"]:
            publication["duty"] = {"mode": "mandatory_on_acquire"}
        clues[clue_ids[key]] = {
            "clueId": clue_ids[key],
            "kind": row["kind"],
            "faces": faces,
            "pairing": {"status": "verified", "method": pairing["method"], "confidence": 1.0, "evidence": [evidence(pairing["evidence"])]},
            "acquisition": {
                "when": _normalize_condition(acquisition["when"], stage_ids=stage_ids, role_ids=role_ids, clue_ids=clue_ids, release_ids=release_ids),
                "initialAudience": "holder",
            },
            "publication": publication,
        }

    player_count = _require_keys(page_map["playerCount"], {"min", "max"})
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    bundle: dict[str, Any] = {
        "schemaVersion": "blind-script/1.0",
        "script": {
            "scriptId": _opaque_id(nonce, "scr", "script"),
            "versionId": _opaque_id(nonce, "ver", "version"),
            "parentVersionId": None,
            "titleContentId": title_content_id,
            "locale": _require_text(page_map["locale"], 35),
            "playerCount": {
                "min": _require_int(player_count["min"], 1, 128),
                "max": _require_int(player_count["max"], 1, 128),
            },
            "state": "frozen",
            "sourceSetHash": None,
            "canonicalPayloadHash": None,
            "createdAt": now,
            "frozenAt": now,
        },
        "sources": sources,
        "assets": assets,
        "contentBlocks": content_blocks,
        "roles": roles,
        "stages": stages,
        "locations": locations,
        "clues": clues,
        "hostPack": {
            "hostPackId": _opaque_id(nonce, "host", "host"),
            "instructionContentIds": [],
            "resolutionSections": resolution_sections,
            "answerKeys": [],
            "releasePlan": release_plan,
            "evidence": host_evidence,
        },
        "policy": {"default": "deny", "conditionLanguage": "blind-ast/1.0"},
        "validation": {"profile": "blind-player/1.0"},
    }
    bundle["script"]["sourceSetHash"] = compute_source_set_hash(bundle["sources"])
    bundle["script"]["canonicalPayloadHash"] = compute_canonical_payload_hash(bundle)
    return bundle


def _exclusive_write_json(path: Path, value: Any) -> None:
    payload = (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = SafeArgumentParser(description="Build a canonical bundle from the fixed private page map.")
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--preflight", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    root: Path | None = None
    try:
        args = parse_args(argv)
        root, _marker = load_private_run_context(args.run_root)
        bundle_path = root / BUNDLE_RELATIVE
        if bundle_path.exists() and not args.preflight:
            raise PageMapError("BUNDLE_ALREADY_EXISTS")
        bundle = build_bundle(root, render_media=not args.preflight)
        if args.preflight:
            if not validate_compiled_bundle(bundle).get("freeze_ready"):
                raise PageMapError("PREFLIGHT_VALIDATION_BLOCKED")
            print('{"code":"PAGE_MAP_PREFLIGHT_OK","status":"private"}', flush=True)
            return 0
        _exclusive_write_json(bundle_path, bundle)
        print('{"code":"PAGE_BUNDLE_BUILT","status":"private"}', flush=True)
        return 0
    except Exception as error:
        error_code = str(error) if isinstance(error, PageMapError) else "INTERNAL_FAILURE"
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,80}", error_code):
            error_code = "INTERNAL_FAILURE"
        if root is not None and not getattr(locals().get("args"), "preflight", False):
            try:
                _exclusive_write_json(
                    root / PROCESS_LOG_RELATIVE,
                    {
                        "code": "PAGE_MAP_BUILD_FAILED",
                        "errorCode": error_code,
                        "errorType": type(error).__name__,
                    },
                )
            except Exception:
                pass
        print(
            json.dumps(
                {"code": "PAGE_MAP_BUILD_FAILED", "reason": error_code, "status": "failed"},
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
