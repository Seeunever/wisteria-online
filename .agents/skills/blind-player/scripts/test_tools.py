#!/usr/bin/env python3
"""Behavioral tests for spoiler-safe inventory and validation tools."""

from __future__ import annotations

import base64
import copy
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

import inventory_sources  # noqa: E402
import init_run_root  # noqa: E402
import validate_bundle  # noqa: E402
import validate_safe_report  # noqa: E402


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
)
CANARY = "STORY_CANARY_NEVER_EXPORT"


def evidence() -> dict[str, object]:
    return {
        "sourceId": "src_aaaaaaaa",
        "pageId": "page_aaaaaaaa",
        "region": {"unit": "normalized", "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
        "side": "single",
        "readingOrder": 0,
    }


def grant(principal: str, policy_id: str) -> dict[str, object]:
    return {
        "policyId": policy_id,
        "principal": {
            "kind": principal,
            "subjectId": "role_aaaaaaaa" if principal == "role_assignee" else None,
        },
        "when": {"op": "always"},
        "evidence": [evidence()],
    }


def content_block(content_id: str, level: str, private: bool) -> dict[str, object]:
    policy_id = "policy_" + content_id.split("_", 1)[1]
    return {
        "contentId": content_id,
        "kind": "text",
        "payload": {"text": CANARY if private else "safe synthetic label"},
        "assetIds": [],
        "classification": {
            "level": level,
            "compartments": ["role:role_aaaaaaaa"] if level == "L2" else [],
            "taintSourceIds": ["src_aaaaaaaa"],
        },
        "visibility": {
            "default": "deny",
            "grants": [
                grant("role_assignee" if level == "L2" else "room_member", policy_id)
            ],
        },
        "trace": {"evidence": [evidence()], "ocrExtractionId": None, "reviewStatus": "verified"},
    }


def valid_bundle() -> dict[str, object]:
    digest = "sha256:" + "a" * 64
    bundle = {
        "schemaVersion": "blind-script/1.0",
        "script": {
            "scriptId": "scr_aaaaaaaa",
            "versionId": "ver_aaaaaaaa",
            "parentVersionId": None,
            "titleContentId": "cnt_aaaaaaaa",
            "locale": "zh-CN",
            "playerCount": {"min": 1, "max": 1},
            "state": "draft",
            "sourceSetHash": digest,
            "canonicalPayloadHash": None,
        },
        "sources": {
            "src_aaaaaaaa": {
                "sourceId": "src_aaaaaaaa",
                "safeLabel": "source-0001",
                "originalPathRef": "vault:path:0001",
                "mediaType": "image/png",
                "sha256": digest,
                "byteLength": 1,
                "sourceClass": {"kind": "public_material", "subjectId": None},
                "classification": {"status": "verified", "method": "review", "confidence": 1.0},
                "pages": [
                    {
                        "pageId": "page_aaaaaaaa",
                        "index": 0,
                        "width": 1,
                        "height": 1,
                        "rotation": 0,
                        "sha256": digest,
                    }
                ],
            }
        },
        "assets": {
            "asset_aaaaaaaa": {
                "assetId": "asset_aaaaaaaa",
                "sourceIds": ["src_aaaaaaaa"],
                "pageObjects": [
                    {
                        "sourceId": "src_aaaaaaaa",
                        "pageId": "page_aaaaaaaa",
                        "mediaType": "image/webp",
                        "sha256": digest,
                        "byteLength": 1,
                        "width": 1,
                        "height": 1,
                    }
                ],
            }
        },
        "contentBlocks": {
            "cnt_aaaaaaaa": content_block("cnt_aaaaaaaa", "L1", False),
            "cnt_bbbbbbbb": content_block("cnt_bbbbbbbb", "L2", True),
        },
        "roles": {
            "role_aaaaaaaa": {
                "roleId": "role_aaaaaaaa",
                "slot": 1,
                "displayNameContentId": "cnt_aaaaaaaa",
                "sections": [
                    {
                        "sectionId": "section_aaaaaaaa",
                        "kind": "background",
                        "stageId": "stage_aaaaaaaa",
                        "order": 1,
                        "contentIds": ["cnt_bbbbbbbb"],
                        "unlockWhen": {"op": "stage_reached", "stageId": "stage_aaaaaaaa"},
                        "evidence": [evidence()],
                    }
                ],
            }
        },
        "stages": {
            "stage_aaaaaaaa": {
                "stageId": "stage_aaaaaaaa",
                "sequence": 1,
                "labelContentId": "cnt_aaaaaaaa",
                "enterWhen": {"op": "always"},
                "completeWhen": {"op": "always"},
                "allowedActions": ["read_role_section"],
                "locationIds": [],
                "evidence": [evidence()],
            }
        },
        "locations": {},
        "clues": {},
        "hostPack": {
            "hostPackId": "host_aaaaaaaa",
            "instructionContentIds": [],
            "resolutionSections": [],
            "answerKeys": [],
            "releasePlan": [],
            "evidence": [],
        },
        "policy": {"default": "deny", "conditionLanguage": "blind-ast/1.0"},
        "validation": {"profile": "blind-player/1.0"},
    }
    bundle["script"]["sourceSetHash"] = validate_bundle.compute_source_set_hash(bundle["sources"])
    bundle["script"]["canonicalPayloadHash"] = validate_bundle.compute_canonical_payload_hash(bundle)
    return bundle


def rehash(bundle: dict[str, object]) -> None:
    bundle["script"]["sourceSetHash"] = validate_bundle.compute_source_set_hash(bundle["sources"])
    bundle["script"]["canonicalPayloadHash"] = validate_bundle.compute_canonical_payload_hash(bundle)


def add_host_release(bundle: dict[str, object], when: dict[str, object]) -> None:
    host_content = content_block("cnt_cccccccc", "L3", True)
    host_content["visibility"]["grants"] = []
    bundle["contentBlocks"]["cnt_cccccccc"] = host_content
    bundle["hostPack"]["releasePlan"] = [
        {
            "releaseId": "release_aaaaaaaa",
            "contentIds": ["cnt_cccccccc"],
            "when": when,
            "evidence": [evidence()],
        }
    ]
    bundle["hostPack"]["evidence"] = [evidence()]


def add_valid_clue(
    bundle: dict[str, object],
    publication_when: dict[str, object],
    acquisition_when: dict[str, object] | None = None,
) -> None:
    clue_content = content_block("cnt_dddddddd", "L2", True)
    clue_content["assetIds"] = ["asset_aaaaaaaa"]
    clue_content["classification"]["compartments"] = ["clue:clue_aaaaaaaa"]
    clue_principal = clue_content["visibility"]["grants"][0]["principal"]
    clue_principal["kind"] = "clue_holder"
    clue_principal["subjectId"] = "clue_aaaaaaaa"
    bundle["contentBlocks"]["cnt_dddddddd"] = clue_content
    bundle["clues"]["clue_aaaaaaaa"] = {
        "clueId": "clue_aaaaaaaa",
        "kind": "card",
        "faces": [
            {
                "faceId": "face_aaaaaaaa",
                "side": "single",
                "assetIds": ["asset_aaaaaaaa"],
                "contentIds": ["cnt_dddddddd"],
                "revealWhen": {"op": "clue_held", "clueId": "clue_aaaaaaaa"},
                "evidence": [evidence()],
            }
        ],
        "pairing": {
            "status": "verified",
            "method": "review",
            "confidence": 1.0,
            "evidence": [evidence()],
        },
        "acquisition": {
            "when": acquisition_when or {"op": "always"},
            "initialAudience": "holder",
        },
        "publication": {
            "allowed": True,
            "publishWhen": publication_when,
            "revealedFaceIds": ["face_aaaaaaaa"],
            "evidence": [evidence()],
        },
    }


def issue_codes(report: dict[str, object]) -> set[str]:
    return {item["code"] for item in report["issues"]}


def leaf_paths(value: object, prefix: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    result: list[tuple[object, ...]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            result.extend(leaf_paths(item, prefix + (key,)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            result.extend(leaf_paths(item, prefix + (index,)))
    else:
        result.append(prefix)
    return result


def replace_at(value: object, path: tuple[object, ...], replacement: object) -> None:
    cursor = value
    for part in path[:-1]:
        cursor = cursor[part]
    cursor[path[-1]] = replacement


class SafeToolTests(unittest.TestCase):
    def test_inventory_safe_report_never_contains_paths_or_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            (source / "spoiler-role-name").mkdir(parents=True)
            (source / "solution-name").mkdir(parents=True)
            (source / "spoiler-role-name" / "1.png").write_bytes(PNG_1X1)
            (source / "solution-name" / "2.png").write_bytes(PNG_1X1)
            private, safe = inventory_sources.build_inventory(source)
            private_text = json.dumps(private, ensure_ascii=False)
            safe_text = json.dumps(safe, ensure_ascii=False)
            self.assertIn("spoiler-role-name", private_text)
            self.assertNotIn("spoiler-role-name", safe_text)
            self.assertNotIn("solution-name", safe_text)
            self.assertNotIn(CANARY, safe_text)
            self.assertTrue(validate_safe_report.validate_report(safe))

    def test_safe_report_rejects_free_form_field(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "1.png").write_bytes(PNG_1X1)
            _, safe = inventory_sources.build_inventory(source)
            unsafe = copy.deepcopy(safe)
            unsafe["summary"] = CANARY
            self.assertFalse(validate_safe_report.validate_report(unsafe))

    def test_valid_bundle_report_contains_no_private_payload(self) -> None:
        report = validate_bundle.validate_bundle(valid_bundle())
        report_text = json.dumps(report, ensure_ascii=False)
        self.assertTrue(report["freeze_ready"])
        self.assertNotIn(CANARY, report_text)
        self.assertTrue(validate_safe_report.validate_report(report))

    def test_host_secret_player_grant_blocks_without_leaking(self) -> None:
        bundle = valid_bundle()
        secret = bundle["contentBlocks"]["cnt_bbbbbbbb"]
        secret["classification"]["level"] = "L3"
        secret["classification"]["compartments"] = []
        report = validate_bundle.validate_bundle(bundle)
        report_text = json.dumps(report, ensure_ascii=False)
        self.assertFalse(report["freeze_ready"])
        self.assertIn("HIGH_SECRET_GRANT", report_text)
        self.assertNotIn(CANARY, report_text)
        self.assertTrue(validate_safe_report.validate_report(report))

    def test_safe_report_rejects_unknown_codes_prefixes_and_inconsistent_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "1.png").write_bytes(PNG_1X1)
            _, safe = inventory_sources.build_inventory(source)
            unknown = copy.deepcopy(safe)
            unknown["issues"] = [{"code": "SECRET_414141", "severity": "warning", "count": 1}]
            self.assertFalse(validate_safe_report.validate_report(unknown))
            wrong_prefix = copy.deepcopy(safe)
            wrong_prefix["run_id"] = "run_aaaaaaaaaaaaaaaa"
            self.assertFalse(validate_safe_report.validate_report(wrong_prefix))
            inconsistent = copy.deepcopy(safe)
            inconsistent["status"] = (
                "inventory_complete" if safe["status"] == "blocked" else "blocked"
            )
            self.assertFalse(validate_safe_report.validate_report(inconsistent))

    def test_duplicate_json_keys_and_nonfinite_numbers_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            duplicate = root / "duplicate.json"
            duplicate.write_text('{"status":"safe","status":"blocked"}', encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_safe_report.load_json_no_duplicates(duplicate)
            nonfinite = root / "nonfinite.json"
            nonfinite.write_text('{"value":NaN}', encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_safe_report.load_json_no_duplicates(nonfinite)

    def test_zero_area_and_cross_source_evidence_are_blocking(self) -> None:
        zero_area = valid_bundle()
        zero_area["contentBlocks"]["cnt_aaaaaaaa"]["trace"]["evidence"][0]["region"]["width"] = 0.0
        rehash(zero_area)
        report = validate_bundle.validate_bundle(zero_area)
        self.assertIn("INVALID_CONTENT_EVIDENCE", issue_codes(report))
        self.assertTrue(validate_safe_report.validate_report(report))

        cross_source = valid_bundle()
        second = copy.deepcopy(cross_source["sources"]["src_aaaaaaaa"])
        second["sourceId"] = "src_bbbbbbbb"
        second["safeLabel"] = "source-0002"
        second["originalPathRef"] = "vault:path:0002"
        second["pages"][0]["pageId"] = "page_bbbbbbbb"
        cross_source["sources"]["src_bbbbbbbb"] = second
        evidence_item = cross_source["contentBlocks"]["cnt_aaaaaaaa"]["trace"]["evidence"][0]
        evidence_item["sourceId"] = "src_bbbbbbbb"
        evidence_item["pageId"] = "page_aaaaaaaa"
        cross_source["contentBlocks"]["cnt_aaaaaaaa"]["classification"]["taintSourceIds"].append(
            "src_bbbbbbbb"
        )
        rehash(cross_source)
        report = validate_bundle.validate_bundle(cross_source)
        self.assertIn("INVALID_CONTENT_EVIDENCE", issue_codes(report))
        self.assertTrue(validate_safe_report.validate_report(report))

    def test_slots_compartments_cycles_and_release_ids_fail_closed(self) -> None:
        incomplete = valid_bundle()
        incomplete["script"]["playerCount"]["max"] = 2
        rehash(incomplete)
        self.assertIn("INCOMPLETE_ROLE_SLOTS", issue_codes(validate_bundle.validate_bundle(incomplete)))

        mismatch = valid_bundle()
        private = mismatch["contentBlocks"]["cnt_bbbbbbbb"]
        private["classification"]["compartments"] = ["stage:stage_aaaaaaaa"]
        rehash(mismatch)
        self.assertIn(
            "COMPARTMENT_PRINCIPAL_MISMATCH", issue_codes(validate_bundle.validate_bundle(mismatch))
        )

        cyclic = valid_bundle()
        cyclic["stages"]["stage_aaaaaaaa"]["enterWhen"] = {
            "op": "stage_reached",
            "stageId": "stage_aaaaaaaa",
        }
        rehash(cyclic)
        cyclic_codes = issue_codes(validate_bundle.validate_bundle(cyclic))
        self.assertIn("FORWARD_STAGE_DEPENDENCY", cyclic_codes)
        self.assertIn("CYCLIC_CONDITION_DEPENDENCY", cyclic_codes)

        undeclared = valid_bundle()
        undeclared["stages"]["stage_aaaaaaaa"]["completeWhen"] = {
            "op": "host_release",
            "releaseId": "release_aaaaaaaa",
        }
        rehash(undeclared)
        self.assertIn(
            "INVALID_CONDITION_REFERENCE", issue_codes(validate_bundle.validate_bundle(undeclared))
        )

    def test_release_cycles_are_blocking_but_optional_condition_branches_are_not(self) -> None:
        release_cycle = valid_bundle()
        add_host_release(
            release_cycle,
            {"op": "host_release", "releaseId": "release_aaaaaaaa"},
        )
        rehash(release_cycle)
        self.assertIn(
            "CYCLIC_CONDITION_DEPENDENCY",
            issue_codes(validate_bundle.validate_bundle(release_cycle)),
        )

        optional_branch = valid_bundle()
        optional_branch["stages"]["stage_aaaaaaaa"]["enterWhen"] = {
            "op": "any",
            "args": [
                {"op": "always"},
                {"op": "stage_reached", "stageId": "stage_aaaaaaaa"},
            ],
        }
        rehash(optional_branch)
        report = validate_bundle.validate_bundle(optional_branch)
        self.assertNotIn("CYCLIC_CONDITION_DEPENDENCY", issue_codes(report))
        self.assertNotIn("FORWARD_STAGE_DEPENDENCY", issue_codes(report))
        self.assertTrue(report["freeze_ready"])

    def test_double_negation_and_release_clue_cycles_are_blocking(self) -> None:
        double_negation = valid_bundle()
        double_negation["stages"]["stage_aaaaaaaa"]["enterWhen"] = {
            "op": "not",
            "arg": {
                "op": "not",
                "arg": {"op": "stage_reached", "stageId": "stage_aaaaaaaa"},
            },
        }
        rehash(double_negation)
        self.assertIn(
            "CYCLIC_CONDITION_DEPENDENCY",
            issue_codes(validate_bundle.validate_bundle(double_negation)),
        )

        cross_event = valid_bundle()
        add_valid_clue(
            cross_event,
            {"op": "host_release", "releaseId": "release_aaaaaaaa"},
        )
        add_host_release(
            cross_event,
            {"op": "clue_published", "clueId": "clue_aaaaaaaa"},
        )
        rehash(cross_event)
        self.assertIn(
            "CYCLIC_CONDITION_DEPENDENCY",
            issue_codes(validate_bundle.validate_bundle(cross_event)),
        )

    def test_stage_only_room_grant_is_allowed_when_condition_implies_stage(self) -> None:
        bundle = valid_bundle()
        private = content_block("cnt_eeeeeeee", "L2", True)
        bundle["contentBlocks"]["cnt_eeeeeeee"] = private
        private["classification"]["compartments"] = ["stage:stage_aaaaaaaa"]
        principal = private["visibility"]["grants"][0]["principal"]
        principal["kind"] = "room_after_event"
        principal["subjectId"] = None
        private["visibility"]["grants"][0]["when"] = {
            "op": "stage_reached",
            "stageId": "stage_aaaaaaaa",
        }
        rehash(bundle)
        report = validate_bundle.validate_bundle(bundle)
        self.assertNotIn("COMPARTMENT_TOO_BROAD", issue_codes(report))
        self.assertNotIn("COMPARTMENT_PRINCIPAL_MISMATCH", issue_codes(report))
        self.assertTrue(report["freeze_ready"])

    def test_resolution_section_must_reference_a_declared_release(self) -> None:
        bundle = valid_bundle()
        add_host_release(bundle, {"op": "always"})
        bundle["hostPack"]["resolutionSections"] = [
            {
                "sectionId": "section_bbbbbbbb",
                "contentIds": ["cnt_cccccccc"],
                "releaseId": "release_bbbbbbbb",
                "evidence": [evidence()],
            }
        ]
        rehash(bundle)
        self.assertIn("INVALID_HOST_PACK", issue_codes(validate_bundle.validate_bundle(bundle)))

    def test_invalid_dates_and_null_frozen_timestamp_are_blocking(self) -> None:
        invalid_date = valid_bundle()
        invalid_date["script"]["createdAt"] = "2026-02-31T12:00:00Z"
        rehash(invalid_date)
        self.assertIn(
            "INVALID_SCRIPT_TIMESTAMP", issue_codes(validate_bundle.validate_bundle(invalid_date))
        )

        null_frozen = valid_bundle()
        null_frozen["script"]["state"] = "frozen"
        null_frozen["script"]["frozenAt"] = None
        rehash(null_frozen)
        self.assertIn(
            "INVALID_SCRIPT_TIMESTAMP", issue_codes(validate_bundle.validate_bundle(null_frozen))
        )

    def test_canonical_hash_golden_vectors_and_exclusions(self) -> None:
        bundle = valid_bundle()
        self.assertEqual(
            bundle["script"]["sourceSetHash"],
            "sha256:5e78f507f6b23efa21f0cf078cb4e3e94ea6559e2526d67315fc12a5b98a4424",
        )
        self.assertEqual(
            bundle["script"]["canonicalPayloadHash"],
            "sha256:3bf7c94ab9ef18aa1325dd4bc829fb5f8eca324b05385e781e4d81d3dbe7fee1",
        )
        self.assertEqual(
            validate_bundle.canonical_json({"z": -0.0, "a": [1.0, 0.000001, "雪"]}),
            '{"a":[1,0.000001,"雪"],"z":0}',
        )

        with_timestamp = copy.deepcopy(bundle)
        with_timestamp["script"]["createdAt"] = "2026-08-27T12:00:00Z"
        self.assertEqual(
            validate_bundle.compute_canonical_payload_hash(with_timestamp),
            bundle["script"]["canonicalPayloadHash"],
        )
        changed_profile = copy.deepcopy(bundle)
        changed_profile["validation"]["profile"] = "blind-player/9.9"
        self.assertNotEqual(
            validate_bundle.compute_canonical_payload_hash(changed_profile),
            bundle["script"]["canonicalPayloadHash"],
        )
        changed_payload = copy.deepcopy(bundle)
        changed_payload["contentBlocks"]["cnt_aaaaaaaa"]["payload"]["text"] += "!"
        self.assertNotEqual(
            validate_bundle.compute_canonical_payload_hash(changed_payload),
            bundle["script"]["canonicalPayloadHash"],
        )

    def test_negative_zero_and_excess_precision_are_blocking(self) -> None:
        negative_zero = valid_bundle()
        negative_zero["contentBlocks"]["cnt_aaaaaaaa"]["trace"]["evidence"][0]["region"]["x"] = -0.0
        rehash(negative_zero)
        self.assertIn(
            "INVALID_CONTENT_EVIDENCE", issue_codes(validate_bundle.validate_bundle(negative_zero))
        )

        excess_precision = valid_bundle()
        excess_precision["sources"]["src_aaaaaaaa"]["classification"]["confidence"] = 0.1234567
        rehash(excess_precision)
        self.assertIn(
            "INVALID_SOURCE_CONFIDENCE",
            issue_codes(validate_bundle.validate_bundle(excess_precision)),
        )

    def test_review_policy_role_and_parent_invariants(self) -> None:
        unreviewed = valid_bundle()
        unreviewed["contentBlocks"]["cnt_bbbbbbbb"]["trace"]["reviewStatus"] = "unreviewed"
        rehash(unreviewed)
        report = validate_bundle.validate_bundle(unreviewed)
        self.assertIn("CONTENT_REVIEW_INCOMPLETE", issue_codes(report))
        self.assertFalse(report["freeze_ready"])

        duplicate_policy = valid_bundle()
        duplicate_policy["contentBlocks"]["cnt_bbbbbbbb"]["visibility"]["grants"][0][
            "policyId"
        ] = "policy_aaaaaaaa"
        rehash(duplicate_policy)
        self.assertIn(
            "DUPLICATE_POLICY_ID", issue_codes(validate_bundle.validate_bundle(duplicate_policy))
        )

        wrong_role = valid_bundle()
        wrong_role["contentBlocks"]["cnt_bbbbbbbb"]["classification"]["compartments"] = [
            "stage:stage_aaaaaaaa"
        ]
        rehash(wrong_role)
        self.assertIn(
            "ROLE_CONTENT_COMPARTMENT_MISMATCH",
            issue_codes(validate_bundle.validate_bundle(wrong_role)),
        )

        self_parent = valid_bundle()
        self_parent["script"]["parentVersionId"] = "ver_aaaaaaaa"
        rehash(self_parent)
        self.assertIn(
            "INVALID_PARENT_VERSION_ID", issue_codes(validate_bundle.validate_bundle(self_parent))
        )

    def test_timestamp_order_and_system_only_l3_grant(self) -> None:
        reversed_time = valid_bundle()
        reversed_time["script"]["state"] = "frozen"
        reversed_time["script"]["createdAt"] = "2026-08-27T12:00:00Z"
        reversed_time["script"]["frozenAt"] = "2026-08-27T11:00:00Z"
        rehash(reversed_time)
        self.assertIn(
            "INVALID_SCRIPT_TIMESTAMP", issue_codes(validate_bundle.validate_bundle(reversed_time))
        )

        system_only = valid_bundle()
        block = content_block("cnt_ffffffff", "L3", True)
        principal = block["visibility"]["grants"][0]["principal"]
        principal["kind"] = "system_only"
        principal["subjectId"] = None
        system_only["contentBlocks"]["cnt_ffffffff"] = block
        rehash(system_only)
        report = validate_bundle.validate_bundle(system_only)
        self.assertNotIn("HIGH_SECRET_GRANT", issue_codes(report))
        self.assertTrue(report["freeze_ready"])

    def test_l2_requires_player_grant_and_disabled_publication_cannot_be_required(self) -> None:
        no_player_grant = valid_bundle()
        no_player_grant["contentBlocks"]["cnt_bbbbbbbb"]["visibility"]["grants"] = []
        rehash(no_player_grant)
        self.assertIn(
            "L2_WITHOUT_PLAYER_GRANT",
            issue_codes(validate_bundle.validate_bundle(no_player_grant)),
        )

        impossible = valid_bundle()
        add_valid_clue(impossible, {"op": "always"})
        clue_publication = impossible["clues"]["clue_aaaaaaaa"]["publication"]
        clue_publication["allowed"] = False
        clue_publication["revealedFaceIds"] = []
        add_host_release(
            impossible,
            {"op": "clue_published", "clueId": "clue_aaaaaaaa"},
        )
        rehash(impossible)
        self.assertIn(
            "IMPOSSIBLE_CONDITION_DEPENDENCY",
            issue_codes(validate_bundle.validate_bundle(impossible)),
        )

    def test_all_valid_fixture_leaves_replaced_by_objects_fail_without_crashing(self) -> None:
        fixture = valid_bundle()
        for path in leaf_paths(fixture):
            with self.subTest(path=path):
                malformed = copy.deepcopy(fixture)
                replace_at(malformed, path, {})
                report = validate_bundle.validate_bundle(malformed)
                self.assertFalse(report["freeze_ready"])
                self.assertNotIn(CANARY, json.dumps(report, ensure_ascii=False))
                self.assertTrue(validate_safe_report.validate_report(report))

    def test_cli_errors_do_not_echo_arguments_or_remove_preexisting_reports(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = init_run_root.initialize(Path(temporary) / "opaque-run")
            bundle_path = root / "vault" / "bundle.json"
            safe_path = root / "safe" / "validation.json"
            bundle_path.write_text('{"schemaVersion":1,"schemaVersion":2}', encoding="utf-8")
            safe_path.write_text(CANARY, encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = validate_bundle.main(["--run-root", str(root)])
            self.assertEqual(result, 2)
            self.assertEqual(safe_path.read_text(encoding="utf-8"), CANARY)
            self.assertNotIn(CANARY, stdout.getvalue() + stderr.getvalue())

            private_inventory = root / "private" / "source-inventory.json"
            safe_inventory = root / "safe" / "inventory.json"
            private_inventory.write_text(CANARY, encoding="utf-8")
            safe_inventory.write_text(CANARY, encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = inventory_sources.main(["--run-root", str(root), "--bad", CANARY])
            self.assertEqual(result, 2)
            self.assertEqual(private_inventory.read_text(encoding="utf-8"), CANARY)
            self.assertEqual(safe_inventory.read_text(encoding="utf-8"), CANARY)
            self.assertNotIn(CANARY, stdout.getvalue() + stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
