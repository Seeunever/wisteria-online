#!/usr/bin/env python3
"""Create private and spoiler-safe inventories for a mixed document pack.

The private manifest contains source-identifying data. The safe report contains
only fixed-schema operational metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import stat
import sys
import warnings
from collections import Counter, defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator

from validate_safe_report import (
    SafeArgumentParser,
    canonical_safe_bytes,
    derive_run_id,
    expected_run_id_for_schema,
    load_private_run_context,
    load_run_root_marker,
    validate_report,
)


PRIVATE_SCHEMA = "blind-private-inventory/1.0"
SAFE_SCHEMA = "blind-inventory-safe/1.0"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
PDF_EXTENSIONS = {".pdf"}
NUMERIC_STEM = re.compile(r"^[0-9]+$")
MAX_NUMERIC_STEM_DIGITS = 12
MAX_NUMERIC_SEQUENCE_SPAN = 100_000
NUMERIC_SEQUENCE_LIMIT_CODE = "NUMERIC_SEQUENCE_LIMIT_EXCEEDED"
PRIVATE_OUTPUT_RELATIVE = Path("private") / "source-inventory.json"
SAFE_OUTPUT_RELATIVE = Path("safe") / "inventory.json"
PRIVATE_LOG_RELATIVE = Path("private") / "inventory-process.log"
VAULT_DIRECTORY_RELATIVE = Path("vault")
VAULT_SOURCES_RELATIVE = VAULT_DIRECTORY_RELATIVE / "sources"
STAGING_PREFIX = ".sources-staging-"
PUBLIC_PATH_COMPONENTS = {"public", "static", "wwwroot", "htdocs", "dist", "build", "out"}

SnapshotSignature = tuple[str, int, int, int, int, int]

Image: Any = None
PdfReader: Any = None
_OPTIONAL_DEPENDENCIES_LOADED = False


def natural_key(value: str) -> list[tuple[object, ...]]:
    key: list[tuple[object, ...]] = []
    for part in re.split(r"([0-9]+)", value):
        if part.isdigit():
            significant = part.lstrip("0") or "0"
            key.append((0, len(significant), significant, len(part), part))
        else:
            key.append((1, part.casefold(), part))
    return key


def sha256_stream(stream: BinaryIO) -> str:
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def opaque_id(prefix: str, material: str) -> str:
    token = hashlib.sha256(material.encode("utf-8", errors="surrogatepass")).hexdigest()[:16]
    return f"{prefix}_{token}"


def file_identity(value: os.stat_result) -> tuple[int, int]:
    return int(value.st_dev), int(value.st_ino)


def _exclusive_write_bytes(path: Path, payload: bytes) -> tuple[int, int]:
    """Create one artifact without replacing anything already present."""
    path.parent.mkdir(parents=True, exist_ok=True)
    identity: tuple[int, int] | None = None
    try:
        with path.open("xb") as stream:
            identity = file_identity(os.fstat(stream.fileno()))
            if stream.write(payload) != len(payload):
                raise OSError("SHORT_ARTIFACT_WRITE")
            stream.flush()
            os.fsync(stream.fileno())
        return identity
    except Exception:
        remove_owned_output(path, identity is not None, identity)
        raise


def atomic_write_json(path: Path, payload: dict[str, Any]) -> tuple[int, int]:
    """Create private JSON exclusively (historical helper name retained)."""
    rendered = json.dumps(
        payload,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    )
    return _exclusive_write_bytes(path, (rendered + "\n").encode("utf-8"))


def atomic_write_safe_json(path: Path, payload: dict[str, Any]) -> tuple[int, int]:
    """Create the sole canonical safe representation without replacement."""
    return _exclusive_write_bytes(path, canonical_safe_bytes(payload))


def remove_owned_output(
    path: Path | None,
    ownership: bool,
    identity: tuple[int, int] | None,
) -> None:
    if not ownership or path is None:
        return
    try:
        if _is_link_or_junction(path):
            return
        current = path.stat()
        if not stat.S_ISREG(current.st_mode):
            return
        if identity is not None and file_identity(current) != identity:
            return
        path.unlink()
    except (FileNotFoundError, OSError):
        pass


def output_path(path: Path) -> Path:
    """Resolve a non-directory output path for callers of the legacy helper."""
    lexical = Path(os.path.abspath(path))
    is_junction = getattr(lexical, "is_junction", lambda: False)
    if lexical.exists() and (lexical.is_dir() or lexical.is_symlink() or is_junction()):
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    return lexical.parent.resolve(strict=False) / lexical.name


def is_within(candidate: Path, parent: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", lambda: False)
    return path.is_symlink() or bool(is_junction())


def _snapshot_signature(kind: str, value: os.stat_result) -> SnapshotSignature:
    return (
        kind,
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_mode),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def _entry_kind(path: Path, value: os.stat_result) -> str:
    if path.is_symlink():
        return "symlink"
    if getattr(path, "is_junction", lambda: False)():
        return "junction"
    if stat.S_ISDIR(value.st_mode):
        return "directory"
    if stat.S_ISREG(value.st_mode):
        return "file"
    return "special"


def snapshot_source_tree(source: Path) -> dict[str, SnapshotSignature]:
    """Capture a non-following snapshot of every directory entry under source."""
    snapshot: dict[str, SnapshotSignature] = {}

    def scan(directory: Path) -> None:
        try:
            with os.scandir(directory) as iterator:
                entries = list(iterator)
        except OSError as error:
            raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error

        entries.sort(key=lambda entry: (natural_key(entry.name), entry.name.casefold(), entry.name))
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(source).as_posix()
            try:
                # DirEntry.stat(follow_symlinks=False) reports zero device/inode
                # values on Windows, while lstat/fstat retain the stable file ID.
                value = path.lstat()
                kind = _entry_kind(path, value)
            except OSError as error:
                raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error
            snapshot[relative] = _snapshot_signature(kind, value)
            if kind == "directory":
                scan(path)

    try:
        root_stat = source.lstat()
        root_kind = _entry_kind(source, root_stat)
    except OSError as error:
        raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error
    if root_kind != "directory":
        raise ValueError("SOURCE_NOT_DIRECTORY")
    snapshot["."] = _snapshot_signature(root_kind, root_stat)
    scan(source)
    return snapshot


def _paths_from_snapshot(source: Path, snapshot: dict[str, SnapshotSignature]) -> list[Path]:
    relative_paths = [relative for relative, value in snapshot.items() if value[0] != "directory"]
    relative_paths.sort(key=lambda value: (natural_key(value), value.casefold(), value))
    return [source / Path(relative) for relative in relative_paths]


def iter_source_files(source: Path) -> Iterable[Path]:
    """Return a stable natural ordering while retaining the historical function API."""
    return _paths_from_snapshot(source, snapshot_source_tree(source))


def load_optional_dependencies() -> None:
    """Import content parsers only inside the caller's private-output boundary."""
    global Image, PdfReader, _OPTIONAL_DEPENDENCIES_LOADED
    if _OPTIONAL_DEPENDENCIES_LOADED:
        return
    try:
        from PIL import Image as pillow_image
    except Exception:  # pragma: no cover - environment dependent
        pillow_image = None
    try:
        from pypdf import PdfReader as pdf_reader
    except Exception:  # pragma: no cover - environment dependent
        pdf_reader = None
    Image = pillow_image
    PdfReader = pdf_reader
    _OPTIONAL_DEPENDENCIES_LOADED = True


