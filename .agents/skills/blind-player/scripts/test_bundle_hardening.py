#!/usr/bin/env python3
"""Focused synthetic regressions for the private bundle validator."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import validate_bundle  # noqa: E402
import validate_safe_report  # noqa: E402
from test_tools import (  # noqa: E402
    add_host_release,
    add_valid_clue,
    evidence,
    issue_codes,
    rehash,
    valid_bundle,
)


DISABLED_PUBLICATION = {"op": "clue_published", "clueId": "clue_aaaaaaaa"}


def set_at(value: object, path: tuple[object, ...], replacement: object) -> None:
    cursor = value
    for part in path[:-1]:
        cursor = cursor[part]
    cursor[path[-1]] = replacement


def disabled_publication_bundle() -> dict[str, object]:
    bundle = valid_bundle()
    add_valid_clue(bundle, {"op": "always"})
    publication = bundle["clues"]["clue_aaaaaaaa"]["publication"]
    publication["allowed"] = False
    publication["revealedFaceIds"] = []
    add_host_release(bundle, {"op": "always"})
    bundle["locations"]["loc_aaaaaaaa"] = {
        "locationId": "loc_aaaaaaaa",
        "nameContentId": "cnt_aaaaaaaa",
        "availableWhen": {"op": "always"},
        "searchPolicy": {
            "mode": "draw_without_replacement",
            "perPlayerLimit": None,
            "globalLimit": None,
            "resetAtStageIds": [],
        },
        "cluePool": [
            {
                "clueId": "clue_aaaaaaaa",
                "order": None,
                "copies": 1,
                "availableWhen": {"op": "always"},
            }
        ],
        "evidence": [evidence()],
    }
    bundle["stages"]["stage_aaaaaaaa"]["locationIds"] = ["loc_aaaaaaaa"]
    rehash(bundle)
    return bundle


def make_run_root(parent: Path, bundle: dict[str, object] | None = None) -> Path:
    root = parent / "opaque-run-root"
    root.mkdir(parents=True)
    (root / validate_safe_report.RUN_ROOT_MARKER).write_bytes(
        validate_safe_report.RUN_ROOT_MARKER_BYTES
    )
    (root / "vault").mkdir()
    (root / "safe").mkdir()
    (root / "private").mkdir()
    (root / "vault" / "sources").mkdir()
    materialized = copy.deepcopy(bundle or valid_bundle())
    blob = b"x"
    digest = "sha256:" + hashlib.sha256(blob).hexdigest()
    source = materialized["sources"]["src_aaaaaaaa"]
    source["sha256"] = digest
    source["byteLength"] = len(blob)
    source["pages"][0]["sha256"] = digest
    rehash(materialized)
    blob_ref = "vault:sources/src_0000000000000001.blob"
    (root / "vault" / "sources" / "src_0000000000000001.blob").write_bytes(blob)
    manifest = {
        "schema": "blind-private-inventory/1.0",
        "pack_id": "pack_00000000000000000000000000000000",
        "classification": "RAW_SECRET",
        "sources": [
            {
                "source_id": "src_aaaaaaaa",
                "path_ref": "vault:path:0001",
                "relative_path": "private-synthetic.png",
                "classification": "RAW_SECRET",
                "byte_length": len(blob),
                "sha256": digest,
                "media_type": "image/png",
                "kind": "image",
                "vault_blob_ref": blob_ref,
                "image": {
                    "metadata_status": "ok",
                    "width": 1,
                    "height": 1,
                },
            }
        ],
    }
    (root / "private" / "source-inventory.json").write_text(
        json.dumps(manifest, ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    (root / "vault" / "bundle.json").write_text(
        json.dumps(materialized, ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    return root


class TrackingStdout(io.StringIO):
    def __init__(self, fail_flush: bool = False) -> None:
        super().__init__()
        self.fail_flush = fail_flush
        self.was_flushed = False

    def flush(self) -> None:
        self.was_flushed = True
        if self.fail_flush:
            raise BrokenPipeError
        super().flush()


class BundleHardeningTests(unittest.TestCase):
    def test_collection_shape_codes_are_allowed_safe_output(self) -> None:
        fields = {
            "sources": "INVALID_SOURCES_COLLECTION",
            "assets": "INVALID_ASSETS_COLLECTION",
            "contentBlocks": "INVALID_CONTENT_COLLECTION",
            "roles": "INVALID_ROLES_COLLECTION",
            "stages": "INVALID_STAGES_COLLECTION",
            "locations": "INVALID_LOCATIONS_COLLECTION",
            "clues": "INVALID_CLUES_COLLECTION",
        }
        for field, code in fields.items():
            with self.subTest(field=field):
                bundle = valid_bundle()
                bundle[field] = []
                rehash(bundle)
                report = validate_bundle.validate_bundle(bundle)
                self.assertIn(code, issue_codes(report))
                self.assertTrue(validate_safe_report.validate_report(report))

    def test_initial_clue_audience_is_holder_only(self) -> None:
        holder = valid_bundle()
        add_valid_clue(holder, {"op": "always"})
        rehash(holder)
        self.assertTrue(validate_bundle.validate_bundle(holder)["freeze_ready"])

        for audience in ("assigned-role", "session"):
            with self.subTest(audience=audience):
                bundle = copy.deepcopy(holder)
                bundle["clues"]["clue_aaaaaaaa"]["acquisition"]["initialAudience"] = audience
                rehash(bundle)
                report = validate_bundle.validate_bundle(bundle)
                self.assertIn("INVALID_ACQUISITION", issue_codes(report))
                self.assertFalse(report["freeze_ready"])

    def test_verified_source_requires_review_or_manifest(self) -> None:
        for method in ("layout", "ocr"):
            with self.subTest(method=method):
                bundle = valid_bundle()
                bundle["sources"]["src_aaaaaaaa"]["classification"]["method"] = method
                rehash(bundle)
                report = validate_bundle.validate_bundle(bundle)
                self.assertIn("INVALID_SOURCE_METHOD", issue_codes(report))
                self.assertFalse(report["freeze_ready"])

        for method in ("review", "manifest"):
            with self.subTest(method=method):
                bundle = valid_bundle()
                bundle["sources"]["src_aaaaaaaa"]["classification"]["method"] = method
                rehash(bundle)
                report = validate_bundle.validate_bundle(bundle)
                self.assertNotIn("INVALID_SOURCE_METHOD", issue_codes(report))
                self.assertTrue(report["freeze_ready"])

        proposed = valid_bundle()
        classification = proposed["sources"]["src_aaaaaaaa"]["classification"]
        classification["status"] = "proposed"
        classification["method"] = "layout"
        rehash(proposed)
        self.assertNotIn(
            "INVALID_SOURCE_METHOD",
            issue_codes(validate_bundle.validate_bundle(proposed)),
        )

    def test_every_condition_outlet_rejects_disabled_publication_dependency(self) -> None:
        base = disabled_publication_bundle()
        self.assertTrue(validate_bundle.validate_bundle(base)["freeze_ready"])
        condition_paths = {
            "content grant": (
                "contentBlocks",
                "cnt_aaaaaaaa",
                "visibility",
                "grants",
                0,
                "when",
            ),
            "stage enter": ("stages", "stage_aaaaaaaa", "enterWhen"),
            "stage complete": ("stages", "stage_aaaaaaaa", "completeWhen"),
            "role section": (
                "roles",
                "role_aaaaaaaa",
                "sections",
                0,
                "unlockWhen",
            ),
            "location": ("locations", "loc_aaaaaaaa", "availableWhen"),
            "clue pool": (
                "locations",
                "loc_aaaaaaaa",
                "cluePool",
                0,
                "availableWhen",
            ),
            "face reveal": (
                "clues",
                "clue_aaaaaaaa",
                "faces",
                0,
                "revealWhen",
            ),
            "clue acquisition": (
                "clues",
                "clue_aaaaaaaa",
                "acquisition",
                "when",
            ),
            "clue publication": (
                "clues",
                "clue_aaaaaaaa",
                "publication",
                "publishWhen",
            ),
            "host release": ("hostPack", "releasePlan", 0, "when"),
        }
        for outlet, path in condition_paths.items():
            with self.subTest(outlet=outlet):
                bundle = copy.deepcopy(base)
                set_at(bundle, path, copy.deepcopy(DISABLED_PUBLICATION))
                rehash(bundle)
                report = validate_bundle.validate_bundle(bundle)
                self.assertIn("IMPOSSIBLE_CONDITION_DEPENDENCY", issue_codes(report))
                self.assertFalse(report["freeze_ready"])

    def test_evidence_bounds_are_compared_exactly(self) -> None:
        for axis, extent in (("x", "width"), ("y", "height")):
            with self.subTest(axis=axis):
                bundle = valid_bundle()
                region = bundle["contentBlocks"]["cnt_aaaaaaaa"]["trace"]["evidence"][0][
                    "region"
                ]
                region[axis] = 0.000001
                region[extent] = 1.0
                rehash(bundle)
                self.assertIn(
                    "INVALID_CONTENT_EVIDENCE",
                    issue_codes(validate_bundle.validate_bundle(bundle)),
                )

        boundary = valid_bundle()
        region = boundary["contentBlocks"]["cnt_aaaaaaaa"]["trace"]["evidence"][0]["region"]
        region["x"] = 0.000001
        region["width"] = 0.999999
        rehash(boundary)
        self.assertTrue(validate_bundle.validate_bundle(boundary)["freeze_ready"])

    def test_safe_report_has_no_private_identifier_channels(self) -> None:
        first = valid_bundle()
        second = valid_bundle()
        first["script"]["versionId"] = {"z": 1, "a": 2}
        second["script"]["versionId"] = {"a": 2, "z": 1}
        rehash(first)
        rehash(second)
        first_report = validate_bundle.validate_bundle(first)
        second_report = validate_bundle.validate_bundle(second)
        self.assertEqual(first_report, second_report)
        self.assertNotIn("version_id", first_report)
        self.assertTrue(all(set(item) == {"code", "severity", "count"} for item in first_report["issues"]))
        self.assertEqual(first_report["run_id"], validate_safe_report.derive_run_id(first_report))
        self.assertTrue(validate_safe_report.validate_report(first_report))

        private_a = valid_bundle()
        private_b = valid_bundle()
        private_b["script"]["versionId"] = "ver_bbbbbbbb"
        private_b["contentBlocks"]["cnt_bbbbbbbb"]["payload"]["text"] = "different synthetic secret"
        rehash(private_b)
        self.assertEqual(
            validate_bundle.validate_bundle(private_a),
            validate_bundle.validate_bundle(private_b),
        )

    def test_cli_uses_fixed_layout_and_canonical_safe_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = make_run_root(Path(temporary))
            stdout = TrackingStdout()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = validate_bundle.main(["--run-root", str(root)])
            safe_path = root / "safe" / "validation.json"
            self.assertEqual(result, 0)
            self.assertTrue(stdout.was_flushed)
            self.assertEqual(stderr.getvalue(), "")
            self.assertEqual(
                stdout.getvalue(),
                '{"code":"VALIDATION_REPORT_WRITTEN","status":"private"}\n',
            )
            report = json.loads(safe_path.read_text(encoding="ascii"))
            self.assertEqual(safe_path.read_bytes(), validate_safe_report.canonical_safe_bytes(report))
            marker = validate_safe_report.load_run_root_marker(root)
            expected_run_id = validate_safe_report.expected_run_id_for_schema(
                validate_bundle.SAFE_SCHEMA, marker["nonce"]
            )
            self.assertTrue(
                validate_safe_report.validate_report(
                    report, expected_run_id=expected_run_id
                )
            )

    def test_cli_blocks_inventory_bundle_or_blob_provenance_mismatch(self) -> None:
        for mismatch in ("bundle", "blob", "missing-manifest"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as temporary:
                root = make_run_root(Path(temporary))
                if mismatch == "bundle":
                    bundle_path = root / "vault" / "bundle.json"
                    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
                    bundle["sources"]["src_aaaaaaaa"]["originalPathRef"] = "vault:path:9999"
                    rehash(bundle)
                    bundle_path.write_text(
                        json.dumps(bundle, ensure_ascii=False, allow_nan=False),
                        encoding="utf-8",
                    )
                elif mismatch == "blob":
                    (root / "vault" / "sources" / "src_0000000000000001.blob").write_bytes(
                        b"tampered"
                    )
                else:
                    (root / "private" / "source-inventory.json").unlink()

                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    result = validate_bundle.main(["--run-root", str(root)])
                report = json.loads(
                    (root / "safe" / "validation.json").read_text(encoding="ascii")
                )
                self.assertEqual(result, 3)
                self.assertFalse(report["freeze_ready"])
                self.assertIn("INVENTORY_PROVENANCE_MISMATCH", issue_codes(report))

    def test_cli_failures_preserve_preexisting_safe_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = make_run_root(Path(temporary))
            safe_path = root / "safe" / "validation.json"

            failure_modes = ("argument", "existing-output", "broken-pipe")
            for failure_mode in failure_modes:
                with self.subTest(failure_mode=failure_mode):
                    safe_path.write_text("stale synthetic output", encoding="utf-8")
                    stdout = TrackingStdout(fail_flush=failure_mode == "broken-pipe")
                    stderr = io.StringIO()
                    argv = ["--run-root", str(root)]
                    if failure_mode == "argument":
                        argv.append("--unexpected")
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        result = validate_bundle.main(argv)
                    self.assertEqual(result, 2)
                    self.assertEqual(
                        safe_path.read_text(encoding="utf-8"),
                        "stale synthetic output",
                    )
                    self.assertNotIn(str(root), stderr.getvalue())
                    self.assertEqual(
                        stderr.getvalue(),
                        '{"code":"BUNDLE_VALIDATION_FAILED","status":"failed"}\n',
                    )

    def test_duplicate_run_roots_fail_and_preserve_every_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            first = make_run_root(parent / "first")
            second = make_run_root(parent / "second")
            safe_paths = [
                first / "safe" / "validation.json",
                second / "safe" / "validation.json",
            ]
            for safe_path in safe_paths:
                safe_path.write_text("stale synthetic output", encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = validate_bundle.main(
                    ["--run-root", str(first), f"--run-root={second}"]
                )
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertTrue(all(safe_path.is_file() for safe_path in safe_paths))
            self.assertNotIn(str(first), stderr.getvalue())
            self.assertNotIn(str(second), stderr.getvalue())

    def test_cli_rejects_bad_marker_and_git_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            bad_marker = make_run_root(parent / "bad-parent")
            marker = bad_marker / validate_safe_report.RUN_ROOT_MARKER
            marker.write_bytes(b"wrong\n")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(validate_bundle.main(["--run-root", str(bad_marker)]), 2)

        with tempfile.TemporaryDirectory() as temporary:
            git_parent = Path(temporary)
            (git_parent / ".git").mkdir()
            git_root = make_run_root(git_parent)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(validate_bundle.main(["--run-root", str(git_root)]), 2)


if __name__ == "__main__":
    unittest.main()
