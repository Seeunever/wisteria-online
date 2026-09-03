#!/usr/bin/env python3
"""Reject safe reports that contain unexpected fields or free-form channels."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any


RUN_ID_PATTERN = re.compile(r"^(?:pack|run)_[0-9a-f]{32}$")
RUN_NONCE_PATTERN = re.compile(r"^[0-9a-f]{32}$")
MAX_SAFE_INTEGER = 10**15
MAX_SAFE_REPORT_BYTES = 1024 * 1024
RUN_ROOT_MARKER = ".blind-player-run-root"
RUN_ROOT_SCHEMA = "blind-player-run-root/1.0"
# Compatibility fixture for older unit tests that construct a marked root by
# hand. Production roots are initialized with a fresh nonce by init_run_root.py.
RUN_ROOT_MARKER_BYTES = (
    b'{"nonce":"00000000000000000000000000000000",'
    b'"schema":"blind-player-run-root/1.0"}\n'
)
SAFE_REPORT_TARGETS = {
    "inventory": ("blind-inventory-safe/1.0", Path("safe") / "inventory.json"),
    "validation": ("blind-validation-safe/1.0", Path("safe") / "validation.json"),
}

INVENTORY_SEVERITY = {
    "DUPLICATE_CONTENT": "warning",
    "EMPTY_SOURCE": "blocking",
    "ENCRYPTED_PDF": "blocking",
    "IMAGE_METADATA_UNAVAILABLE": "blocking",
    "MISSING_NUMERIC_PAGES": "blocking",
    "DUPLICATE_NUMERIC_PAGES": "blocking",
    "NUMERIC_SEQUENCE_LIMIT_EXCEEDED": "blocking",
    "PDF_METADATA_UNAVAILABLE": "blocking",
    "SYMLINK_SOURCE": "blocking",
    "UNREADABLE_IMAGE": "blocking",
    "UNREADABLE_PDF": "blocking",
    "UNSUPPORTED_FILE_TYPE": "warning",
}

VALIDATION_CODES = {
    "BUNDLE_NOT_OBJECT",
    "CANONICAL_HASH_MISMATCH",
    "CLUE_WITHOUT_FACES",
    "COMPARTMENT_PRINCIPAL_MISMATCH",
    "COMPARTMENT_TOO_BROAD",
    "CONTENT_REVIEW_INCOMPLETE",
    "CYCLIC_CONDITION_DEPENDENCY",
    "DUPLICATE_FACE_ID",
    "DUPLICATE_PAGE_ID",
    "DUPLICATE_POLICY_ID",
    "DUPLICATE_RELEASE_ID",
    "DUPLICATE_SAFE_LABEL",
    "DUPLICATE_SECTION_ID",
    "FORWARD_STAGE_DEPENDENCY",
    "GRANT_WITHOUT_EVIDENCE",
    "HIGH_SECRET_GRANT",
    "HOST_CONTENT_NOT_L3",
    "IMPOSSIBLE_CONDITION_DEPENDENCY",
    "INCOMPLETE_ROLE_SLOTS",
    "INVENTORY_PROVENANCE_MISMATCH",
    "INVALID_ACQUISITION",
    "INVALID_ALLOWED_ACTION",
    "INVALID_ASSET_ID",
    "INVALID_ASSETS_COLLECTION",
    "INVALID_ASSET_SOURCE",
    "INVALID_CANONICAL_HASH",
    "INVALID_CLUE_ID",
    "INVALID_CLUES_COLLECTION",
    "INVALID_CLUE_POOL",
    "INVALID_CLUE_POOL_REFERENCE",
    "INVALID_CLUE_SHAPE",
    "INVALID_COMPARTMENT",
    "INVALID_COMPARTMENT_REFERENCE",
    "INVALID_CONDITION",
    "INVALID_CONDITION_REFERENCE",
    "INVALID_CONTENT_ASSET",
    "INVALID_CONTENT_EVIDENCE",
    "INVALID_CONTENT_ID",
    "INVALID_CONTENT_KIND",
    "INVALID_CONTENT_LEVEL",
    "INVALID_CONTENT_COLLECTION",
    "INVALID_CONTENT_PAYLOAD",
    "INVALID_CONTENT_SHAPE",
    "INVALID_FACE_ASSET",
    "INVALID_FACE_CONTENT",
    "INVALID_FACE_EVIDENCE",
    "INVALID_FACE_ID",
    "INVALID_FACE_SIDE",
    "INVALID_GRANT",
    "INVALID_GRANTS",
    "INVALID_HOST_CONTENT",
    "INVALID_HOST_PACK",
    "INVALID_LOCATION_ID",
    "INVALID_LOCATIONS_COLLECTION",
    "INVALID_LOCATION_NAME",
    "INVALID_LOCATION_SHAPE",
    "INVALID_PAGE_HASH",
    "INVALID_PAGE_ID",
    "INVALID_PAGE_INDEX",
    "INVALID_PAGE_ROTATION",
    "INVALID_PAGE_SIZE",
    "INVALID_PAIRING_CONFIDENCE",
    "INVALID_PAIRING_EVIDENCE",
    "INVALID_PAIRING_METHOD",
    "INVALID_PAIRING_STATUS",
    "INVALID_PARENT_VERSION_ID",
    "INVALID_PLAYER_COUNT",
    "INVALID_POLICY",
    "INVALID_PRINCIPAL",
    "INVALID_PUBLICATION",
    "INVALID_PUBLICATION_DUTY",
    "INVALID_REVEALED_FACE",
    "INVALID_REVIEW_STATUS",
    "INVALID_RENDERED_PAGE",
    "INVALID_RENDERED_PAGE_COVERAGE",
    "INVALID_ROLE_ID",
    "INVALID_ROLES_COLLECTION",
    "INVALID_ROLE_NAME",
    "INVALID_ROLE_SECTION",
    "INVALID_ROLE_SHAPE",
    "INVALID_ROLE_SLOT",
    "INVALID_SAFE_LABEL",
    "INVALID_SCRIPT_ID",
    "INVALID_SCRIPT_LOCALE",
    "INVALID_SCRIPT_SHAPE",
    "INVALID_SCRIPT_TIMESTAMP",
    "INVALID_SCRIPT_TITLE",
    "INVALID_SEARCH_MODE",
    "INVALID_INVESTIGATION_FLOW",
    "INVALID_SECTION_CONTENT",
    "INVALID_SECTION_EVIDENCE",
    "INVALID_SECTION_ORDER",
    "INVALID_SECTION_STAGE",
    "INVALID_SOURCE_CLASS",
    "INVALID_SOURCES_COLLECTION",
    "INVALID_SOURCE_CONFIDENCE",
    "INVALID_SOURCE_HASH",
    "INVALID_SOURCE_ID",
    "INVALID_SOURCE_LENGTH",
    "INVALID_SOURCE_MEDIA_TYPE",
    "INVALID_SOURCE_METHOD",
    "INVALID_SOURCE_PATH_REF",
    "INVALID_SOURCE_SET_HASH",
    "INVALID_SOURCE_STATUS",
    "INVALID_SOURCE_SUBJECT",
    "INVALID_STAGE_EVIDENCE",
    "INVALID_STAGE_ID",
    "INVALID_STAGES_COLLECTION",
    "INVALID_STAGE_LABEL",
    "INVALID_STAGE_LOCATION",
    "INVALID_STAGE_SEQUENCE",
    "INVALID_STAGE_SHAPE",
    "INVALID_TAINT_SOURCE",
    "INVALID_TOP_LEVEL_SHAPE",
    "INVALID_VALIDATION_PROFILE",
    "INVALID_VERSION_ID",
    "INVALID_VERSION_STATE",
    "L2_WITHOUT_PLAYER_GRANT",
    "L2_WITHOUT_COMPARTMENT",
    "NON_DENY_DEFAULT",
    "PAIRING_UNVERIFIED",
    "QUARANTINED_OBJECTS",
    "ROLE_WITHOUT_SECTIONS",
    "ROLE_CONTENT_COMPARTMENT_MISMATCH",
    "SCHEMA_VERSION_MISMATCH",
    "SOURCE_SET_HASH_MISMATCH",
    "SOURCE_WITHOUT_PAGES",
    "TAINT_MISSING_ASSET_SOURCE",
    "TAINT_MISSING_EVIDENCE_SOURCE",
    "TAINT_MISSING_SOURCE_COMPARTMENT",
    "UNKNOWN_CONDITION_OP",
    "VISIBILITY_EXCEEDS_SOURCE_CEILING",
}
VALIDATION_SEVERITY = {code: "blocking" for code in VALIDATION_CODES}

SCHEMAS = {
    "blind-inventory-safe/1.0": {
        "run_prefix": "pack_",
        "root": {"report_schema", "run_id", "status", "counts", "quality", "issues", "published"},
        "status": {"inventory_complete", "blocked"},
        "counts": {
            "files",
            "bytes",
            "images",
            "pdfs",
            "pdf_pages",
            "other_files",
            "numeric_sequence_groups",
            "numeric_sequence_pages",
            "duplicate_content_groups",
            "duplicate_files",
        },
        "quality": {
            "unreadable_files",
            "missing_numeric_pages",
            "duplicate_numeric_page_numbers",
            "blocking_issues",
        },
        "severity": INVENTORY_SEVERITY,
    },
    "blind-validation-safe/1.0": {
        "run_prefix": "run_",
        "root": {
            "report_schema",
            "run_id",
            "status",
            "counts",
            "quality",
            "issues",
            "freeze_ready",
            "published",
        },
        "status": {"validated", "blocked"},
        "counts": {
            "sources",
            "pages",
            "assets",
            "content_blocks",
            "role_slots",
            "stages",
            "locations",
            "clues",
            "quarantined",
        },
        "quality": {
            "ocr_needs_review",
            "pairing_needs_review",
            "blocking_issues",
            "warnings",
        },
        "severity": VALIDATION_SEVERITY,
    },
}


class SafeArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs["add_help"] = False
        super().__init__(*args, **kwargs)

    def error(self, _message: str) -> None:
        raise ValueError("ARGUMENT_ERROR")


def reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def load_json_no_duplicates(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(
            stream,
            object_pairs_hook=reject_duplicate_pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("NON_FINITE_JSON_NUMBER")),
        )


def canonical_safe_bytes(report: Any) -> bytes:
    """Return the sole allowed byte representation for a safe report."""
    rendered = json.dumps(
        report,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (rendered + "\n").encode("ascii")


def canonical_run_root_marker_bytes(nonce: str) -> bytes:
    """Return the unique marker encoding for one trusted run nonce."""
    if not isinstance(nonce, str) or not RUN_NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("INVALID_RUN_NONCE")
    return canonical_safe_bytes({"schema": RUN_ROOT_SCHEMA, "nonce": nonce})


def expected_run_id_for_schema(report_schema: str, nonce: str) -> str:
    """Bind a safe-report namespace to a controller-issued run nonce."""
    contract = SCHEMAS.get(report_schema)
    if contract is None:
        raise ValueError("UNKNOWN_SAFE_SCHEMA")
    if not isinstance(nonce, str) or not RUN_NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("INVALID_RUN_NONCE")
    return f"{contract['run_prefix']}{nonce}"


def derive_run_id(report: dict[str, Any]) -> str:
    """Compatibility helper for pure tests; production uses the run-root nonce."""
    schema = report.get("report_schema")
    contract = SCHEMAS.get(schema)
    if contract is None:
        raise ValueError("UNKNOWN_SAFE_SCHEMA")
    body = {key: value for key, value in report.items() if key != "run_id"}
    digest = hashlib.sha256(canonical_safe_bytes(body)).hexdigest()[:32]
    return f"{contract['run_prefix']}{digest}"


def load_canonical_safe_report(path: Path) -> tuple[Any, bytes]:
    """Read once, reject alternate encodings, and retain the exact validated bytes."""
    raw = _read_small_regular_file(path, MAX_SAFE_REPORT_BYTES, "SAFE_REPORT_READ")
    if not raw or len(raw) > MAX_SAFE_REPORT_BYTES:
        raise ValueError("SAFE_REPORT_SIZE")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("SAFE_REPORT_ENCODING") from error
    report = json.loads(
        text,
        object_pairs_hook=reject_duplicate_pairs,
        parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("NON_FINITE_JSON_NUMBER")),
    )
    canonical = canonical_safe_bytes(report)
    if raw != canonical:
        raise ValueError("NON_CANONICAL_SAFE_REPORT")
    return report, canonical


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", lambda: False)
    return path.is_symlink() or bool(is_junction())


def _resolve_private_run_root_path(candidate: Path) -> Path:
    lexical = Path(os.path.abspath(candidate))
    for component in (lexical, *lexical.parents):
        if component.exists() and _is_link_or_junction(component):
            raise ValueError("UNSAFE_RUN_ROOT")
    root = lexical.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("UNSAFE_RUN_ROOT")
    for component in (root, *root.parents):
        if (component / ".git").exists():
            raise ValueError("RUN_ROOT_IN_GIT")
    return root


def _stat_signature(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def _read_small_regular_file(path: Path, maximum: int, error_code: str) -> bytes:
    if _is_link_or_junction(path):
        raise ValueError(error_code)
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    current = path.stat()
    if (
        not stat.S_ISREG(before.st_mode)
        or _stat_signature(before) != _stat_signature(after)
        or _stat_signature(after) != _stat_signature(current)
        or len(raw) > maximum
        or _is_link_or_junction(path)
    ):
        raise ValueError(error_code)
    return raw


def _read_run_root_marker(root: Path) -> dict[str, str]:
    marker = root / RUN_ROOT_MARKER
    try:
        raw = _read_small_regular_file(
            marker,
            len(RUN_ROOT_MARKER_BYTES),
            "INVALID_RUN_ROOT_MARKER",
        )
    except OSError as error:
        raise ValueError("INVALID_RUN_ROOT_MARKER") from error
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("INVALID_RUN_ROOT_MARKER") from error
    try:
        value = json.loads(
            text,
            object_pairs_hook=reject_duplicate_pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("NON_FINITE_JSON_NUMBER")
            ),
        )
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("INVALID_RUN_ROOT_MARKER") from error
    if not isinstance(value, dict) or set(value) != {"schema", "nonce"}:
        raise ValueError("INVALID_RUN_ROOT_MARKER")
    if value.get("schema") != RUN_ROOT_SCHEMA:
        raise ValueError("INVALID_RUN_ROOT_MARKER")
    nonce = value.get("nonce")
    if not isinstance(nonce, str) or not RUN_NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("INVALID_RUN_ROOT_MARKER")
    if raw != canonical_run_root_marker_bytes(nonce):
        raise ValueError("INVALID_RUN_ROOT_MARKER")
    return {"schema": RUN_ROOT_SCHEMA, "nonce": nonce}


def load_private_run_context(candidate: Path) -> tuple[Path, dict[str, str]]:
    """Resolve one private root and read its canonical nonce marker once."""
    root = _resolve_private_run_root_path(candidate)
    return root, _read_run_root_marker(root)


def load_run_root_marker(candidate: Path) -> dict[str, str]:
    """Resolve a private run root and strictly load its canonical marker."""
    _root, marker = load_private_run_context(candidate)
    return marker


def resolve_private_run_root(candidate: Path) -> Path:
    """Accept only an explicitly marked private root outside every Git work tree."""
    root, _marker = load_private_run_context(candidate)
    return root


def is_nonnegative_int(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= MAX_SAFE_INTEGER
    )


def validate_numeric_map(value: Any, allowed_keys: set[str]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == allowed_keys
        and all(is_nonnegative_int(item) for item in value.values())
    )


def validate_issues(value: Any, expected_severity: dict[str, str]) -> tuple[bool, int, int]:
    if not isinstance(value, list) or len(value) > 1000:
        return False, 0, 0
    seen: set[str] = set()
    previous_code: str | None = None
    blocking = 0
    warnings = 0
    for issue in value:
        if not isinstance(issue, dict):
            return False, 0, 0
        if set(issue) != {"code", "severity", "count"}:
            return False, 0, 0
        code = issue["code"]
        if code not in expected_severity or issue["severity"] != expected_severity[code]:
            return False, 0, 0
        if not is_nonnegative_int(issue["count"]) or issue["count"] == 0:
            return False, 0, 0
        if code in seen or (previous_code is not None and code <= previous_code):
            return False, 0, 0
        seen.add(code)
        previous_code = code
        if issue["severity"] == "blocking":
            blocking += issue["count"]
        else:
            warnings += issue["count"]
    return True, blocking, warnings


def validate_report(report: Any, *, expected_run_id: str | None = None) -> bool:
    if not isinstance(report, dict):
        return False
    schema = report.get("report_schema")
    if schema not in SCHEMAS:
        return False
    contract = SCHEMAS[schema]
    if set(report) != contract["root"]:
        return False
    if (
        not isinstance(report.get("run_id"), str)
        or not report["run_id"].startswith(contract["run_prefix"])
        or not RUN_ID_PATTERN.fullmatch(report["run_id"])
    ):
        return False
    if report.get("status") not in contract["status"]:
        return False
    if not validate_numeric_map(report.get("counts"), contract["counts"]):
        return False
    if not validate_numeric_map(report.get("quality"), contract["quality"]):
        return False
    issue_ok, blocking, warnings = validate_issues(report.get("issues"), contract["severity"])
    if not issue_ok or report.get("published") is not False:
        return False

    counts = report["counts"]
    quality = report["quality"]
    issue_counts = {issue["code"]: issue["count"] for issue in report["issues"]}
    if blocking != quality["blocking_issues"]:
        return False

    if schema == "blind-inventory-safe/1.0":
        if counts["images"] + counts["pdfs"] + counts["other_files"] != counts["files"]:
            return False
        if counts["pdfs"] == 0 and counts["pdf_pages"] != 0:
            return False
        if counts["numeric_sequence_pages"] > counts["images"]:
            return False
        if counts["numeric_sequence_groups"] > counts["numeric_sequence_pages"]:
            return False
        if counts["numeric_sequence_pages"] == 0 and (
            quality["missing_numeric_pages"] or quality["duplicate_numeric_page_numbers"]
        ):
            return False
        if quality["duplicate_numeric_page_numbers"] > counts["numeric_sequence_pages"] // 2:
            return False
        if quality["missing_numeric_pages"] > counts["numeric_sequence_groups"] * 99_999:
            return False
        if counts["duplicate_files"] > counts["files"]:
            return False
        if counts["duplicate_content_groups"] == 0 and counts["duplicate_files"] != 0:
            return False
        if counts["duplicate_files"] < 2 * counts["duplicate_content_groups"]:
            return False
        if issue_counts.get("DUPLICATE_CONTENT", 0) != counts["duplicate_content_groups"]:
            return False
        if issue_counts.get("MISSING_NUMERIC_PAGES", 0) != quality["missing_numeric_pages"]:
            return False
        if issue_counts.get("DUPLICATE_NUMERIC_PAGES", 0) != quality["duplicate_numeric_page_numbers"]:
            return False
        if (
            issue_counts.get("UNREADABLE_IMAGE", 0)
            + issue_counts.get("UNREADABLE_PDF", 0)
            != quality["unreadable_files"]
        ):
            return False
        if issue_counts.get("EMPTY_SOURCE", 0) != (1 if counts["files"] == 0 else 0):
            return False
        if (
            issue_counts.get("SYMLINK_SOURCE", 0)
            + issue_counts.get("UNSUPPORTED_FILE_TYPE", 0)
            > counts["other_files"]
        ):
            return False
        if (
            issue_counts.get("UNREADABLE_IMAGE", 0)
            + issue_counts.get("IMAGE_METADATA_UNAVAILABLE", 0)
            > counts["images"]
        ):
            return False
        if (
            issue_counts.get("UNREADABLE_PDF", 0)
            + issue_counts.get("PDF_METADATA_UNAVAILABLE", 0)
            + issue_counts.get("ENCRYPTED_PDF", 0)
            > counts["pdfs"]
        ):
            return False
        if report["status"] != ("blocked" if blocking else "inventory_complete"):
            return False
        if quality["unreadable_files"] > counts["files"]:
            return False
    else:
        if not isinstance(report.get("freeze_ready"), bool):
            return False
        expected_ready = blocking == 0
        if report["freeze_ready"] != expected_ready:
            return False
        if report["status"] != ("validated" if expected_ready else "blocked"):
            return False
        if quality["warnings"] != warnings:
            return False
        if quality["ocr_needs_review"] > counts["content_blocks"]:
            return False
        if quality["pairing_needs_review"] > counts["clues"]:
            return False
        if counts["quarantined"] > counts["sources"] + counts["content_blocks"]:
            return False
        if report["freeze_ready"] and (
            quality["ocr_needs_review"]
            or quality["pairing_needs_review"]
            or counts["quarantined"]
        ):
            return False
    if expected_run_id is not None:
        if (
            not isinstance(expected_run_id, str)
            or not expected_run_id.startswith(contract["run_prefix"])
            or not RUN_ID_PATTERN.fullmatch(expected_run_id)
        ):
            return False
        return hmac.compare_digest(report["run_id"], expected_run_id)
    try:
        return hmac.compare_digest(report["run_id"], derive_run_id(report))
    except (TypeError, ValueError):
        return False


def fixed_safe_report_path(run_root: Path, report_kind: str) -> tuple[Path, str]:
    target = SAFE_REPORT_TARGETS.get(report_kind)
    if target is None:
        raise ValueError("UNKNOWN_SAFE_REPORT_KIND")
    report_schema, relative = target
    safe_directory = run_root / relative.parent
    if _is_link_or_junction(safe_directory):
        raise ValueError("UNSAFE_SAFE_REPORT_PATH")
    resolved_directory = safe_directory.resolve(strict=True)
    if not resolved_directory.is_dir() or resolved_directory.parent != run_root:
        raise ValueError("UNSAFE_SAFE_REPORT_PATH")
    report_path = resolved_directory / relative.name
    if _is_link_or_junction(report_path):
        raise ValueError("UNSAFE_SAFE_REPORT_PATH")
    return report_path, report_schema


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    tokens = list(sys.argv[1:] if argv is None else argv)
    run_root_options = sum(
        token == "--run-root" or token.startswith("--run-root=") for token in tokens
    )
    report_options = sum(
        token == "--report" or token.startswith("--report=") for token in tokens
    )
    if run_root_options != 1 or report_options != 1:
        raise ValueError("ARGUMENT_ERROR")
    parser = SafeArgumentParser(description="Validate one fixed spoiler-safe report.")
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--report", required=True, choices=tuple(SAFE_REPORT_TARGETS))
    return parser.parse_args(tokens)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        run_root, marker = load_private_run_context(args.run_root)
        report_path, report_schema = fixed_safe_report_path(run_root, args.report)
        report, canonical = load_canonical_safe_report(report_path)
        expected_run_id = expected_run_id_for_schema(report_schema, marker["nonce"])
        if report.get("report_schema") != report_schema:
            raise ValueError("SAFE_REPORT_SCHEMA_MISMATCH")
        if validate_report(report, expected_run_id=expected_run_id):
            if _read_run_root_marker(run_root) != marker:
                raise ValueError("RUN_ROOT_MARKER_CHANGED")
            sys.stdout.buffer.write(canonical)
            sys.stdout.buffer.flush()
            return 0
    except Exception:
        pass
    try:
        sys.stderr.write('{"code":"SAFE_REPORT_REJECTED","status":"blocked"}\n')
        sys.stderr.flush()
    except Exception:
        pass
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