def inspect_image(stream: BinaryIO) -> tuple[dict[str, Any], str | None]:
    if Image is None:
        return {"metadata_status": "unavailable"}, "IMAGE_METADATA_UNAVAILABLE"
    try:
        with Image.open(stream) as image:
            metadata = {
                "metadata_status": "ok",
                "format": image.format,
                "width": int(image.width),
                "height": int(image.height),
                "mode": image.mode,
            }
            image.verify()
        stream.seek(0)
        with Image.open(stream) as image:
            exif = image.getexif()
            metadata["exif_orientation"] = int(exif.get(274, 1)) if exif else 1
        return metadata, None
    except Exception:
        return {"metadata_status": "unreadable"}, "UNREADABLE_IMAGE"


def inspect_pdf(stream: BinaryIO) -> tuple[dict[str, Any], str | None]:
    if PdfReader is None:
        return {"metadata_status": "unavailable"}, "PDF_METADATA_UNAVAILABLE"
    try:
        reader = PdfReader(stream, strict=False)
        encrypted = bool(reader.is_encrypted)
        page_count = None if encrypted else len(reader.pages)
        return (
            {
                "metadata_status": "ok",
                "encrypted": encrypted,
                "page_count": page_count,
            },
            "ENCRYPTED_PDF" if encrypted else None,
        )
    except Exception:
        return {"metadata_status": "unreadable"}, "UNREADABLE_PDF"


