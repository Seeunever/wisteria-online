#!/usr/bin/env python3
"""Validate a private blind-game bundle and emit only a fixed safe report."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import json
import math
import os
import re
import stat
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any

from validate_safe_report import (
    SafeArgumentParser,
    canonical_safe_bytes,
    derive_run_id,
    expected_run_id_for_schema,
    fixed_safe_report_path,
    load_json_no_duplicates,
    load_private_run_context,
    load_run_root_marker,
    reject_duplicate_pairs,
    validate_report,
)


SCHEMA_VERSION = "blind-script/1.0"
SAFE_SCHEMA = "blind-validation-safe/1.0"
TOP_LEVEL_KEYS = {
    "schemaVersion",
    "script",
    "sources",
    "assets",
    "contentBlocks",
    "roles",
    "stages",
    "locations",
    "clues",
    "hostPack",
    "policy",
    "validation",
}
ID_PATTERN = re.compile(
    r"^(?:scr|ver|src|page|asset|cnt|role|stage|loc|clue|face|host|release|policy|section|room|ocr)_[0-9a-f]{8,64}$"
)
HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
COMPARTMENT_PATTERN = re.compile(r"^(role|clue|stage):\1_[0-9a-f]{8,64}$")
LOCALE_PATTERN = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
TIMESTAMP_PATTERN = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$")
PATH_REF_PATTERN = re.compile(r"^vault:path:[0-9]{4,}$")
MEDIA_TYPES = {
    "application/pdf",
    "image/bmp",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
}
MAX_STRUCTURAL_INTEGER = 10**9
MAX_PRIVATE_INVENTORY_BYTES = 128 * 1024 * 1024
PRIVATE_INVENTORY_SCHEMA = "blind-private-inventory/1.0"
PRIVATE_INVENTORY_RELATIVE = Path("private") / "source-inventory.json"
VAULT_BLOB_REF_PATTERN = re.compile(r"^vault:sources/src_[0-9a-f]{16}\.blob$")
RENDERED_OBJECT_NAME_PATTERN = re.compile(
    r"^src_[0-9a-f]{8,64}\.page_[0-9a-f]{8,64}\.webp$"
)

LEVEL_RANK = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}
SOURCE_CEILING = {
    "public_material": 1,
    "player_rules": 1,
    "role_book": 2,
    "clue_face": 2,
    "clue_sheet": 2,
    "host_guide": 3,
    "solution": 3,
    "unknown": 4,
}
SOURCE_STATUS = {"proposed", "verified", "rejected", "quarantined"}
SOURCE_METHOD = {"manifest", "layout", "ocr", "review"}
CONTENT_REVIEW = {"unreviewed", "verified", "needs-review", "rejected"}
PAIRING_STATUS = {"unpaired", "proposed", "verified", "conflict"}
PAIRING_METHOD = {"manifest", "layout", "visual-match", "review"}
PRINCIPALS = {"room_member", "role_assignee", "clue_holder", "room_after_event", "system_only"}
PLAYER_PRINCIPALS = PRINCIPALS - {"system_only"}
SOURCE_KINDS = set(SOURCE_CEILING)
CONTENT_KINDS = {"text", "image", "mixed", "instruction", "question", "answer-key"}
ALLOWED_ACTIONS = {"read_role_section", "search", "publish_clue"}
INITIAL_AUDIENCES = {"holder"}
CONDITION_OPS = {
    "always",
    "all",
    "any",
    "not",
    "stage_active",
    "stage_reached",
    "investigation_complete",
    "completion_vote_satisfied",
    "role_assigned",
    "clue_held",
    "clue_acquired_in_room",
    "clue_published",
    "host_release",
    "session_completed",
}
INVESTIGATION_VIEWER_LOCAL_CONDITION_OPS = {"role_assigned", "clue_held"}


class Issues:
    def __init__(self) -> None:
        self._counts: Counter[tuple[str, str]] = Counter()

    def add(self, code: str, severity: str = "blocking", ref: Any = None) -> None:
        self._counts[(code, severity)] += 1

    def safe_items(self) -> list[dict[str, Any]]:
        return [
            {"code": code, "severity": severity, "count": count}
            for (code, severity), count in sorted(self._counts.items())
        ]

    def count(self, severity: str) -> int:
        return sum(count for (_, item_severity), count in self._counts.items() if item_severity == severity)


def is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", lambda: False)
    return path.is_symlink() or bool(is_junction())


def fixed_input_path(run_root: Path) -> Path:
    vault = run_root / "vault"
    bundle_path = vault / "bundle.json"
    if (
        not vault.is_dir()
        or is_link_or_junction(vault)
        or not bundle_path.is_file()
        or is_link_or_junction(bundle_path)
    ):
        raise ValueError("UNSAFE_BUNDLE_LOCATION")
    return bundle_path


def file_identity(value: os.stat_result) -> tuple[int, int]:
    return int(value.st_dev), int(value.st_ino)


def remove_owned_output(path: Path | None, ownership: bool, identity: tuple[int, int] | None) -> None:
    if not ownership or path is None:
        return
    try:
        if is_link_or_junction(path):
            return
        current = path.stat()
        if not stat.S_ISREG(current.st_mode):
            return
        if identity is not None and file_identity(current) != identity:
            return
        path.unlink()
    except (FileNotFoundError, OSError):
        pass


def _stat_signature(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def _read_regular_file_no_follow(path: Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(maximum + 1)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = path.stat()
    if (
        not stat.S_ISREG(before.st_mode)
        or _stat_signature(before) != _stat_signature(after)
        or _stat_signature(after) != _stat_signature(current)
        or len(raw) > maximum
        or is_link_or_junction(path)
    ):
        raise ValueError("PRIVATE_FILE_READ_FAILED")
    return raw


def _load_private_inventory(run_root: Path) -> dict[str, Any]:
    path = run_root / PRIVATE_INVENTORY_RELATIVE
    raw = _read_regular_file_no_follow(path, MAX_PRIVATE_INVENTORY_BYTES)
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("NON_FINITE_JSON_NUMBER")
            ),
        )
    except (UnicodeDecodeError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("INVALID_PRIVATE_INVENTORY") from error
    if not isinstance(value, dict) or value.get("schema") != PRIVATE_INVENTORY_SCHEMA:
        raise ValueError("INVALID_PRIVATE_INVENTORY")
    return value


def _blob_digest_and_length(run_root: Path, blob_ref: Any) -> tuple[str, int]:
    if not isinstance(blob_ref, str) or not VAULT_BLOB_REF_PATTERN.fullmatch(blob_ref):
        raise ValueError("INVALID_VAULT_BLOB_REF")
    relative = Path(blob_ref.removeprefix("vault:"))
    path = run_root / "vault" / relative
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or int(before.st_size) > 10**13:
            raise ValueError("PRIVATE_FILE_READ_FAILED")
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                total += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = path.stat()
    if (
        _stat_signature(before) != _stat_signature(after)
        or _stat_signature(after) != _stat_signature(current)
        or total != int(after.st_size)
        or is_link_or_junction(path)
    ):
        raise ValueError("PRIVATE_FILE_READ_FAILED")
    return "sha256:" + digest.hexdigest(), total


def _regular_digest_and_length(path: Path) -> tuple[str, int]:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or int(before.st_size) > 10**13:
            raise ValueError("PRIVATE_FILE_READ_FAILED")
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                total += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    current = path.stat()
    if (
        _stat_signature(before) != _stat_signature(after)
        or _stat_signature(after) != _stat_signature(current)
        or total != int(after.st_size)
        or is_link_or_junction(path)
    ):
        raise ValueError("PRIVATE_FILE_READ_FAILED")
    return "sha256:" + digest.hexdigest(), total


def inventory_matches_bundle(run_root: Path, bundle: Any) -> bool:
    """Fail closed unless the private manifest, vault blobs, and bundle agree."""
    try:
        manifest = _load_private_inventory(run_root)
        records = manifest.get("sources")
        bundle_sources = bundle.get("sources") if isinstance(bundle, dict) else None
        if not isinstance(records, list) or not isinstance(bundle_sources, dict):
            return False
        manifest_sources: dict[str, dict[str, Any]] = {}
        referenced_blob_names: set[str] = set()
        for record in records:
            if not isinstance(record, dict):
                return False
            source_id = record.get("source_id")
            if not isinstance(source_id, str) or source_id in manifest_sources:
                return False
            path_ref = record.get("path_ref")
            if not isinstance(path_ref, str) or not PATH_REF_PATTERN.fullmatch(path_ref):
                return False
            blob_ref = record.get("vault_blob_ref")
            digest, byte_length = _blob_digest_and_length(run_root, blob_ref)
            if digest != record.get("sha256") or byte_length != record.get("byte_length"):
                return False
            referenced_blob_names.add(Path(blob_ref).name)
            manifest_sources[source_id] = record
        if set(manifest_sources) != set(bundle_sources):
            return False
        vault_sources = run_root / "vault" / "sources"
        if not vault_sources.is_dir() or is_link_or_junction(vault_sources):
            return False
        actual_blob_names: set[str] = set()
        with os.scandir(vault_sources) as entries:
            for entry in entries:
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    return False
                actual_blob_names.add(entry.name)
        if actual_blob_names != referenced_blob_names:
            return False
        for source_id, record in manifest_sources.items():
            source = bundle_sources.get(source_id)
            if not isinstance(source, dict):
                return False
            if (
                source.get("sourceId") != source_id
                or source.get("originalPathRef") != record.get("path_ref")
                or source.get("mediaType") != record.get("media_type")
                or source.get("sha256") != record.get("sha256")
                or source.get("byteLength") != record.get("byte_length")
            ):
                return False
            pages = source.get("pages")
            if not isinstance(pages, list):
                return False
            if record.get("kind") == "image":
                metadata = record.get("image")
                if (
                    not isinstance(metadata, dict)
                    or metadata.get("metadata_status") != "ok"
                    or len(pages) != 1
                    or not isinstance(pages[0], dict)
                    or pages[0].get("sha256") != record.get("sha256")
                    or pages[0].get("width") != metadata.get("width")
                    or pages[0].get("height") != metadata.get("height")
                ):
                    return False
            elif record.get("kind") == "pdf":
                metadata = record.get("pdf")
                if (
                    not isinstance(metadata, dict)
                    or metadata.get("metadata_status") != "ok"
                    or metadata.get("encrypted") is not False
                    or len(pages) != metadata.get("page_count")
                ):
                    return False
            else:
                return False
        bundle_assets = bundle.get("assets")
        if not isinstance(bundle_assets, dict):
            return False
        expected_rendered: dict[str, dict[str, Any]] = {}
        for asset in bundle_assets.values():
            if not isinstance(asset, dict):
                return False
            page_objects = asset.get("pageObjects", [])
            if not isinstance(page_objects, list):
                return False
            for page_object in page_objects:
                if not isinstance(page_object, dict):
                    return False
                name = f"{page_object.get('sourceId')}.{page_object.get('pageId')}.webp"
                if not RENDERED_OBJECT_NAME_PATTERN.fullmatch(name) or name in expected_rendered:
                    return False
                expected_rendered[name] = page_object
        rendered_root = run_root / "vault" / "rendered"
        if expected_rendered:
            if not rendered_root.is_dir() or is_link_or_junction(rendered_root):
                return False
            actual_names: set[str] = set()
            with os.scandir(rendered_root) as entries:
                for entry in entries:
                    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                        return False
                    actual_names.add(entry.name)
            if actual_names != set(expected_rendered):
                return False
            for name, page_object in expected_rendered.items():
                digest, byte_length = _regular_digest_and_length(rendered_root / name)
                if digest != page_object.get("sha256") or byte_length != page_object.get("byteLength"):
                    return False
        elif rendered_root.exists():
            return False
        return True
    except (OSError, ValueError, OverflowError):
        return False


def add_blocking_issue(report: dict[str, Any], code: str) -> None:
    issues = report.get("issues")
    quality = report.get("quality")
    if not isinstance(issues, list) or not isinstance(quality, dict):
        raise ValueError("INVALID_SAFE_REPORT")
    for issue in issues:
        if isinstance(issue, dict) and issue.get("code") == code:
            issue["count"] = int(issue.get("count", 0)) + 1
            break
    else:
        issues.append({"code": code, "severity": "blocking", "count": 1})
    issues.sort(key=lambda item: (str(item.get("code")), str(item.get("severity"))))
    quality["blocking_issues"] = int(quality.get("blocking_issues", 0)) + 1
    report["status"] = "blocked"
    report["freeze_ready"] = False


def compute_source_set_hash(sources: Any) -> str:
    rows: list[list[Any]] = []
    if isinstance(sources, dict):
        for source_id, source in sorted(sources.items()):
            if isinstance(source, dict):
                rows.append([source_id, source.get("sha256"), source.get("byteLength")])
            else:
                rows.append([source_id, None, None])
    canonical = canonical_json(rows)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("NON_FINITE_JSON_NUMBER")
        if value == 0.0:
            return "0"
        rendered = format(Decimal(str(value)), "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return rendered
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("NON_STRING_JSON_KEY")
        return "{" + ",".join(
            f"{canonical_json(key)}:{canonical_json(value[key])}" for key in sorted(value)
        ) + "}"
    raise ValueError("NON_JSON_VALUE")


def compute_canonical_payload_hash(bundle: Any) -> str:
    normalized = copy.deepcopy(bundle) if isinstance(bundle, dict) else {}
    script = normalized.get("script")
    if isinstance(script, dict):
        script["canonicalPayloadHash"] = None
        script.pop("createdAt", None)
        script.pop("frozenAt", None)
    canonical = canonical_json(normalized)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def valid_id(value: Any, prefix: str | None = None) -> bool:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        return False
    return prefix is None or value.startswith(f"{prefix}_")


def valid_hash(value: Any) -> bool:
    return isinstance(value, str) and bool(HASH_PATTERN.fullmatch(value))


def finite_confidence(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    numeric = float(value)
    return (
        math.isfinite(numeric)
        and not (numeric == 0.0 and math.copysign(1.0, numeric) < 0.0)
        and 0.0 <= numeric <= 1.0
        and numeric == round(numeric, 6)
    )


def bounded_int(value: Any, minimum: int = 0, maximum: int = MAX_STRUCTURAL_INTEGER) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def as_map(value: Any, code: str, issues: Issues) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    issues.add(code)
    return {}


def has_exact_keys(value: Any, required: set[str], optional: set[str] | None = None) -> bool:
    if not isinstance(value, dict):
        return False
    optional = optional or set()
    keys = set(value)
    return required.issubset(keys) and keys.issubset(required | optional)


def valid_unique_refs(value: Any, allowed: set[str], require_nonempty: bool = False) -> bool:
    return (
        isinstance(value, list)
        and (bool(value) or not require_nonempty)
        and all(isinstance(item, str) and item in allowed for item in value)
        and len(value) == len(set(value))
    )


def valid_ref(value: Any, allowed: set[str]) -> bool:
    return isinstance(value, str) and value in allowed


def valid_evidence(item: Any, source_ids: set[str], page_owner: dict[str, str]) -> bool:
    if not has_exact_keys(item, {"sourceId", "pageId", "region", "side", "readingOrder"}):
        return False
    source_id = item.get("sourceId")
    if not valid_ref(source_id, source_ids):
        return False
    page_id = item.get("pageId")
    if not isinstance(page_id, str) or page_id not in page_owner or page_owner.get(page_id) != source_id:
        return False
    region = item.get("region")
    if not has_exact_keys(region, {"unit", "x", "y", "width", "height"}) or region.get("unit") != "normalized":
        return False
    coordinates = [region.get(name) for name in ("x", "y", "width", "height")]
    if not all(finite_confidence(value) for value in coordinates):
        return False
    if float(region["width"]) <= 0.0 or float(region["height"]) <= 0.0:
        return False
    if Decimal(str(region["x"])) + Decimal(str(region["width"])) > Decimal("1"):
        return False
    if Decimal(str(region["y"])) + Decimal(str(region["height"])) > Decimal("1"):
        return False
    if not isinstance(item.get("side"), str) or item.get("side") not in {"front", "back", "single", "unknown"}:
        return False
    return bounded_int(item.get("readingOrder"))


def condition_required_events(condition: Any, depth: int = 0, negated: bool = False) -> set[str]:
    if depth > 20 or not isinstance(condition, dict):
        return set()
    op = condition.get("op")
    if not isinstance(op, str):
        return set()
    if op == "not":
        return condition_required_events(condition.get("arg"), depth + 1, not negated)
    if negated:
        if op in {"all", "any"} and isinstance(condition.get("args"), list) and condition["args"]:
            effective_op = "any" if op == "all" else "all"
            child_refs = [
                condition_required_events(item, depth + 1, True) for item in condition["args"]
            ]
            if effective_op == "all":
                return set().union(*child_refs)
            result = set(child_refs[0])
            for refs in child_refs[1:]:
                result.intersection_update(refs)
            return result
        return set()
    if op in {"stage_active", "stage_reached"} and isinstance(condition.get("stageId"), str):
        return {condition["stageId"]}
    if op in {"investigation_complete", "completion_vote_satisfied"} and isinstance(
        condition.get("stageId"), str
    ):
        return {f"investigation:{condition['stageId']}"}
    if op == "host_release" and isinstance(condition.get("releaseId"), str):
        return {condition["releaseId"]}
    if op in {"clue_held", "clue_acquired_in_room"} and isinstance(condition.get("clueId"), str):
        return {f"held:{condition['clueId']}"}
    if op == "clue_published" and isinstance(condition.get("clueId"), str):
        return {f"published:{condition['clueId']}"}
    if op in {"all", "any"} and isinstance(condition.get("args"), list) and condition["args"]:
        child_refs = [condition_required_events(item, depth + 1) for item in condition["args"]]
        if op == "all":
            return set().union(*child_refs)
        result = set(child_refs[0])
        for refs in child_refs[1:]:
            result.intersection_update(refs)
        return result
    return set()


def condition_contains_ops(
    condition: Any,
    target_ops: set[str],
    depth: int = 0,
) -> bool:
    if depth > 20 or not isinstance(condition, dict):
        return False
    op = condition.get("op")
    if op in target_ops:
        return True
    if op in {"all", "any"}:
        args = condition.get("args")
        return isinstance(args, list) and any(
            condition_contains_ops(item, target_ops, depth + 1) for item in args
        )
    if op == "not":
        return condition_contains_ops(condition.get("arg"), target_ops, depth + 1)
    return False


def graph_has_cycle(graph: dict[str, set[str]]) -> bool:
    dependencies = {
        node: {dependency for dependency in refs if dependency in graph}
        for node, refs in graph.items()
    }
    dependents: dict[str, set[str]] = {node: set() for node in graph}
    for node, refs in dependencies.items():
        for dependency in refs:
            dependents[dependency].add(node)
    ready = [node for node, refs in dependencies.items() if not refs]
    visited = 0
    while ready:
        node = ready.pop()
        visited += 1
        for dependent in dependents[node]:
            dependencies[dependent].discard(node)
            if not dependencies[dependent]:
                ready.append(dependent)
    return visited != len(graph)


def validate_condition(
    condition: Any,
    issues: Issues,
    ref: str | None,
    stage_ids: set[str],
    role_ids: set[str],
    clue_ids: set[str],
    release_ids: set[str],
    depth: int = 0,
) -> bool:
    if depth > 20 or not isinstance(condition, dict):
        issues.add("INVALID_CONDITION", ref=ref)
        return False
    op = condition.get("op")
    if not isinstance(op, str) or op not in CONDITION_OPS:
        issues.add("UNKNOWN_CONDITION_OP", ref=ref)
        return False
    if op in {"always", "session_completed"}:
        if set(condition) != {"op"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        return True
    if op in {"all", "any"}:
        if set(condition) != {"op", "args"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        args = condition.get("args")
        if not isinstance(args, list) or not args:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        return all(
            validate_condition(item, issues, ref, stage_ids, role_ids, clue_ids, release_ids, depth + 1)
            for item in args
        )
    if op == "not":
        if set(condition) != {"op", "arg"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        return validate_condition(
            condition.get("arg"), issues, ref, stage_ids, role_ids, clue_ids, release_ids, depth + 1
        )
    if op in {
        "stage_active",
        "stage_reached",
        "investigation_complete",
        "completion_vote_satisfied",
    }:
        if set(condition) != {"op", "stageId"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        valid = valid_ref(condition.get("stageId"), stage_ids)
    elif op == "role_assigned":
        if set(condition) != {"op", "roleId"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        valid = valid_ref(condition.get("roleId"), role_ids)
    elif op in {"clue_held", "clue_published", "clue_acquired_in_room"}:
        if set(condition) != {"op", "clueId"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        valid = valid_ref(condition.get("clueId"), clue_ids)
    elif op == "host_release":
        if set(condition) != {"op", "releaseId"}:
            issues.add("INVALID_CONDITION", ref=ref)
            return False
        valid = valid_ref(condition.get("releaseId"), release_ids)
    else:
        valid = False
    if not valid:
        issues.add("INVALID_CONDITION_REFERENCE", ref=ref)
    return valid


def validate_bundle(bundle: Any) -> dict[str, Any]:
    issues = Issues()
    if not isinstance(bundle, dict):
        bundle = {}
        issues.add("BUNDLE_NOT_OBJECT")
    if set(bundle) != TOP_LEVEL_KEYS:
        issues.add("INVALID_TOP_LEVEL_SHAPE")
    if bundle.get("schemaVersion") != SCHEMA_VERSION:
        issues.add("SCHEMA_VERSION_MISMATCH")

    script = bundle.get("script") if isinstance(bundle.get("script"), dict) else {}
    if not has_exact_keys(
        script,
        {
            "scriptId",
            "versionId",
            "parentVersionId",
            "titleContentId",
            "locale",
            "playerCount",
            "state",
            "sourceSetHash",
            "canonicalPayloadHash",
        },
        {"createdAt", "frozenAt"},
    ):
        issues.add("INVALID_SCRIPT_SHAPE")
    script_id = script.get("scriptId")
    version_id = script.get("versionId")
    if not valid_id(script_id, "scr"):
        issues.add("INVALID_SCRIPT_ID")
    if not valid_id(version_id, "ver"):
        issues.add("INVALID_VERSION_ID")
    parent_id = script.get("parentVersionId")
    if parent_id is not None and (not valid_id(parent_id, "ver") or parent_id == version_id):
        issues.add("INVALID_PARENT_VERSION_ID")
    if not isinstance(script.get("state"), str) or script.get("state") not in {"draft", "validated", "frozen"}:
        issues.add("INVALID_VERSION_STATE", ref=version_id)
    locale = script.get("locale")
    if not isinstance(locale, str) or len(locale) > 35 or not LOCALE_PATTERN.fullmatch(locale):
        issues.add("INVALID_SCRIPT_LOCALE", ref=version_id)
    for timestamp_key in ("createdAt", "frozenAt"):
        if timestamp_key in script and not valid_timestamp(script.get(timestamp_key)):
            issues.add("INVALID_SCRIPT_TIMESTAMP", ref=version_id)
    if script.get("state") == "frozen" and not valid_timestamp(script.get("frozenAt")):
        issues.add("INVALID_SCRIPT_TIMESTAMP", ref=version_id)
    if script.get("state") != "frozen" and "frozenAt" in script:
        issues.add("INVALID_SCRIPT_TIMESTAMP", ref=version_id)
    if valid_timestamp(script.get("createdAt")) and valid_timestamp(script.get("frozenAt")):
        created_at = datetime.fromisoformat(script["createdAt"][:-1] + "+00:00")
        frozen_at = datetime.fromisoformat(script["frozenAt"][:-1] + "+00:00")
        if frozen_at < created_at:
            issues.add("INVALID_SCRIPT_TIMESTAMP", ref=version_id)
    if not valid_hash(script.get("sourceSetHash")):
        issues.add("INVALID_SOURCE_SET_HASH", ref=version_id)
    canonical_hash = script.get("canonicalPayloadHash")
    if not valid_hash(canonical_hash):
        issues.add("INVALID_CANONICAL_HASH", ref=version_id)
    player_count = script.get("playerCount")
    if not (
        isinstance(player_count, dict)
        and set(player_count) == {"min", "max"}
        and bounded_int(player_count.get("min"), 1, 128)
        and bounded_int(player_count.get("max"), 1, 128)
        and 0 < player_count["min"] <= player_count["max"]
    ):
        issues.add("INVALID_PLAYER_COUNT", ref=version_id)

    sources = as_map(bundle.get("sources"), "INVALID_SOURCES_COLLECTION", issues)
    source_ids: set[str] = set()
    page_ids: set[str] = set()
    page_owner: dict[str, str] = {}
    source_kinds: dict[str, str] = {}
    source_statuses: dict[str, str] = {}
    source_subjects: dict[str, Any] = {}
    safe_labels: set[str] = set()
    page_count = 0
    for key, source in sources.items():
        if not valid_id(key, "src") or not isinstance(source, dict) or source.get("sourceId") != key:
            issues.add("INVALID_SOURCE_ID", ref=key)
            continue
        source_ids.add(key)
        if not has_exact_keys(
            source,
            {
                "sourceId",
                "safeLabel",
                "originalPathRef",
                "mediaType",
                "sha256",
                "byteLength",
                "sourceClass",
                "classification",
                "pages",
            },
        ):
            issues.add("INVALID_SOURCE_CLASS", ref=key)
        safe_label = source.get("safeLabel")
        if not isinstance(safe_label, str) or not re.fullmatch(r"source-[0-9]{4,9}", safe_label):
            issues.add("INVALID_SAFE_LABEL", ref=key)
        elif safe_label in safe_labels:
            issues.add("DUPLICATE_SAFE_LABEL", ref=key)
        else:
            safe_labels.add(safe_label)
        if not isinstance(source.get("originalPathRef"), str) or not PATH_REF_PATTERN.fullmatch(
            source["originalPathRef"]
        ):
            issues.add("INVALID_SOURCE_PATH_REF", ref=key)
        if not isinstance(source.get("mediaType"), str) or source.get("mediaType") not in MEDIA_TYPES:
            issues.add("INVALID_SOURCE_MEDIA_TYPE", ref=key)
        if not valid_hash(source.get("sha256")):
            issues.add("INVALID_SOURCE_HASH", ref=key)
        if not bounded_int(source.get("byteLength"), 1, 10**13):
            issues.add("INVALID_SOURCE_LENGTH", ref=key)
        source_class = source.get("sourceClass") if isinstance(source.get("sourceClass"), dict) else {}
        if not has_exact_keys(source_class, {"kind", "subjectId"}):
            issues.add("INVALID_SOURCE_CLASS", ref=key)
        kind = source_class.get("kind")
        if not isinstance(kind, str) or kind not in SOURCE_KINDS:
            kind = "unknown"
            issues.add("INVALID_SOURCE_CLASS", ref=key)
        source_kinds[key] = kind
        source_subjects[key] = source_class.get("subjectId")
        classification = source.get("classification") if isinstance(source.get("classification"), dict) else {}
        if not has_exact_keys(classification, {"status", "method", "confidence"}):
            issues.add("INVALID_SOURCE_STATUS", ref=key)
        status = classification.get("status")
        source_statuses[key] = status if isinstance(status, str) and status in SOURCE_STATUS else "quarantined"
        if not isinstance(status, str) or status not in SOURCE_STATUS:
            issues.add("INVALID_SOURCE_STATUS", ref=key)
        method = classification.get("method")
        if not isinstance(method, str) or method not in SOURCE_METHOD:
            issues.add("INVALID_SOURCE_METHOD", ref=key)
        elif status == "verified" and method not in {"manifest", "review"}:
            issues.add("INVALID_SOURCE_METHOD", ref=key)
        if not finite_confidence(classification.get("confidence")):
            issues.add("INVALID_SOURCE_CONFIDENCE", ref=key)
        pages = source.get("pages")
        if not isinstance(pages, list) or not pages:
            issues.add("SOURCE_WITHOUT_PAGES", ref=key)
            continue
        indexes: set[int] = set()
        for page in pages:
            page_count += 1
            if not isinstance(page, dict) or not valid_id(page.get("pageId"), "page"):
                issues.add("INVALID_PAGE_ID", ref=key)
                continue
            page_id = page["pageId"]
            if not has_exact_keys(page, {"pageId", "index", "width", "height", "rotation", "sha256"}):
                issues.add("INVALID_PAGE_ID", ref=page_id)
            if page_id in page_ids:
                issues.add("DUPLICATE_PAGE_ID", ref=page_id)
            page_ids.add(page_id)
            page_owner[page_id] = key
            index = page.get("index")
            if not bounded_int(index) or index in indexes:
                issues.add("INVALID_PAGE_INDEX", ref=page_id)
            else:
                indexes.add(index)
            if not bounded_int(page.get("width"), 1):
                issues.add("INVALID_PAGE_SIZE", ref=page_id)
            if not bounded_int(page.get("height"), 1):
                issues.add("INVALID_PAGE_SIZE", ref=page_id)
            if not bounded_int(page.get("rotation"), 0, 270) or page.get("rotation") not in {0, 90, 180, 270}:
                issues.add("INVALID_PAGE_ROTATION", ref=page_id)
            if not valid_hash(page.get("sha256")):
                issues.add("INVALID_PAGE_HASH", ref=page_id)
        if indexes and indexes != set(range(len(pages))):
            issues.add("INVALID_PAGE_INDEX", ref=key)

    if script.get("sourceSetHash") != compute_source_set_hash(sources):
        issues.add("SOURCE_SET_HASH_MISMATCH", ref=version_id)

    assets = as_map(bundle.get("assets"), "INVALID_ASSETS_COLLECTION", issues)
    asset_ids: set[str] = set()
    asset_sources: dict[str, set[str]] = {}
    rendered_page_pairs: set[tuple[str, str]] = set()
    for key, asset in assets.items():
        if not valid_id(key, "asset") or not isinstance(asset, dict) or asset.get("assetId") != key:
            issues.add("INVALID_ASSET_ID", ref=key)
            continue
        asset_ids.add(key)
        if not has_exact_keys(asset, {"assetId", "sourceIds"}, {"pageObjects"}):
            issues.add("INVALID_ASSET_SOURCE", ref=key)
        refs = asset.get("sourceIds")
        if not valid_unique_refs(refs, source_ids, require_nonempty=True):
            issues.add("INVALID_ASSET_SOURCE", ref=key)
            asset_sources[key] = set()
        else:
            asset_sources[key] = set(refs)
        page_objects = asset.get("pageObjects", [])
        if not isinstance(page_objects, list):
            issues.add("INVALID_RENDERED_PAGE", ref=key)
            continue
        for page_object in page_objects:
            if not isinstance(page_object, dict) or not has_exact_keys(
                page_object,
                {"sourceId", "pageId", "mediaType", "sha256", "byteLength", "width", "height"},
            ):
                issues.add("INVALID_RENDERED_PAGE", ref=key)
                continue
            source_id = page_object.get("sourceId")
            page_id = page_object.get("pageId")
            if not valid_id(source_id, "src") or not valid_id(page_id, "page"):
                issues.add("INVALID_RENDERED_PAGE", ref=key)
                continue
            pair = (source_id, page_id)
            source = sources.get(source_id)
            source_pages = source.get("pages") if isinstance(source, dict) else None
            source_page = next(
                (page for page in source_pages if isinstance(page, dict) and page.get("pageId") == page_id),
                None,
            ) if isinstance(source_pages, list) else None
            if (
                source_id not in asset_sources.get(key, set())
                or pair in rendered_page_pairs
                or page_object.get("mediaType") != "image/webp"
                or not valid_hash(page_object.get("sha256"))
                or not bounded_int(page_object.get("byteLength"), 1)
                or not bounded_int(page_object.get("width"), 1)
                or not bounded_int(page_object.get("height"), 1)
                or not isinstance(source, dict)
                or not isinstance(source_page, dict)
                or source_page.get("width") != page_object.get("width")
                or source_page.get("height") != page_object.get("height")
                or source_page.get("rotation") != 0
            ):
                issues.add("INVALID_RENDERED_PAGE", ref=key)
                continue
            rendered_page_pairs.add(pair)
    expected_rendered_page_pairs = {
        (source_id, page.get("pageId"))
        for source_id, source in sources.items()
        if isinstance(source, dict)
        for page in source.get("pages", [])
        if isinstance(page, dict) and valid_id(page.get("pageId"), "page")
    }
    if rendered_page_pairs != expected_rendered_page_pairs:
        issues.add("INVALID_RENDERED_PAGE_COVERAGE")

    stages = as_map(bundle.get("stages"), "INVALID_STAGES_COLLECTION", issues)
    roles = as_map(bundle.get("roles"), "INVALID_ROLES_COLLECTION", issues)
    locations = as_map(bundle.get("locations"), "INVALID_LOCATIONS_COLLECTION", issues)
    clues = as_map(bundle.get("clues"), "INVALID_CLUES_COLLECTION", issues)
    content = as_map(bundle.get("contentBlocks"), "INVALID_CONTENT_COLLECTION", issues)
    stage_ids = {key for key in stages if valid_id(key, "stage")}
    role_ids = {key for key in roles if valid_id(key, "role")}
    location_ids = {key for key in locations if valid_id(key, "loc")}
    clue_ids = {key for key in clues if valid_id(key, "clue")}
    content_ids = {key for key in content if valid_id(key, "cnt")}
    host_pack_pre = bundle.get("hostPack") if isinstance(bundle.get("hostPack"), dict) else {}
    release_plan_pre = host_pack_pre.get("releasePlan")
    release_ids = {
        item.get("releaseId")
        for item in release_plan_pre
        if isinstance(release_plan_pre, list)
        and isinstance(item, dict)
        and valid_id(item.get("releaseId"), "release")
    } if isinstance(release_plan_pre, list) else set()
    held_event_nodes = {f"held:{clue_id}" for clue_id in clue_ids}
    published_event_nodes = {f"published:{clue_id}" for clue_id in clue_ids}
    investigation_event_nodes = {f"investigation:{stage_id}" for stage_id in stage_ids}
    known_event_nodes = (
        stage_ids
        | release_ids
        | held_event_nodes
        | published_event_nodes
        | investigation_event_nodes
    )
    tracked_condition_dependencies: list[set[str]] = []

    def validate_and_track_condition(condition: Any, ref: str | None) -> bool:
        valid = validate_condition(
            condition, issues, ref, stage_ids, role_ids, clue_ids, release_ids
        )
        tracked_condition_dependencies.append(
            condition_required_events(condition) & known_event_nodes
        )
        return valid

    for key in stages:
        if key not in stage_ids:
            issues.add("INVALID_STAGE_ID", ref=key)
    for key in roles:
        if key not in role_ids:
            issues.add("INVALID_ROLE_ID", ref=key)
    for key in locations:
        if key not in location_ids:
            issues.add("INVALID_LOCATION_ID", ref=key)
    for key in clues:
        if key not in clue_ids:
            issues.add("INVALID_CLUE_ID", ref=key)
    for key in content:
        if key not in content_ids:
            issues.add("INVALID_CONTENT_ID", ref=key)

    for source_id in source_ids:
        kind = source_kinds.get(source_id, "unknown")
        subject = source_subjects.get(source_id)
        if (
            (kind == "role_book" and not valid_ref(subject, role_ids))
            or (kind == "clue_face" and not valid_ref(subject, clue_ids))
            or (kind not in {"role_book", "clue_face"} and subject is not None)
        ):
            issues.add("INVALID_SOURCE_SUBJECT", ref=source_id)

    ocr_needs_review = 0
    quarantined = 0
    content_levels: dict[str, str] = {}
    content_asset_refs: dict[str, set[str]] = {}
    content_compartments: dict[str, set[str]] = {}
    published_face_content_by_clue: dict[str, set[str]] = {}
    for clue_id, clue in clues.items():
        if clue_id not in clue_ids or not isinstance(clue, dict):
            continue
        publication = clue.get("publication")
        if not isinstance(publication, dict) or publication.get("allowed") is not True:
            continue
        revealed_face_ids = publication.get("revealedFaceIds")
        if not isinstance(revealed_face_ids, list):
            continue
        revealed_face_id_set = {
            face_id for face_id in revealed_face_ids if isinstance(face_id, str)
        }
        published_content_ids: set[str] = set()
        faces = clue.get("faces")
        for face in faces if isinstance(faces, list) else []:
            if (
                not isinstance(face, dict)
                or face.get("faceId") not in revealed_face_id_set
            ):
                continue
            face_content_ids = face.get("contentIds")
            if isinstance(face_content_ids, list):
                published_content_ids.update(
                    content_id
                    for content_id in face_content_ids
                    if isinstance(content_id, str)
                )
        published_face_content_by_clue[clue_id] = published_content_ids
    policy_ids: set[str] = set()
    for key, block in content.items():
        if key not in content_ids or not isinstance(block, dict) or block.get("contentId") != key:
            issues.add("INVALID_CONTENT_SHAPE", ref=key)
            continue
        if not has_exact_keys(
            block,
            {"contentId", "kind", "payload", "assetIds", "classification", "visibility", "trace"},
        ):
            issues.add("INVALID_CONTENT_SHAPE", ref=key)
        kind = block.get("kind")
        if not isinstance(kind, str) or kind not in CONTENT_KINDS:
            issues.add("INVALID_CONTENT_KIND", ref=key)
        payload = block.get("payload")
        if not isinstance(payload, dict) or not set(payload).issubset({"text", "language"}):
            issues.add("INVALID_CONTENT_PAYLOAD", ref=key)
        elif (
            ("text" in payload and not isinstance(payload["text"], str))
            or ("language" in payload and not isinstance(payload["language"], str))
            or (kind != "image" and not isinstance(payload.get("text"), str))
        ):
            issues.add("INVALID_CONTENT_PAYLOAD", ref=key)
        classification = block.get("classification") if isinstance(block.get("classification"), dict) else {}
        if not has_exact_keys(classification, {"level", "compartments", "taintSourceIds"}):
            issues.add("INVALID_CONTENT_LEVEL", ref=key)
        level = classification.get("level")
        if not isinstance(level, str) or level not in LEVEL_RANK:
            level = "L4"
            issues.add("INVALID_CONTENT_LEVEL", ref=key)
        content_levels[key] = level
        if level == "L4":
            quarantined += 1
        compartments = classification.get("compartments")
        if not isinstance(compartments, list) or any(
            not isinstance(item, str) or not COMPARTMENT_PATTERN.fullmatch(item) for item in compartments
        ) or (isinstance(compartments, list) and len(compartments) != len(set(compartments))):
            issues.add("INVALID_COMPARTMENT", ref=key)
            compartments = []
        compartment_set = set(compartments)
        content_compartments[key] = compartment_set
        for compartment in compartment_set:
            compartment_kind, subject_id = compartment.split(":", 1)
            if (
                (compartment_kind == "role" and subject_id not in role_ids)
                or (compartment_kind == "clue" and subject_id not in clue_ids)
                or (compartment_kind == "stage" and subject_id not in stage_ids)
            ):
                issues.add("INVALID_COMPARTMENT_REFERENCE", ref=key)
        if level == "L2" and not compartments:
            issues.add("L2_WITHOUT_COMPARTMENT", ref=key)
        taints = classification.get("taintSourceIds")
        if not valid_unique_refs(taints, source_ids, require_nonempty=True):
            issues.add("INVALID_TAINT_SOURCE", ref=key)
            taints = []
        asset_refs = block.get("assetIds")
        if not valid_unique_refs(asset_refs, asset_ids):
            issues.add("INVALID_CONTENT_ASSET", ref=key)
            asset_refs = []
        content_asset_refs[key] = set(asset_refs)
        trace = block.get("trace") if isinstance(block.get("trace"), dict) else {}
        if not has_exact_keys(trace, {"evidence", "ocrExtractionId", "reviewStatus"}):
            issues.add("INVALID_REVIEW_STATUS", ref=key)
        ocr_id = trace.get("ocrExtractionId")
        if ocr_id is not None and not valid_id(ocr_id, "ocr"):
            issues.add("INVALID_REVIEW_STATUS", ref=key)
        evidence = trace.get("evidence")
        if not isinstance(evidence, list) or not evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in evidence
        ):
            issues.add("INVALID_CONTENT_EVIDENCE", ref=key)
            evidence = []
        taint_set = set(taints)
        if level == "L2":
            required_source_compartments = {
                f"role:{source_subjects[source_id]}"
                for source_id in taint_set
                if source_kinds.get(source_id) == "role_book"
                and valid_ref(source_subjects.get(source_id), role_ids)
            } | {
                f"clue:{source_subjects[source_id]}"
                for source_id in taint_set
                if source_kinds.get(source_id) == "clue_face"
                and valid_ref(source_subjects.get(source_id), clue_ids)
            }
            if not required_source_compartments.issubset(compartment_set):
                issues.add("TAINT_MISSING_SOURCE_COMPARTMENT", ref=key)
        asset_taints = set().union(*(asset_sources.get(asset_id, set()) for asset_id in asset_refs)) if asset_refs else set()
        evidence_taints = {
            item["sourceId"] for item in evidence if isinstance(item, dict) and item.get("sourceId") in source_ids
        }
        if not asset_taints.issubset(taint_set):
            issues.add("TAINT_MISSING_ASSET_SOURCE", ref=key)
        if not evidence_taints.issubset(taint_set):
            issues.add("TAINT_MISSING_EVIDENCE_SOURCE", ref=key)
        required_rank = 0
        for source_id in taint_set | asset_taints | evidence_taints:
            source_rank = SOURCE_CEILING.get(source_kinds.get(source_id, "unknown"), 4)
            if source_statuses.get(source_id) != "verified":
                source_rank = 4
            required_rank = max(required_rank, source_rank)
        if LEVEL_RANK[level] < required_rank:
            issues.add("VISIBILITY_EXCEEDS_SOURCE_CEILING", ref=key)
        review_status = trace.get("reviewStatus")
        if not isinstance(review_status, str) or review_status not in CONTENT_REVIEW:
            issues.add("INVALID_REVIEW_STATUS", ref=key)
        if review_status != "verified":
            ocr_needs_review += 1
            issues.add("CONTENT_REVIEW_INCOMPLETE", ref=key)
        visibility = block.get("visibility") if isinstance(block.get("visibility"), dict) else {}
        if not has_exact_keys(visibility, {"default", "grants"}):
            issues.add("INVALID_GRANTS", ref=key)
        if visibility.get("default") != "deny":
            issues.add("NON_DENY_DEFAULT", ref=key)
        grants = visibility.get("grants")
        if not isinstance(grants, list):
            issues.add("INVALID_GRANTS", ref=key)
            grants = []
        player_grants = [
            grant
            for grant in grants
            if isinstance(grant, dict)
            and isinstance(grant.get("principal"), dict)
            and isinstance(grant["principal"].get("kind"), str)
            and grant["principal"].get("kind") in PLAYER_PRINCIPALS
        ]
        if level == "L2" and not player_grants:
            issues.add("L2_WITHOUT_PLAYER_GRANT", ref=key)
        if level in {"L3", "L4"} and any(
            not isinstance(grant, dict)
            or not isinstance(grant.get("principal"), dict)
            or grant["principal"].get("kind") != "system_only"
            for grant in grants
        ):
            issues.add("HIGH_SECRET_GRANT", ref=key)
        for grant in grants:
            if not isinstance(grant, dict) or not valid_id(grant.get("policyId"), "policy"):
                issues.add("INVALID_GRANT", ref=key)
                continue
            policy_id = grant["policyId"]
            if policy_id in policy_ids:
                issues.add("DUPLICATE_POLICY_ID", ref=policy_id)
            policy_ids.add(policy_id)
            if not has_exact_keys(grant, {"policyId", "principal", "when", "evidence"}):
                issues.add("INVALID_GRANT", ref=key)
            principal = grant.get("principal") if isinstance(grant.get("principal"), dict) else {}
            if not has_exact_keys(principal, {"kind", "subjectId"}):
                issues.add("INVALID_PRINCIPAL", ref=key)
            principal_kind = principal.get("kind")
            if not isinstance(principal_kind, str) or principal_kind not in PRINCIPALS:
                issues.add("INVALID_PRINCIPAL", ref=key)
            subject_id = principal.get("subjectId")
            if (
                (principal_kind == "role_assignee" and not valid_ref(subject_id, role_ids))
                or (principal_kind == "clue_holder" and not valid_ref(subject_id, clue_ids))
                or (
                    isinstance(principal_kind, str)
                    and principal_kind in {"room_member", "room_after_event", "system_only"}
                    and subject_id is not None
                )
            ):
                issues.add("INVALID_PRINCIPAL", ref=key)
            if level == "L2" and principal_kind != "system_only":
                role_compartments = {
                    item.split(":", 1)[1] for item in compartment_set if item.startswith("role:")
                }
                clue_compartments = {
                    item.split(":", 1)[1] for item in compartment_set if item.startswith("clue:")
                }
                stage_compartments = {
                    item.split(":", 1)[1] for item in compartment_set if item.startswith("stage:")
                }
                principal_subjects = {subject_id} if isinstance(subject_id, str) else set()
                required_events = condition_required_events(grant.get("when"))
                required_stages = required_events & stage_ids
                required_published_clues = {
                    item.removeprefix("published:")
                    for item in required_events
                    if item.startswith("published:")
                }
                published_room_grant = (
                    principal_kind == "room_after_event"
                    and bool(clue_compartments)
                    and not role_compartments
                    and clue_compartments == required_published_clues
                    and all(
                        key in published_face_content_by_clue.get(clue_id, set())
                        for clue_id in clue_compartments
                    )
                )
                if (
                    principal_kind == "room_member"
                    and (role_compartments or clue_compartments or not stage_compartments)
                ) or (
                    principal_kind == "room_after_event"
                    and not published_room_grant
                    and (role_compartments or clue_compartments or not stage_compartments)
                ):
                    issues.add("COMPARTMENT_TOO_BROAD", ref=key)
                compartment_mismatch = (
                    (principal_kind == "role_assignee" and role_compartments != principal_subjects)
                    or (principal_kind == "clue_holder" and clue_compartments != principal_subjects)
                    or (bool(role_compartments) and principal_kind != "role_assignee")
                    or (
                        bool(clue_compartments)
                        and principal_kind != "clue_holder"
                        and not published_room_grant
                    )
                    or (bool(role_compartments) and bool(clue_compartments))
                    or not stage_compartments.issubset(required_stages)
                )
                if compartment_mismatch:
                    issues.add("COMPARTMENT_PRINCIPAL_MISMATCH", ref=key)
            grant_evidence = grant.get("evidence")
            if not isinstance(grant_evidence, list) or not grant_evidence or any(
                not valid_evidence(item, source_ids, page_owner) for item in grant_evidence
            ):
                issues.add("GRANT_WITHOUT_EVIDENCE", ref=key)
            elif not {item["sourceId"] for item in grant_evidence}.issubset(taint_set):
                issues.add("TAINT_MISSING_EVIDENCE_SOURCE", ref=key)
            validate_and_track_condition(grant.get("when"), key)

    sequences: set[int] = set()
    stage_sequences: dict[str, int] = {}
    condition_dependency_graph: dict[str, set[str]] = {}
    impossible_event_nodes: set[str] = set()
    for key, stage in stages.items():
        if key not in stage_ids or not isinstance(stage, dict) or stage.get("stageId") != key:
            issues.add("INVALID_STAGE_SHAPE", ref=key)
            continue
        if not has_exact_keys(
            stage,
            {
                "stageId",
                "sequence",
                "labelContentId",
                "enterWhen",
                "completeWhen",
                "allowedActions",
                "locationIds",
                "evidence",
            },
            {"investigationFlow"},
        ):
            issues.add("INVALID_STAGE_SHAPE", ref=key)
        sequence = stage.get("sequence")
        if not bounded_int(sequence, 1) or sequence in sequences:
            issues.add("INVALID_STAGE_SEQUENCE", ref=key)
        else:
            sequences.add(sequence)
            stage_sequences[key] = sequence
        stage_label_id = stage.get("labelContentId")
        if not valid_ref(stage_label_id, content_ids):
            issues.add("INVALID_STAGE_LABEL", ref=key)
        elif content_levels.get(stage_label_id) not in {"L1", "L2"} or (
            content_levels.get(stage_label_id) == "L2"
            and f"stage:{key}" not in content_compartments.get(stage_label_id, set())
        ):
            issues.add("INVALID_STAGE_LABEL", ref=key)
        stage_locations = stage.get("locationIds")
        if not valid_unique_refs(stage_locations, location_ids):
            issues.add("INVALID_STAGE_LOCATION", ref=key)
        actions = stage.get("allowedActions")
        if (
            not isinstance(actions, list)
            or any(not isinstance(action, str) for action in actions)
            or len(actions) != len(set(actions))
            or any(action not in ALLOWED_ACTIONS for action in actions)
        ):
            issues.add("INVALID_ALLOWED_ACTION", ref=key)
        investigation_flow = stage.get("investigationFlow")
        if investigation_flow is not None:
            valid_flow = has_exact_keys(
                investigation_flow,
                {
                    "locationSelection",
                    "turnOrder",
                    "clueDeal",
                    "acquisitionLimit",
                    "publicationDuty",
                },
                {"roleRestrictions", "completion"},
            )
            selection = investigation_flow.get("locationSelection") if isinstance(investigation_flow, dict) else None
            turn_order = investigation_flow.get("turnOrder") if isinstance(investigation_flow, dict) else None
            clue_deal = investigation_flow.get("clueDeal") if isinstance(investigation_flow, dict) else None
            acquisition_limit = investigation_flow.get("acquisitionLimit") \
                if isinstance(investigation_flow, dict) else None
            publication_duty = investigation_flow.get("publicationDuty") if isinstance(investigation_flow, dict) else None
            valid_flow = valid_flow and has_exact_keys(
                selection,
                {"mode", "scope", "resolution", "tieBreak"},
            ) and selection.get("mode") == "vote" and selection.get("scope") in {
                "room_scoped", "stage_scoped"
            } and selection.get("resolution") == "plurality_all_cast" \
                and selection.get("tieBreak") == "seat_cursor_choice"
            valid_flow = valid_flow and has_exact_keys(turn_order, {"mode"}) \
                and turn_order.get("mode") == "seat_order"
            valid_flow = valid_flow and has_exact_keys(clue_deal, {"mode", "commit"}) \
                and clue_deal.get("mode") == "verified_pool_order" \
                and clue_deal.get("commit") == "one_per_turn"
            valid_flow = valid_flow and has_exact_keys(acquisition_limit, {"scope", "perPlayer"}) \
                and acquisition_limit.get("scope") == "stage" \
                and bounded_int(acquisition_limit.get("perPlayer"), 1, 128)
            valid_flow = valid_flow and has_exact_keys(
                publication_duty,
                {"predicate", "maxPrivateCount", "action", "blockedActions"},
            ) and publication_duty.get("predicate") == "round_scoped_private_holding_count" \
                and bounded_int(publication_duty.get("maxPrivateCount"), 0) \
                and publication_duty.get("action") == "publish_one_held"
            blocked_actions = publication_duty.get("blockedActions") if isinstance(publication_duty, dict) else None
            valid_flow = valid_flow and isinstance(blocked_actions, list) \
                and bool(blocked_actions) \
                and len(blocked_actions) == len(set(blocked_actions)) \
                and all(action in {"vote_location", "search"} for action in blocked_actions)
            role_restrictions = investigation_flow.get("roleRestrictions") \
                if isinstance(investigation_flow, dict) else None
            if role_restrictions is not None:
                restriction_roles: set[str] = set()
                valid_restrictions = isinstance(role_restrictions, list)
                for restriction in role_restrictions if isinstance(role_restrictions, list) else []:
                    if not has_exact_keys(
                        restriction,
                        {"principalRoleId", "restrictedLocationIds", "restrictedClueIds", "mode"},
                    ):
                        valid_restrictions = False
                        continue
                    principal_role_id = restriction.get("principalRoleId")
                    restricted_locations = restriction.get("restrictedLocationIds")
                    restricted_clues = restriction.get("restrictedClueIds")
                    if (
                        not valid_ref(principal_role_id, role_ids)
                        or principal_role_id in restriction_roles
                        or not valid_unique_refs(restricted_locations, location_ids)
                        or not valid_unique_refs(restricted_clues, clue_ids)
                        or not (restricted_locations or restricted_clues)
                        or restriction.get("mode") != "deny_unless_only_remaining_eligible"
                    ):
                        valid_restrictions = False
                    if isinstance(principal_role_id, str):
                        restriction_roles.add(principal_role_id)
                valid_flow = valid_flow and valid_restrictions
            completion = investigation_flow.get("completion") \
                if isinstance(investigation_flow, dict) else None
            if completion is not None:
                valid_completion = has_exact_keys(completion, {"mode", "exhaustive"}) \
                    and completion.get("mode") == "consent_vote" \
                    and completion.get("exhaustive") == "per_player_quota" \
                    and f"investigation:{key}" in condition_required_events(
                        stage.get("completeWhen")
                    )
                valid_flow = valid_flow and valid_completion
            flow_has_host_dealt_location = any(
                isinstance(location_id, str)
                and isinstance(locations.get(location_id), dict)
                and isinstance(locations[location_id].get("searchPolicy"), dict)
                and locations[location_id]["searchPolicy"].get("mode") == "host_dealt"
                for location_id in stage_locations
            ) if isinstance(stage_locations, list) else False
            flow_has_empty_clue_pool = any(
                not isinstance(location_id, str)
                or not isinstance(locations.get(location_id), dict)
                or not isinstance(locations[location_id].get("cluePool"), list)
                or not locations[location_id]["cluePool"]
                for location_id in stage_locations
            ) if isinstance(stage_locations, list) else True
            flow_conditions: list[Any] = []
            for location_id in stage_locations if isinstance(stage_locations, list) else []:
                location = locations.get(location_id)
                if not isinstance(location, dict):
                    continue
                flow_conditions.append(location.get("availableWhen"))
                clue_pool = location.get("cluePool")
                for pool_entry in clue_pool if isinstance(clue_pool, list) else []:
                    if not isinstance(pool_entry, dict):
                        continue
                    flow_conditions.append(pool_entry.get("availableWhen"))
                    clue = clues.get(pool_entry.get("clueId"))
                    if not isinstance(clue, dict):
                        continue
                    acquisition = clue.get("acquisition")
                    if isinstance(acquisition, dict):
                        flow_conditions.append(acquisition.get("when"))
            flow_has_viewer_local_condition = any(
                condition_contains_ops(
                    condition,
                    INVESTIGATION_VIEWER_LOCAL_CONDITION_OPS,
                )
                for condition in flow_conditions
            )
            valid_flow = (
                valid_flow
                and not flow_has_host_dealt_location
                and not flow_has_empty_clue_pool
                and not flow_has_viewer_local_condition
            )
            if "search" not in (actions or []) or not stage_locations:
                valid_flow = False
            if not valid_flow:
                issues.add("INVALID_INVESTIGATION_FLOW", ref=key)
        stage_evidence = stage.get("evidence")
        if not isinstance(stage_evidence, list) or not stage_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in stage_evidence
        ):
            issues.add("INVALID_STAGE_EVIDENCE", ref=key)
        validate_and_track_condition(stage.get("enterWhen"), key)
        validate_and_track_condition(stage.get("completeWhen"), key)
        condition_dependency_graph[key] = (
            condition_required_events(stage.get("enterWhen")) & known_event_nodes
        )

    if sequences and sequences != set(range(1, len(stages) + 1)):
        issues.add("INVALID_STAGE_SEQUENCE")
    for key, dependencies in condition_dependency_graph.items():
        if key not in stage_ids:
            continue
        current_sequence = stage_sequences.get(key)
        required_stages = dependencies & stage_ids
        if current_sequence is not None and any(
            stage_sequences.get(dependency, MAX_STRUCTURAL_INTEGER) >= current_sequence
            for dependency in required_stages
        ):
            issues.add("FORWARD_STAGE_DEPENDENCY", ref=key)

    role_slots: set[int] = set()
    section_ids: set[str] = set()
    for key, role in roles.items():
        if key not in role_ids or not isinstance(role, dict) or role.get("roleId") != key:
            issues.add("INVALID_ROLE_SHAPE", ref=key)
            continue
        if not has_exact_keys(role, {"roleId", "slot", "displayNameContentId", "sections"}):
            issues.add("INVALID_ROLE_SHAPE", ref=key)
        slot = role.get("slot")
        if not bounded_int(slot, 1, 128) or slot in role_slots:
            issues.add("INVALID_ROLE_SLOT", ref=key)
        else:
            role_slots.add(slot)
        display_content_id = role.get("displayNameContentId")
        if not valid_ref(display_content_id, content_ids):
            issues.add("INVALID_ROLE_NAME", ref=key)
        elif content_levels.get(display_content_id) not in {"L1", "L2"} or (
            content_levels.get(display_content_id) == "L2"
            and f"role:{key}" not in content_compartments.get(display_content_id, set())
        ):
            issues.add("ROLE_CONTENT_COMPARTMENT_MISMATCH", ref=key)
        sections = role.get("sections")
        if not isinstance(sections, list) or not sections:
            issues.add("ROLE_WITHOUT_SECTIONS", ref=key)
            continue
        orders: set[int] = set()
        for section in sections:
            if not isinstance(section, dict) or not valid_id(section.get("sectionId"), "section"):
                issues.add("INVALID_ROLE_SECTION", ref=key)
                continue
            section_id = section["sectionId"]
            if section_id in section_ids:
                issues.add("DUPLICATE_SECTION_ID", ref=section_id)
            section_ids.add(section_id)
            if not has_exact_keys(
                section,
                {"sectionId", "kind", "stageId", "order", "contentIds", "unlockWhen", "evidence"},
            ) or not isinstance(section.get("kind"), str) or section.get("kind") not in {
                "profile", "background", "timeline", "objective", "memory", "other"
            }:
                issues.add("INVALID_ROLE_SECTION", ref=key)
            order = section.get("order")
            if not bounded_int(order, 1) or order in orders:
                issues.add("INVALID_SECTION_ORDER", ref=key)
            else:
                orders.add(order)
            if not valid_ref(section.get("stageId"), stage_ids):
                issues.add("INVALID_SECTION_STAGE", ref=key)
            section_content = section.get("contentIds")
            if not valid_unique_refs(section_content, content_ids, require_nonempty=True):
                issues.add("INVALID_SECTION_CONTENT", ref=key)
            elif any(
                content_levels.get(content_id) in {"L3", "L4"}
                or (
                    content_levels.get(content_id) == "L2"
                    and f"role:{key}" not in content_compartments.get(content_id, set())
                )
                for content_id in section_content
            ):
                issues.add("ROLE_CONTENT_COMPARTMENT_MISMATCH", ref=key)
            evidence = section.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(
                not valid_evidence(item, source_ids, page_owner) for item in evidence
            ):
                issues.add("INVALID_SECTION_EVIDENCE", ref=key)
            validate_and_track_condition(section.get("unlockWhen"), key)
        if orders and orders != set(range(1, len(sections) + 1)):
            issues.add("INVALID_SECTION_ORDER", ref=key)

    expected_slots = (
        set(range(1, player_count["max"] + 1))
        if isinstance(player_count, dict) and bounded_int(player_count.get("max"), 1, 128)
        else set()
    )
    if not expected_slots or role_slots != expected_slots or len(role_ids) != len(expected_slots):
        issues.add("INCOMPLETE_ROLE_SLOTS", ref=version_id)

    for key, location in locations.items():
        if key not in location_ids or not isinstance(location, dict) or location.get("locationId") != key:
            issues.add("INVALID_LOCATION_SHAPE", ref=key)
            continue
        if not has_exact_keys(
            location,
            {"locationId", "nameContentId", "availableWhen", "searchPolicy", "cluePool", "evidence"},
        ):
            issues.add("INVALID_LOCATION_SHAPE", ref=key)
        location_name_id = location.get("nameContentId")
        if not valid_ref(location_name_id, content_ids):
            issues.add("INVALID_LOCATION_NAME", ref=key)
        elif content_levels.get(location_name_id) not in {"L1", "L2"}:
            issues.add("INVALID_LOCATION_NAME", ref=key)
        validate_and_track_condition(location.get("availableWhen"), key)
        search_policy = location.get("searchPolicy") if isinstance(location.get("searchPolicy"), dict) else {}
        if not has_exact_keys(
            search_policy,
            {"mode", "perPlayerLimit", "globalLimit", "resetAtStageIds"},
        ):
            issues.add("INVALID_SEARCH_MODE", ref=key)
        if not isinstance(search_policy.get("mode"), str) or search_policy.get("mode") not in {
            "draw_without_replacement",
            "fixed_sequence",
            "all_visible",
            "host_dealt",
        }:
            issues.add("INVALID_SEARCH_MODE", ref=key)
        for limit_name in ("perPlayerLimit", "globalLimit"):
            limit = search_policy.get(limit_name)
            if limit is not None and not bounded_int(limit):
                issues.add("INVALID_SEARCH_MODE", ref=key)
        reset_ids = search_policy.get("resetAtStageIds")
        if not valid_unique_refs(reset_ids, stage_ids):
            issues.add("INVALID_SEARCH_MODE", ref=key)
        location_evidence = location.get("evidence")
        if not isinstance(location_evidence, list) or not location_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in location_evidence
        ):
            issues.add("INVALID_LOCATION_SHAPE", ref=key)
        clue_pool = location.get("cluePool")
        if not isinstance(clue_pool, list):
            issues.add("INVALID_CLUE_POOL", ref=key)
        else:
            pool_clues: set[str] = set()
            pool_orders: set[int] = set()
            for item in clue_pool:
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("clueId"), str)
                    or item.get("clueId") not in clue_ids
                ):
                    issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)
                    continue
                if not has_exact_keys(item, {"clueId", "order", "copies", "availableWhen"}):
                    issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)
                clue_id = item.get("clueId")
                if clue_id in pool_clues:
                    issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)
                pool_clues.add(clue_id)
                order = item.get("order")
                if order is not None and (not bounded_int(order, 1) or order in pool_orders):
                    issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)
                elif order is not None:
                    pool_orders.add(order)
                if not bounded_int(item.get("copies"), 1):
                    issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)
                validate_and_track_condition(item.get("availableWhen"), key)
            if search_policy.get("mode") == "fixed_sequence" and (
                len(pool_orders) != len(clue_pool)
                or pool_orders != set(range(1, len(clue_pool) + 1))
            ):
                issues.add("INVALID_CLUE_POOL_REFERENCE", ref=key)

    pairing_needs_review = 0
    face_ids: set[str] = set()
    for key, clue in clues.items():
        if key not in clue_ids or not isinstance(clue, dict) or clue.get("clueId") != key:
            issues.add("INVALID_CLUE_SHAPE", ref=key)
            continue
        if (
            not has_exact_keys(clue, {"clueId", "kind", "faces", "pairing", "acquisition", "publication"})
            or not isinstance(clue.get("kind"), str)
            or clue.get("kind") not in {"card", "document", "memory", "item", "other"}
        ):
            issues.add("INVALID_CLUE_SHAPE", ref=key)
        faces = clue.get("faces")
        local_face_ids: set[str] = set()
        if not isinstance(faces, list) or not faces:
            issues.add("CLUE_WITHOUT_FACES", ref=key)
        else:
            for face in faces:
                if not isinstance(face, dict) or not valid_id(face.get("faceId"), "face"):
                    issues.add("INVALID_FACE_ID", ref=key)
                    continue
                face_id = face["faceId"]
                local_face_ids.add(face_id)
                if not has_exact_keys(
                    face,
                    {"faceId", "side", "assetIds", "contentIds", "revealWhen", "evidence"},
                ):
                    issues.add("INVALID_FACE_ID", ref=face_id)
                if face_id in face_ids:
                    issues.add("DUPLICATE_FACE_ID", ref=face_id)
                face_ids.add(face_id)
                if not isinstance(face.get("side"), str) or face.get("side") not in {
                    "front", "back", "single", "unknown"
                }:
                    issues.add("INVALID_FACE_SIDE", ref=face_id)
                face_assets = face.get("assetIds")
                if not valid_unique_refs(face_assets, asset_ids, require_nonempty=True):
                    issues.add("INVALID_FACE_ASSET", ref=face_id)
                face_content = face.get("contentIds")
                if not valid_unique_refs(face_content, content_ids, require_nonempty=True):
                    issues.add("INVALID_FACE_CONTENT", ref=face_id)
                if valid_unique_refs(face_assets, asset_ids, require_nonempty=True) and valid_unique_refs(
                    face_content, content_ids, require_nonempty=True
                ):
                    gated_assets = set().union(
                        *(content_asset_refs.get(content_id, set()) for content_id in face_content)
                    ) if face_content else set()
                    if not set(face_assets).issubset(gated_assets):
                        issues.add("INVALID_FACE_ASSET", ref=face_id)
                    if any(
                        content_levels.get(content_id) == "L2"
                        and f"clue:{key}" not in content_compartments.get(content_id, set())
                        for content_id in face_content
                    ):
                        issues.add("COMPARTMENT_PRINCIPAL_MISMATCH", ref=face_id)
                evidence = face.get("evidence")
                if not isinstance(evidence, list) or not evidence or any(
                    not valid_evidence(item, source_ids, page_owner) for item in evidence
                ):
                    issues.add("INVALID_FACE_EVIDENCE", ref=face_id)
                validate_and_track_condition(face.get("revealWhen"), face_id)
        pairing = clue.get("pairing") if isinstance(clue.get("pairing"), dict) else {}
        if not has_exact_keys(pairing, {"status", "method", "confidence", "evidence"}):
            issues.add("INVALID_PAIRING_STATUS", ref=key)
        if not isinstance(pairing.get("status"), str) or pairing.get("status") not in PAIRING_STATUS:
            issues.add("INVALID_PAIRING_STATUS", ref=key)
        if not isinstance(pairing.get("method"), str) or pairing.get("method") not in PAIRING_METHOD:
            issues.add("INVALID_PAIRING_METHOD", ref=key)
        if not finite_confidence(pairing.get("confidence")):
            issues.add("INVALID_PAIRING_CONFIDENCE", ref=key)
        if pairing.get("status") != "verified":
            pairing_needs_review += 1
            issues.add("PAIRING_UNVERIFIED", ref=key)
        pairing_evidence = pairing.get("evidence")
        if not isinstance(pairing_evidence, list) or not pairing_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in pairing_evidence
        ):
            issues.add("INVALID_PAIRING_EVIDENCE", ref=key)
        acquisition = clue.get("acquisition") if isinstance(clue.get("acquisition"), dict) else {}
        if (
            not has_exact_keys(acquisition, {"when", "initialAudience"})
            or not isinstance(acquisition.get("initialAudience"), str)
            or acquisition.get("initialAudience") not in INITIAL_AUDIENCES
        ):
            issues.add("INVALID_ACQUISITION", ref=key)
        validate_and_track_condition(acquisition.get("when"), key)
        publication = clue.get("publication") if isinstance(clue.get("publication"), dict) else {}
        if not has_exact_keys(
            publication,
            {"allowed", "publishWhen", "revealedFaceIds", "evidence"},
            {"duty"},
        ) or not isinstance(
            publication.get("allowed"), bool
        ):
            issues.add("INVALID_PUBLICATION", ref=key)
        validate_and_track_condition(publication.get("publishWhen"), key)
        condition_dependency_graph[f"held:{key}"] = (
            condition_required_events(acquisition.get("when")) & known_event_nodes
        )
        condition_dependency_graph[f"published:{key}"] = (
            condition_required_events(publication.get("publishWhen")) & known_event_nodes
        )
        if publication.get("allowed") is not True:
            impossible_event_nodes.add(f"published:{key}")
        revealed_faces = publication.get("revealedFaceIds")
        if not valid_unique_refs(revealed_faces, local_face_ids) or (
            publication.get("allowed") is False and bool(revealed_faces)
        ):
            issues.add("INVALID_REVEALED_FACE", ref=key)
        duty = publication.get("duty")
        if duty is not None and (
            not has_exact_keys(duty, {"mode"})
            or duty.get("mode") != "mandatory_on_acquire"
            or publication.get("allowed") is not True
            or not revealed_faces
        ):
            issues.add("INVALID_PUBLICATION_DUTY", ref=key)
        publication_evidence = publication.get("evidence")
        if not isinstance(publication_evidence, list) or any(
            not valid_evidence(item, source_ids, page_owner) for item in publication_evidence
        ) or (publication.get("allowed") and not publication_evidence):
            issues.add("INVALID_PUBLICATION", ref=key)

    title_content_id = script.get("titleContentId")
    if not valid_ref(title_content_id, content_ids) or content_levels.get(title_content_id) != "L1":
        issues.add("INVALID_SCRIPT_TITLE", ref=version_id)

    policy = bundle.get("policy")
    if not has_exact_keys(policy, {"default", "conditionLanguage"}) or policy.get("default") != "deny" or policy.get(
        "conditionLanguage"
    ) != "blind-ast/1.0":
        issues.add("INVALID_POLICY", ref=version_id)

    validation_profile = bundle.get("validation")
    if not has_exact_keys(validation_profile, {"profile"}) or validation_profile.get(
        "profile"
    ) != "blind-player/1.0":
        issues.add("INVALID_VALIDATION_PROFILE", ref=version_id)

    host_pack = bundle.get("hostPack") if isinstance(bundle.get("hostPack"), dict) else {}
    if not has_exact_keys(
        host_pack,
        {
            "hostPackId",
            "instructionContentIds",
            "resolutionSections",
            "answerKeys",
            "releasePlan",
            "evidence",
        },
    ) or not valid_id(host_pack.get("hostPackId"), "host"):
        issues.add("INVALID_HOST_PACK")

    def validate_host_content(refs: Any, ref: Any = None, allow_empty: bool = False) -> None:
        if not valid_unique_refs(refs, content_ids, require_nonempty=not allow_empty):
            issues.add("INVALID_HOST_CONTENT", ref=ref)
            return
        for content_id in refs:
            if content_levels.get(content_id) != "L3":
                issues.add("HOST_CONTENT_NOT_L3", ref=content_id)

    validate_host_content(
        host_pack.get("instructionContentIds", []), host_pack.get("hostPackId"), allow_empty=True
    )
    host_has_material = bool(host_pack.get("instructionContentIds"))
    resolution_sections = host_pack.get("resolutionSections")
    if not isinstance(resolution_sections, list):
        issues.add("INVALID_HOST_PACK")
        resolution_sections = []
    for section in resolution_sections:
        if not has_exact_keys(section, {"sectionId", "contentIds", "releaseId", "evidence"}) or not valid_id(
            section.get("sectionId"), "section"
        ):
            issues.add("INVALID_HOST_PACK")
            continue
        if section["sectionId"] in section_ids:
            issues.add("DUPLICATE_SECTION_ID", ref=section["sectionId"])
        section_ids.add(section["sectionId"])
        host_has_material = True
        validate_host_content(section.get("contentIds"), section.get("sectionId"))
        release_id = section.get("releaseId")
        if release_id is not None and (
            not valid_id(release_id, "release") or release_id not in release_ids
        ):
            issues.add("INVALID_HOST_PACK", ref=section.get("sectionId"))
        section_evidence = section.get("evidence")
        if not isinstance(section_evidence, list) or not section_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in section_evidence
        ):
            issues.add("INVALID_HOST_PACK", ref=section.get("sectionId"))

    answer_keys = host_pack.get("answerKeys")
    if not isinstance(answer_keys, list):
        issues.add("INVALID_HOST_PACK")
        answer_keys = []
    for answer in answer_keys:
        if not has_exact_keys(
            answer,
            {"questionContentId", "acceptedContentIds", "scoringPolicy", "evidence"},
        ) or not isinstance(answer.get("scoringPolicy"), str) or answer.get("scoringPolicy") not in {
            "exact", "set", "custom"
        }:
            issues.add("INVALID_HOST_PACK")
            continue
        host_has_material = True
        validate_host_content([answer.get("questionContentId")])
        validate_host_content(answer.get("acceptedContentIds"))
        answer_evidence = answer.get("evidence")
        if not isinstance(answer_evidence, list) or not answer_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in answer_evidence
        ):
            issues.add("INVALID_HOST_PACK")

    release_plan = host_pack.get("releasePlan")
    if not isinstance(release_plan, list):
        issues.add("INVALID_HOST_PACK")
        release_plan = []
    seen_release_ids: set[str] = set()
    for release in release_plan:
        if not has_exact_keys(release, {"releaseId", "contentIds", "when", "evidence"}) or not valid_id(
            release.get("releaseId"), "release"
        ):
            issues.add("INVALID_HOST_PACK")
            continue
        release_id = release["releaseId"]
        if release_id in seen_release_ids:
            issues.add("DUPLICATE_RELEASE_ID", ref=release_id)
        seen_release_ids.add(release_id)
        host_has_material = True
        validate_host_content(release.get("contentIds"), release_id)
        validate_and_track_condition(release.get("when"), release_id)
        condition_dependency_graph[release_id] = (
            condition_required_events(release.get("when")) & known_event_nodes
        )
        release_evidence = release.get("evidence")
        if not isinstance(release_evidence, list) or not release_evidence or any(
            not valid_evidence(item, source_ids, page_owner) for item in release_evidence
        ):
            issues.add("INVALID_HOST_PACK", ref=release.get("releaseId"))

    if graph_has_cycle(condition_dependency_graph):
        issues.add("CYCLIC_CONDITION_DEPENDENCY")
    if any(
        dependencies & impossible_event_nodes
        for dependencies in tracked_condition_dependencies
    ):
        issues.add("IMPOSSIBLE_CONDITION_DEPENDENCY")

    host_evidence = host_pack.get("evidence")
    if not isinstance(host_evidence, list) or any(
        not valid_evidence(item, source_ids, page_owner) for item in host_evidence
    ) or (host_has_material and not host_evidence):
        issues.add("INVALID_HOST_PACK", ref=host_pack.get("hostPackId"))

    quarantined += sum(
        1
        for source_id in source_ids
        if source_statuses.get(source_id) != "verified"
        or source_kinds.get(source_id) == "unknown"
    )
    if quarantined:
        issues.add("QUARANTINED_OBJECTS", ref=version_id)
    if canonical_hash != compute_canonical_payload_hash(bundle):
        issues.add("CANONICAL_HASH_MISMATCH", ref=version_id)

    blocking_count = issues.count("blocking")
    warning_count = issues.count("warning")
    freeze_ready = blocking_count == 0
    safe_report = {
        "report_schema": SAFE_SCHEMA,
        "status": "validated" if freeze_ready else "blocked",
        "counts": {
            "sources": len(source_ids),
            "pages": page_count,
            "assets": len(asset_ids),
            "content_blocks": len(content_ids),
            "role_slots": len(role_slots),
            "stages": len(stage_ids),
            "locations": len(location_ids),
            "clues": len(clue_ids),
            "quarantined": quarantined,
        },
        "quality": {
            "ocr_needs_review": ocr_needs_review,
            "pairing_needs_review": pairing_needs_review,
            "blocking_issues": blocking_count,
            "warnings": warning_count,
        },
        "issues": issues.safe_items(),
        "freeze_ready": freeze_ready,
        "published": False,
    }
    safe_report["run_id"] = derive_run_id(safe_report)
    return safe_report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    tokens = list(sys.argv[1:] if argv is None else argv)
    run_root_options = sum(
        token == "--run-root" or token.startswith("--run-root=") for token in tokens
    )
    if run_root_options != 1:
        raise ValueError("ARGUMENT_ERROR")
    parser = SafeArgumentParser(description="Validate a private bundle and emit a spoiler-safe report.")
    parser.add_argument("--run-root", required=True, type=Path)
    return parser.parse_args(tokens)


def main(argv: list[str] | None = None) -> int:
    safe_path: Path | None = None
    output_owned = False
    output_identity: tuple[int, int] | None = None
    try:
        args = parse_args(argv)
        run_root, marker = load_private_run_context(args.run_root)
        safe_path, report_schema = fixed_safe_report_path(run_root, "validation")
        if report_schema != SAFE_SCHEMA:
            raise ValueError("SAFE_REPORT_SCHEMA_MISMATCH")
        bundle_path = fixed_input_path(run_root)
        bundle = load_json_no_duplicates(bundle_path)
        safe_report = validate_bundle(bundle)
        if not inventory_matches_bundle(run_root, bundle):
            add_blocking_issue(safe_report, "INVENTORY_PROVENANCE_MISMATCH")
        expected_run_id = expected_run_id_for_schema(SAFE_SCHEMA, marker["nonce"])
        safe_report["run_id"] = expected_run_id
        if not validate_report(safe_report, expected_run_id=expected_run_id):
            raise ValueError("SAFE_REPORT_REJECTED")
        safe_bytes = canonical_safe_bytes(safe_report)
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        current_safe_path, current_schema = fixed_safe_report_path(run_root, "validation")
        if current_safe_path != safe_path or current_schema != SAFE_SCHEMA:
            raise ValueError("UNSAFE_OUTPUT_LOCATION")
        with safe_path.open("xb") as stream:
            output_owned = True
            output_identity = file_identity(os.fstat(stream.fileno()))
            if stream.write(safe_bytes) != len(safe_bytes):
                raise OSError("SHORT_SAFE_REPORT_WRITE")
            stream.flush()
            os.fsync(stream.fileno())
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        acknowledgement = '{"code":"VALIDATION_REPORT_WRITTEN","status":"private"}\n'
        if sys.stdout.write(acknowledgement) != len(acknowledgement):
            raise OSError("SHORT_STDOUT_WRITE")
        sys.stdout.flush()
        return 0 if safe_report["freeze_ready"] else 3
    except Exception:
        remove_owned_output(safe_path, output_owned, output_identity)
        try:
            sys.stderr.write('{"code":"BUNDLE_VALIDATION_FAILED","status":"failed"}\n')
            sys.stderr.flush()
        except Exception:
            pass
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
