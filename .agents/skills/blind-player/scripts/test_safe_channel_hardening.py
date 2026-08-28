#!/usr/bin/env python3
"""Adversarial tests for the player-visible safe-report boundary."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import validate_safe_report  # noqa: E402
import init_run_root  # noqa: E402


def validation_report() -> dict[str, object]:
    report: dict[str, object] = {
        "report_schema": "blind-validation-safe/1.0",
        "run_id": "run_00000000000000000000000000000000",
        "status": "blocked",
        "counts": {
            "sources": 0,
            "pages": 0,
            "assets": 0,
            "content_blocks": 0,
            "role_slots": 0,
            "stages": 0,
            "locations": 0,
            "clues": 0,
            "quarantined": 0,
        },
        "quality": {
            "ocr_needs_review": 0,
            "pairing_needs_review": 0,
            "blocking_issues": 2,
            "warnings": 0,
        },
        "issues": [
            {"code": "INVALID_POLICY", "severity": "blocking", "count": 1},
            {"code": "INVALID_SCRIPT_SHAPE", "severity": "blocking", "count": 1},
        ],
        "freeze_ready": False,
        "published": False,
    }
    report["run_id"] = validate_safe_report.derive_run_id(report)
    return report


def inventory_report() -> dict[str, object]:
    report: dict[str, object] = {
        "report_schema": "blind-inventory-safe/1.0",
        "run_id": "pack_00000000000000000000000000000000",
        "status": "inventory_complete",
        "counts": {
            "files": 1,
            "bytes": 1,
            "images": 1,
            "pdfs": 0,
            "pdf_pages": 0,
            "other_files": 0,
            "numeric_sequence_groups": 1,
            "numeric_sequence_pages": 1,
            "duplicate_content_groups": 0,
            "duplicate_files": 0,
        },
        "quality": {
            "unreadable_files": 0,
            "missing_numeric_pages": 0,
            "duplicate_numeric_page_numbers": 0,
            "blocking_issues": 0,
        },
        "issues": [],
        "published": False,
    }
    report["run_id"] = validate_safe_report.derive_run_id(report)
    return report


def initialize_with_nonce(root: Path, nonce: str) -> Path:
    with patch.object(init_run_root.secrets, "token_hex", return_value=nonce) as token_hex:
        initialized = init_run_root.initialize(root)
    token_hex.assert_called_once_with(16)
    return initialized


def bind_report_to_nonce(report: dict[str, object], nonce: str) -> dict[str, object]:
    bound = copy.deepcopy(report)
    bound["run_id"] = validate_safe_report.expected_run_id_for_schema(
        bound["report_schema"], nonce
    )
    return bound


def write_fixed_report(root: Path, report_kind: str, report: dict[str, object]) -> bytes:
    path, expected_schema = validate_safe_report.fixed_safe_report_path(root, report_kind)
    if report["report_schema"] != expected_schema:
        raise AssertionError("fixture schema does not match report kind")
    canonical = validate_safe_report.canonical_safe_bytes(report)
    path.write_bytes(canonical)
    return canonical


class SafeChannelHardeningTests(unittest.TestCase):
    def test_init_creates_exclusive_canonical_nonce_marker_outside_git(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "opaque-run"
            initialized = initialize_with_nonce(root, nonce)
            self.assertEqual(initialized, root.resolve())
            self.assertEqual(
                (root / validate_safe_report.RUN_ROOT_MARKER).read_bytes(),
                validate_safe_report.canonical_run_root_marker_bytes(nonce),
            )
            self.assertEqual(
                validate_safe_report.load_run_root_marker(root),
                {"schema": validate_safe_report.RUN_ROOT_SCHEMA, "nonce": nonce},
            )
            self.assertEqual(validate_safe_report.resolve_private_run_root(root), root.resolve())
            original_marker = (root / validate_safe_report.RUN_ROOT_MARKER).read_bytes()
            with self.assertRaises(ValueError):
                init_run_root.initialize(root)
            self.assertEqual(
                (root / validate_safe_report.RUN_ROOT_MARKER).read_bytes(), original_marker
            )

        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            (repository / ".git").mkdir()
            root = repository / "opaque-run"
            with self.assertRaises(ValueError):
                init_run_root.initialize(root)
            self.assertFalse(root.exists())

    def test_marker_parser_requires_unique_canonical_ascii_json(self) -> None:
        nonce = "abcdefabcdefabcdefabcdefabcdefab"
        invalid_markers = {
            "pretty": json.dumps(
                {"schema": validate_safe_report.RUN_ROOT_SCHEMA, "nonce": nonce}, indent=2
            ).encode("ascii"),
            "wrong_order": (
                '{"schema":"blind-player-run-root/1.0","nonce":"' + nonce + '"}\n'
            ).encode("ascii"),
            "duplicate": (
                '{"nonce":"' + nonce + '","nonce":"' + nonce
                + '","schema":"blind-player-run-root/1.0"}\n'
            ).encode("ascii"),
            "extra": (
                '{"extra":false,"nonce":"' + nonce
                + '","schema":"blind-player-run-root/1.0"}\n'
            ).encode("ascii"),
            "uppercase": validate_safe_report.canonical_safe_bytes(
                {"schema": validate_safe_report.RUN_ROOT_SCHEMA, "nonce": nonce.upper()}
            ),
        }
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            for index, (label, marker_bytes) in enumerate(invalid_markers.items()):
                with self.subTest(label=label):
                    root = parent / f"run-{index}"
                    initialize_with_nonce(root, nonce)
                    (root / validate_safe_report.RUN_ROOT_MARKER).write_bytes(marker_bytes)
                    with self.assertRaises(ValueError):
                        validate_safe_report.load_run_root_marker(root)
                    with self.assertRaises(ValueError):
                        validate_safe_report.resolve_private_run_root(root)

    def test_expected_run_id_binds_schema_and_trusted_nonce(self) -> None:
        nonce = "22222222222222222222222222222222"
        self.assertEqual(
            validate_safe_report.expected_run_id_for_schema(
                "blind-inventory-safe/1.0", nonce
            ),
            "pack_" + nonce,
        )
        self.assertEqual(
            validate_safe_report.expected_run_id_for_schema(
                "blind-validation-safe/1.0", nonce
            ),
            "run_" + nonce,
        )

        report = inventory_report()
        self.assertTrue(validate_safe_report.validate_report(report))
        bound = bind_report_to_nonce(report, nonce)
        expected = "pack_" + nonce
        self.assertTrue(
            validate_safe_report.validate_report(bound, expected_run_id=expected)
        )
        self.assertFalse(validate_safe_report.validate_report(bound))
        self.assertFalse(
            validate_safe_report.validate_report(
                bound, expected_run_id="pack_33333333333333333333333333333333"
            )
        )
        self.assertFalse(
            validate_safe_report.validate_report(bound, expected_run_id="run_" + nonce)
        )

    def test_issue_order_and_object_refs_are_not_channels(self) -> None:
        report = validation_report()
        self.assertTrue(validate_safe_report.validate_report(report))
        reordered = copy.deepcopy(report)
        reordered["issues"] = list(reversed(reordered["issues"]))
        reordered["run_id"] = validate_safe_report.derive_run_id(reordered)
        self.assertFalse(validate_safe_report.validate_report(reordered))
        referenced = copy.deepcopy(report)
        referenced["issues"][0]["object_ref"] = "ref_aaaaaaaaaaaaaaaa"
        referenced["run_id"] = validate_safe_report.derive_run_id(referenced)
        self.assertFalse(validate_safe_report.validate_report(referenced))

    def test_impossible_safe_counts_are_rejected(self) -> None:
        duplicate = inventory_report()
        duplicate["counts"]["duplicate_content_groups"] = 1
        duplicate["counts"]["duplicate_files"] = 2
        duplicate["issues"] = [
            {"code": "DUPLICATE_CONTENT", "severity": "warning", "count": 1}
        ]
        duplicate["run_id"] = validate_safe_report.derive_run_id(duplicate)
        self.assertFalse(validate_safe_report.validate_report(duplicate))

        review = validation_report()
        review["quality"]["ocr_needs_review"] = 1
        review["run_id"] = validate_safe_report.derive_run_id(review)
        self.assertFalse(validate_safe_report.validate_report(review))

        pdf = inventory_report()
        pdf["counts"]["pdf_pages"] = 999
        pdf["run_id"] = validate_safe_report.derive_run_id(pdf)
        self.assertFalse(validate_safe_report.validate_report(pdf))

        numeric = inventory_report()
        numeric["counts"]["numeric_sequence_groups"] = 0
        numeric["counts"]["numeric_sequence_pages"] = 0
        numeric["quality"]["missing_numeric_pages"] = 1
        numeric["issues"] = [
            {"code": "MISSING_NUMERIC_PAGES", "severity": "blocking", "count": 1}
        ]
        numeric["quality"]["blocking_issues"] = 1
        numeric["status"] = "blocked"
        numeric["run_id"] = validate_safe_report.derive_run_id(numeric)
        self.assertFalse(validate_safe_report.validate_report(numeric))

    def test_cli_uses_fixed_path_and_emits_validated_canonical_bytes(self) -> None:
        nonce = "44444444444444444444444444444444"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run"
            initialize_with_nonce(root, nonce)
            report = bind_report_to_nonce(inventory_report(), nonce)
            canonical = write_fixed_report(root, "inventory", report)
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    "--run-root",
                    str(root),
                    "--report",
                    "inventory",
                ],
                capture_output=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, canonical)
        self.assertEqual(result.stderr, b"")

    def test_cli_rejects_cross_run_replay_and_arbitrary_report_path(self) -> None:
        first_nonce = "55555555555555555555555555555555"
        second_nonce = "66666666666666666666666666666666"
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            first_root = parent / "first"
            second_root = parent / "second"
            initialize_with_nonce(first_root, first_nonce)
            initialize_with_nonce(second_root, second_nonce)
            replay = bind_report_to_nonce(inventory_report(), first_nonce)
            first_bytes = write_fixed_report(first_root, "inventory", replay)
            write_fixed_report(second_root, "inventory", replay)

            first_result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    "--run-root",
                    str(first_root),
                    "--report",
                    "inventory",
                ],
                capture_output=True,
                check=False,
            )
            replay_result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    "--run-root",
                    str(second_root),
                    "--report",
                    "inventory",
                ],
                capture_output=True,
                check=False,
            )
            arbitrary = parent / "arbitrary.json"
            arbitrary.write_bytes(first_bytes)
            arbitrary_result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    str(arbitrary),
                ],
                capture_output=True,
                check=False,
            )

        self.assertEqual(first_result.returncode, 0)
        self.assertEqual(first_result.stdout, first_bytes)
        self.assertEqual(replay_result.returncode, 2)
        self.assertEqual(replay_result.stdout, b"")
        self.assertEqual(arbitrary_result.returncode, 2)
        self.assertEqual(arbitrary_result.stdout, b"")

    def test_cli_rejects_noncanonical_bytes_wrong_kind_and_help_without_echo(self) -> None:
        nonce = "77777777777777777777777777777777"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run"
            initialize_with_nonce(root, nonce)
            report = bind_report_to_nonce(inventory_report(), nonce)
            path, _schema = validate_safe_report.fixed_safe_report_path(root, "inventory")
            path.write_text(json.dumps(report, indent=2), encoding="ascii")
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    "--run-root",
                    str(root),
                    "--report",
                    "inventory",
                ],
                capture_output=True,
                check=False,
            )
            validation_path, _schema = validate_safe_report.fixed_safe_report_path(
                root, "validation"
            )
            validation_path.write_bytes(validate_safe_report.canonical_safe_bytes(report))
            wrong_kind = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_DIR / "validate_safe_report.py"),
                    "--run-root",
                    str(root),
                    "--report",
                    "validation",
                ],
                capture_output=True,
                check=False,
            )

        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(
            result.stderr.strip(), b'{"code":"SAFE_REPORT_REJECTED","status":"blocked"}'
        )
        self.assertEqual(wrong_kind.returncode, 2)
        self.assertEqual(wrong_kind.stdout, b"")

        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPT_DIR / "validate_safe_report.py"),
                "--help",
                "SECRET_CANARY",
            ],
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"SECRET_CANARY", result.stdout + result.stderr)
        self.assertEqual(result.stderr.strip(), b'{"code":"SAFE_REPORT_REJECTED","status":"blocked"}')


if __name__ == "__main__":
    unittest.main()