def stat_signature(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def aggregate_issues(issue_codes: Iterable[str] | Counter[str]) -> list[dict[str, Any]]:
    blocking = {
        "EMPTY_SOURCE",
        "SYMLINK_SOURCE",
        "UNREADABLE_IMAGE",
        "UNREADABLE_PDF",
        "IMAGE_METADATA_UNAVAILABLE",
        "PDF_METADATA_UNAVAILABLE",
        "ENCRYPTED_PDF",
        "MISSING_NUMERIC_PAGES",
        "DUPLICATE_NUMERIC_PAGES",
        NUMERIC_SEQUENCE_LIMIT_CODE,
    }
    counts = Counter(issue_codes)
    return [
        {
            "code": code,
            "severity": "blocking" if code in blocking else "warning",
            "count": count,
        }
        for code, count in sorted(counts.items())
    ]


def _regular_snapshot_signature(value: os.stat_result) -> SnapshotSignature:
    return _snapshot_signature("file", value)


def _open_source(path: Path) -> BinaryIO:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        return os.fdopen(descriptor, "rb")
    except Exception:
        os.close(descriptor)
        raise


def resolve_source_root(candidate: Path) -> Path:
    lexical = Path(os.path.abspath(candidate))
    if _is_link_or_junction(lexical):
        raise ValueError("UNSAFE_SOURCE_ROOT")
    source = lexical.resolve(strict=True)
    if not source.is_dir() or _is_link_or_junction(source):
        raise ValueError("SOURCE_NOT_DIRECTORY")
    return source


def _blob_name(relative: str) -> str:
    return f"{opaque_id('src', relative)}.blob"


def _vault_blob_ref(relative: str) -> str:
    return f"vault:sources/{_blob_name(relative)}"


def _open_exclusive_blob(path: Path) -> BinaryIO:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        return os.fdopen(descriptor, "wb")
    except Exception:
        os.close(descriptor)
        raise


def _copy_stream_once(source: BinaryIO, destination: BinaryIO) -> None:
    while chunk := source.read(1024 * 1024):
        destination.write(chunk)


def stage_source_tree(source: Path, staging_root: Path) -> dict[str, SnapshotSignature]:
    """Copy each regular source once without following links, then recheck the tree."""
    source = resolve_source_root(source)
    if not staging_root.is_dir() or _is_link_or_junction(staging_root):
        raise ValueError("UNSAFE_STAGING_LOCATION")
    initial_snapshot = snapshot_source_tree(source)
    for path in _paths_from_snapshot(source, initial_snapshot):
        relative = path.relative_to(source).as_posix()
        expected = initial_snapshot[relative]
        if expected[0] in {"symlink", "junction"}:
            continue
        if expected[0] != "file":
            raise ValueError("NON_REGULAR_SOURCE")
        destination = staging_root / _blob_name(relative)
        with _open_source(path) as source_stream:
            before = os.fstat(source_stream.fileno())
            if not stat.S_ISREG(before.st_mode) or _regular_snapshot_signature(before) != expected:
                raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")
            with _open_exclusive_blob(destination) as staged_stream:
                _copy_stream_once(source_stream, staged_stream)
                staged_stream.flush()
                os.fsync(staged_stream.fileno())
            after = os.fstat(source_stream.fileno())
        try:
            current = path.lstat()
            current_kind = _entry_kind(path, current)
        except OSError as error:
            raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error
        if (
            stat_signature(before) != stat_signature(after)
            or _snapshot_signature(current_kind, current) != expected
            or current_kind != "file"
        ):
            raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")

    try:
        final_snapshot = snapshot_source_tree(source)
    except Exception as error:
        raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error
    if initial_snapshot != final_snapshot:
        raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")
    return initial_snapshot


def commit_staged_sources(staging_root: Path, committed_root: Path) -> None:
    if staging_root.parent != committed_root.parent or os.path.lexists(committed_root):
        raise ValueError("RUN_ROOT_ALREADY_USED")
    if not staging_root.is_dir() or _is_link_or_junction(staging_root):
        raise ValueError("UNSAFE_STAGING_LOCATION")
    os.replace(staging_root, committed_root)


def build_inventory(
    source: Path,
    *,
    source_snapshot: dict[str, SnapshotSignature] | None = None,
    vault_sources: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    load_optional_dependencies()
    using_vault = vault_sources is not None
    if using_vault:
        source = Path(os.path.abspath(source))
        if source_snapshot is None:
            raise ValueError("MISSING_SOURCE_SNAPSHOT")
        initial_snapshot = dict(source_snapshot)
        assert vault_sources is not None
        if not vault_sources.is_dir() or _is_link_or_junction(vault_sources):
            raise ValueError("UNSAFE_VAULT_LOCATION")
    else:
        source = resolve_source_root(source)
        initial_snapshot = snapshot_source_tree(source)
    records: list[dict[str, Any]] = []
    issue_counts: Counter[str] = Counter()
    hash_groups: dict[str, list[str]] = defaultdict(list)
    processing_error: Exception | None = None

    try:
        for path in _paths_from_snapshot(source, initial_snapshot):
            relative = path.relative_to(source).as_posix()
            expected = initial_snapshot[relative]
            if expected[0] in {"symlink", "junction"}:
                source_id = opaque_id("src", relative)
                records.append(
                    {
                        "source_id": source_id,
                        "relative_path": relative,
                        "classification": "RAW_SECRET",
                        "status": "quarantined",
                        "kind": "other",
                        "issue_code": "SYMLINK_SOURCE",
                    }
                )
                issue_counts["SYMLINK_SOURCE"] += 1
                continue
            if expected[0] != "file":
                raise ValueError("NON_REGULAR_SOURCE")

            suffix = path.suffix.casefold()
            data_path = (
                vault_sources / _blob_name(relative)
                if vault_sources is not None
                else path
            )
            with _open_source(data_path) as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")
                if using_vault:
                    if int(before.st_size) != int(expected[4]):
                        raise ValueError("VAULT_COPY_MISMATCH")
                elif _regular_snapshot_signature(before) != expected:
                    raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")
                digest = sha256_stream(stream)
                stream.seek(0)
                if suffix in IMAGE_EXTENSIONS:
                    kind = "image"
                    metadata, issue = inspect_image(stream)
                elif suffix in PDF_EXTENSIONS:
                    kind = "pdf"
                    metadata, issue = inspect_pdf(stream)
                else:
                    kind = "other"
                    metadata = None
                    issue = "UNSUPPORTED_FILE_TYPE"
                after = os.fstat(stream.fileno())

            try:
                current = data_path.lstat()
                current_kind = _entry_kind(data_path, current)
            except OSError as error:
                code = "VAULT_COPY_MISMATCH" if using_vault else "SOURCE_CHANGED_DURING_INVENTORY"
                raise ValueError(code) from error
            changed = stat_signature(before) != stat_signature(after) or current_kind != "file"
            if using_vault:
                changed = changed or stat_signature(after) != stat_signature(current)
            else:
                changed = changed or _snapshot_signature(current_kind, current) != expected
            if changed:
                code = "VAULT_COPY_MISMATCH" if using_vault else "SOURCE_CHANGED_DURING_INVENTORY"
                raise ValueError(code)

            byte_length = int(after.st_size)
            source_id = opaque_id("src", f"{relative}\0{digest}")
            media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            record: dict[str, Any] = {
                "source_id": source_id,
                "relative_path": relative,
                "classification": "RAW_SECRET",
                "byte_length": byte_length,
                "sha256": f"sha256:{digest}",
                "extension": suffix,
                "media_type": media_type,
                "kind": kind,
            }
            if using_vault:
                record["vault_blob_ref"] = _vault_blob_ref(relative)
            if kind == "image":
                record["image"] = metadata
            elif kind == "pdf":
                record["pdf"] = metadata
            if issue:
                record["issue_code"] = issue
                issue_counts[issue] += 1
            records.append(record)
            hash_groups[digest].append(source_id)
    except Exception as error:
        processing_error = error

    if not using_vault:
        try:
            final_snapshot = snapshot_source_tree(source)
        except Exception as error:
            raise ValueError("SOURCE_CHANGED_DURING_INVENTORY") from error
        if initial_snapshot != final_snapshot:
            raise ValueError("SOURCE_CHANGED_DURING_INVENTORY")
    if processing_error is not None:
        raise processing_error

    for index, record in enumerate(records, start=1):
        record["path_ref"] = f"vault:path:{index:04d}"

    if not records:
        issue_counts["EMPTY_SOURCE"] += 1

    duplicate_groups = [
        {
            "group_id": opaque_id("dup", digest),
            "sha256": f"sha256:{digest}",
            "source_ids": sorted(source_ids),
        }
        for digest, source_ids in sorted(hash_groups.items())
        if len(source_ids) > 1
    ]
    issue_counts["DUPLICATE_CONTENT"] += len(duplicate_groups)

    numeric_groups: dict[str, dict[int, list[str]]] = defaultdict(lambda: defaultdict(list))
    for record in records:
        if record.get("kind") != "image":
            continue
        relative = Path(record["relative_path"])
        stem = relative.stem
        if not NUMERIC_STEM.fullmatch(stem):
            continue
        if len(stem) > MAX_NUMERIC_STEM_DIGITS:
            record["numeric_sequence_issue_code"] = NUMERIC_SEQUENCE_LIMIT_CODE
            issue_counts[NUMERIC_SEQUENCE_LIMIT_CODE] += 1
            continue
        numeric_groups[relative.parent.as_posix()][int(stem)].append(record["source_id"])

    sequence_records: list[dict[str, Any]] = []
    missing_page_total = 0
    duplicate_number_total = 0
    for parent, page_map in sorted(numeric_groups.items(), key=lambda item: natural_key(item[0])):
        numbers = sorted(page_map)
        first = numbers[0]
        last = numbers[-1]
        span = last - first + 1
        duplicate_numbers = [number for number, ids in page_map.items() if len(ids) > 1]
        duplicate_number_total += len(duplicate_numbers)
        sequence_record: dict[str, Any] = {
            "group_id": opaque_id("seq", parent),
            "private_parent_path": parent,
            "first": first,
            "last": last,
            "page_count": sum(len(ids) for ids in page_map.values()),
            "duplicate_numbers": sorted(duplicate_numbers),
            "pages": {str(number): sorted(ids) for number, ids in sorted(page_map.items())},
        }
        if span > MAX_NUMERIC_SEQUENCE_SPAN:
            sequence_record.update(
                {
                    "status": "quarantined",
                    "issue_code": NUMERIC_SEQUENCE_LIMIT_CODE,
                    "missing": [],
                }
            )
            issue_counts[NUMERIC_SEQUENCE_LIMIT_CODE] += 1
        else:
            missing = [number for number in range(first, last + 1) if number not in page_map]
            sequence_record["missing"] = missing
            missing_page_total += len(missing)
        sequence_records.append(sequence_record)

    issue_counts["MISSING_NUMERIC_PAGES"] += missing_page_total
    issue_counts["DUPLICATE_NUMERIC_PAGES"] += duplicate_number_total
    issue_counts += Counter()

    fingerprint_material = json.dumps(
        [
            (record.get("relative_path"), record.get("sha256"), record.get("byte_length"))
            for record in records
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256(fingerprint_material.encode("utf-8")).hexdigest()

    issues = aggregate_issues(issue_counts)
    blocking_count = sum(issue["count"] for issue in issues if issue["severity"] == "blocking")
    images = [record for record in records if record.get("kind") == "image"]
    pdfs = [record for record in records if record.get("kind") == "pdf"]
    others = [record for record in records if record.get("kind") == "other"]
    pdf_pages = sum(int(record.get("pdf", {}).get("page_count") or 0) for record in pdfs)
    unreadable_files = sum(
        1
        for record in records
        if record.get("issue_code") in {"UNREADABLE_IMAGE", "UNREADABLE_PDF"}
    )

    safe_report: dict[str, Any] = {
        "report_schema": SAFE_SCHEMA,
        "status": "blocked" if blocking_count else "inventory_complete",
        "counts": {
            "files": len(records),
            "bytes": sum(int(record.get("byte_length") or 0) for record in records),
            "images": len(images),
            "pdfs": len(pdfs),
            "pdf_pages": pdf_pages,
            "other_files": len(others),
            "numeric_sequence_groups": len(sequence_records),
            "numeric_sequence_pages": sum(record["page_count"] for record in sequence_records),
            "duplicate_content_groups": len(duplicate_groups),
            "duplicate_files": sum(len(group["source_ids"]) for group in duplicate_groups),
        },
        "quality": {
            "unreadable_files": unreadable_files,
            "missing_numeric_pages": missing_page_total,
            "duplicate_numeric_page_numbers": duplicate_number_total,
            "blocking_issues": blocking_count,
        },
        "issues": issues,
        "published": False,
    }
    safe_report["run_id"] = derive_run_id(safe_report)
    private_manifest = {
        "schema": PRIVATE_SCHEMA,
        "pack_id": f"pack_{fingerprint[:16]}",
        "source_fingerprint": f"sha256:{fingerprint}",
        "classification": "RAW_SECRET",
        "source_root": str(source),
        "sources": records,
        "duplicate_groups": duplicate_groups,
        "numeric_sequences": sequence_records,
        "issues": issues,
    }
    return private_manifest, safe_report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    tokens = list(sys.argv[1:] if argv is None else argv)
    run_root_options = sum(
        token == "--run-root" or token.startswith("--run-root=") for token in tokens
    )
    if run_root_options != 1:
        raise ValueError("ARGUMENT_ERROR")
    parser = SafeArgumentParser(description="Build a private source manifest and spoiler-safe inventory report.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--run-root", required=True, type=Path)
    return parser.parse_args(tokens)


def _resolve_output_directory(run_root: Path, relative: Path, *, create: bool) -> Path:
    directory = run_root / relative
    if directory.is_symlink() or getattr(directory, "is_junction", lambda: False)():
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    if not directory.exists():
        if not create:
            return directory
        directory.mkdir(mode=0o700)
    if not directory.is_dir() or _is_link_or_junction(directory):
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    resolved = directory.resolve(strict=True)
    if resolved.parent != run_root:
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    return resolved


def resolve_inventory_outputs(
    run_root_candidate: Path,
    *,
    create_directories: bool = True,
) -> tuple[Path, Path, Path]:
    run_root, _marker = load_private_run_context(run_root_candidate)
    if any(part.casefold() in PUBLIC_PATH_COMPONENTS for part in run_root.parts):
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    private_directory = _resolve_output_directory(
        run_root,
        PRIVATE_OUTPUT_RELATIVE.parent,
        create=create_directories,
    )
    safe_directory = _resolve_output_directory(
        run_root,
        SAFE_OUTPUT_RELATIVE.parent,
        create=create_directories,
    )
    private_path = private_directory / PRIVATE_OUTPUT_RELATIVE.name
    safe_path = safe_directory / SAFE_OUTPUT_RELATIVE.name
    for path in (private_path, safe_path):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)() or path.is_dir():
            raise ValueError("UNSAFE_OUTPUT_LOCATION")
    return run_root, private_path, safe_path


def resolve_inventory_artifacts(
    run_root_candidate: Path,
    *,
    create_directories: bool = True,
) -> tuple[Path, Path, Path, Path, Path]:
    run_root, private_path, safe_path = resolve_inventory_outputs(
        run_root_candidate,
        create_directories=create_directories,
    )
    private_directory = private_path.parent
    log_path = private_directory / PRIVATE_LOG_RELATIVE.name
    if log_path.is_symlink() or getattr(log_path, "is_junction", lambda: False)() or log_path.is_dir():
        raise ValueError("UNSAFE_OUTPUT_LOCATION")
    vault_directory = _resolve_output_directory(
        run_root,
        VAULT_DIRECTORY_RELATIVE,
        create=create_directories,
    )
    committed_sources = vault_directory / VAULT_SOURCES_RELATIVE.name
    if os.path.lexists(committed_sources):
        raise ValueError("RUN_ROOT_ALREADY_USED")
    return run_root, private_path, safe_path, log_path, committed_sources


def create_staging_directory(vault_directory: Path) -> Path:
    if not vault_directory.is_dir() or _is_link_or_junction(vault_directory):
        raise ValueError("UNSAFE_VAULT_LOCATION")
    staging = vault_directory / f"{STAGING_PREFIX}{os.getpid()}-{secrets.token_hex(8)}"
    staging.mkdir(mode=0o700)
    if not staging.is_dir() or _is_link_or_junction(staging):
        raise ValueError("UNSAFE_STAGING_LOCATION")
    return staging


def _remove_tree_no_follow(path: Path, allowed_parent: Path) -> None:
    lexical = Path(os.path.abspath(path))
    if lexical.parent != allowed_parent or not os.path.lexists(lexical):
        return

    def remove(node: Path) -> None:
        value = node.lstat()
        kind = _entry_kind(node, value)
        if kind == "directory":
            with os.scandir(node) as iterator:
                children = [Path(entry.path) for entry in iterator]
            for child in children:
                remove(child)
            node.rmdir()
        elif kind == "junction":
            node.rmdir()
        else:
            node.unlink(missing_ok=True)

    remove(lexical)


def _cleanup_vault_artifacts(
    staging_root: Path | None,
    committed_root: Path | None,
    *,
    commit_owned: bool,
) -> None:
    for path, owned in ((staging_root, staging_root is not None), (committed_root, commit_owned)):
        if path is None or not owned:
            continue
        try:
            _remove_tree_no_follow(path, path.parent)
        except OSError:
            pass


@contextmanager
def redirect_process_output(log_path: Path) -> Iterator[tuple[int, int]]:
    """Redirect Python streams and native fd 1/2 to one private fixed log."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    log_fd = os.open(log_path, flags, 0o600)
    log_identity = file_identity(os.fstat(log_fd))
    saved_stdout_fd: int | None = None
    saved_stderr_fd: int | None = None
    redirected_stdout: Any = None
    redirected_stderr: Any = None
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    try:
        saved_stdout_fd = os.dup(1)
        saved_stderr_fd = os.dup(2)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        redirected_stdout = os.fdopen(
            os.dup(log_fd),
            "w",
            encoding="utf-8",
            errors="backslashreplace",
            newline="\n",
            buffering=1,
        )
        redirected_stderr = os.fdopen(
            os.dup(log_fd),
            "w",
            encoding="utf-8",
            errors="backslashreplace",
            newline="\n",
            buffering=1,
        )
        sys.stdout = redirected_stdout
        sys.stderr = redirected_stderr
        yield log_identity
        redirected_stdout.flush()
        redirected_stderr.flush()
        os.fsync(log_fd)
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        if saved_stdout_fd is not None:
            os.dup2(saved_stdout_fd, 1)
        if saved_stderr_fd is not None:
            os.dup2(saved_stderr_fd, 2)
        if redirected_stdout is not None:
            redirected_stdout.close()
        if redirected_stderr is not None:
            redirected_stderr.close()
        if saved_stdout_fd is not None:
            os.close(saved_stdout_fd)
        if saved_stderr_fd is not None:
            os.close(saved_stderr_fd)
        os.close(log_fd)


def _emit_failure() -> None:
    try:
        sys.stderr.write('{"code":"INVENTORY_FAILED","status":"failed"}\n')
        sys.stderr.flush()
    except (BrokenPipeError, OSError):
        pass


def main(argv: list[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    staging_root: Path | None = None
    committed_root: Path | None = None
    commit_owned = False
    private_path: Path | None = None
    safe_path: Path | None = None
    log_path: Path | None = None
    private_identity: tuple[int, int] | None = None
    safe_identity: tuple[int, int] | None = None
    log_identity: tuple[int, int] | None = None
    try:
        args = parse_args(raw_argv)
        logging.disable(logging.CRITICAL)
        warnings.filterwarnings("ignore")
        (
            run_root,
            private_path,
            safe_path,
            log_path,
            committed_root,
        ) = resolve_inventory_artifacts(args.run_root)
        marker = load_run_root_marker(run_root)
        source_candidate = Path(os.path.abspath(args.source))
        if _is_link_or_junction(source_candidate):
            raise ValueError("UNSAFE_SOURCE_ROOT")
        source = resolve_source_root(args.source)
        if (
            private_path == safe_path
            or is_within(private_path, source)
            or is_within(safe_path, source)
        ):
            raise ValueError("UNSAFE_OUTPUT_LOCATION")
        staging_root = create_staging_directory(committed_root.parent)
        with redirect_process_output(log_path) as created_log_identity:
            log_identity = created_log_identity
            load_optional_dependencies()
            source_snapshot = stage_source_tree(source, staging_root)
            commit_staged_sources(staging_root, committed_root)
            staging_root = None
            commit_owned = True
            private_manifest, safe_report = build_inventory(
                source,
                source_snapshot=source_snapshot,
                vault_sources=committed_root,
            )
        private_manifest["pack_id"] = f"pack_{marker['nonce']}"
        expected_run_id = expected_run_id_for_schema(SAFE_SCHEMA, marker["nonce"])
        safe_report["run_id"] = expected_run_id
        if not validate_report(safe_report, expected_run_id=expected_run_id):
            raise ValueError("SAFE_REPORT_REJECTED")
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        private_identity = atomic_write_json(private_path, private_manifest)
        safe_identity = atomic_write_safe_json(safe_path, safe_report)
        if load_run_root_marker(run_root) != marker:
            raise ValueError("RUN_ROOT_MARKER_CHANGED")
        acknowledgement = '{"code":"INVENTORY_REPORT_WRITTEN","status":"private"}\n'
        if sys.stdout.write(acknowledgement) != len(acknowledgement):
            raise OSError("SHORT_STDOUT_WRITE")
        sys.stdout.flush()
        return 3 if safe_report["status"] == "blocked" else 0
    except Exception:
        remove_owned_output(safe_path, safe_identity is not None, safe_identity)
        remove_owned_output(private_path, private_identity is not None, private_identity)
        # Keep a log created by this attempt inside the private run root.  It is
        # the only diagnostic evidence available after stdout/stderr have been
        # deliberately reduced to fixed, spoiler-free failure codes.
        _cleanup_vault_artifacts(staging_root, committed_root, commit_owned=commit_owned)
        _emit_failure()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
