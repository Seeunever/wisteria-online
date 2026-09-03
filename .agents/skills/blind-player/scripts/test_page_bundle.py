#!/usr/bin/env python3
"""Synthetic forward tests for the page-map compiler."""

from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pypdf import PdfWriter


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import build_page_bundle  # noqa: E402
import init_run_root  # noqa: E402
import inventory_sources  # noqa: E402
import validate_bundle  # noqa: E402
import validate_safe_report  # noqa: E402


CANARY = "SYNTHETIC_PRIVATE_CANARY"


def reference(source_id: str, page_index: int = 0) -> dict[str, object]:
    return {
        "sourceId": source_id,
        "pageIndex": page_index,
        "region": [0, 0, 1, 1],
        "side": "single",
        "readingOrder": 0,
    }


def write_image(path: Path, color: tuple[int, int, int]) -> None:
    Image.new("RGB", (320, 480), color).save(path)


def write_pdf(path: Path) -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=320, height=480)
    writer.add_blank_page(width=480, height=320)
    with path.open("wb") as stream:
        writer.write(stream)


def prepare_run(parent: Path) -> tuple[Path, dict[str, str]]:
    source = parent / "synthetic-source"
    source.mkdir()
    write_image(source / "clue.png", (80, 40, 40))
    write_image(source / "public.png", (40, 80, 40))
    write_image(source / "role.png", (40, 40, 80))
    write_image(source / "solution.png", (80, 80, 40))
    write_pdf(source / "rules.pdf")
    root = init_run_root.initialize(parent / "opaque-run")
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        result = inventory_sources.main([str(source), "--run-root", str(root)])
    if result != 0:
        raise AssertionError("synthetic inventory failed")
    inventory = json.loads((root / "private" / "source-inventory.json").read_text(encoding="utf-8"))
    by_name = {Path(item["relative_path"]).name: item["source_id"] for item in inventory["sources"]}
    return root, by_name


def page_map(by_name: dict[str, str]) -> dict[str, object]:
    public = reference(by_name["public.png"])
    rules = reference(by_name["rules.pdf"])
    rules_second_page = reference(by_name["rules.pdf"], 1)
    role = reference(by_name["role.png"])
    clue = reference(by_name["clue.png"])
    solution = reference(by_name["solution.png"])
    return {
        "schema": "blind-page-map/1.0",
        "locale": "zh-CN",
        "playerCount": {"min": 1, "max": 1},
        "sourceClasses": {
            by_name["public.png"]: {"kind": "public_material", "subject": None, "confidence": 1.0},
            by_name["rules.pdf"]: {"kind": "player_rules", "subject": None, "confidence": 1.0},
            by_name["role.png"]: {"kind": "role_book", "subject": "role-01", "confidence": 1.0},
            by_name["clue.png"]: {"kind": "clue_sheet", "subject": None, "confidence": 1.0},
            by_name["solution.png"]: {"kind": "solution", "subject": None, "confidence": 1.0},
        },
        "title": {"text": "Synthetic title", "evidence": public},
        "roles": [
            {
                "key": "role-01",
                "slot": 1,
                "displayName": {"text": "Synthetic role", "evidence": public},
                "displayNameScope": "session",
                "introduction": [public],
                "sections": [
                    {
                        "key": "section-01",
                        "kind": "background",
                        "stage": "stage-01",
                        "order": 1,
                        "pages": [role],
                        "evidence": role,
                    }
                ],
            }
        ],
        "stages": [
            {
                "key": "stage-01",
                "sequence": 1,
                "label": {"text": "Synthetic stage", "evidence": public},
                "labelScope": "session",
                "enterWhen": {"op": "always"},
                "completeWhen": {"op": "investigation_complete", "stage": "stage-01"},
                "allowedActions": ["read_role_section", "search", "publish_clue"],
                "locations": ["location-01"],
                "evidence": public,
                "investigation": {
                    "searchesPerPlayer": 1,
                    "maxPrivateCount": 1,
                    "blockedActions": ["vote_location", "search"],
                    "completion": "consent_vote",
                },
            }
        ],
        "playerGuide": [rules, rules_second_page],
        "resolution": {
            "pages": [solution],
            "releaseWhen": {"op": "session_completed"},
        },
        "locations": [
            {
                "key": "location-01",
                "stage": "stage-01",
                "name": {"text": "Synthetic location", "evidence": clue},
                "availableWhen": {"op": "stage_active", "stage": "stage-01"},
                "searchPolicy": {
                    "mode": "fixed_sequence",
                    "perPlayerLimit": None,
                    "globalLimit": None,
                    "resetAtStages": [],
                },
                "clues": [
                    {"clue": "clue-01", "order": 1, "copies": 1, "availableWhen": {"op": "always"}}
                ],
                "evidence": clue,
            }
        ],
        "clues": [
            {
                "key": "clue-01",
                "kind": "card",
                "faces": [
                    {
                        "key": "face-01",
                        "side": "single",
                        "pages": [clue],
                        "revealWhen": {"op": "clue_held", "clue": "clue-01"},
                        "evidence": clue,
                    }
                ],
                "pairing": {"status": "verified", "method": "review", "confidence": 1.0, "evidence": clue},
                "acquisition": {"when": {"op": "always"}},
                "publication": {
                    "allowed": True,
                    "publishWhen": {"op": "clue_held", "clue": "clue-01"},
                    "revealedFaces": ["face-01"],
                    "mandatory": False,
                    "evidence": clue,
                },
            }
        ],
    }


class PageBundleTests(unittest.TestCase):
    def test_page_map_compiles_to_a_freeze_ready_provenance_bound_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, sources = prepare_run(Path(temporary))
            (root / "private" / "page-map.json").write_text(
                json.dumps(page_map(sources), ensure_ascii=False), encoding="utf-8"
            )
            bundle = build_page_bundle.build_bundle(root)
            report = validate_bundle.validate_bundle(bundle)
            self.assertTrue(report["freeze_ready"], report["issues"])
            self.assertTrue(validate_safe_report.validate_report(report))
            self.assertTrue(validate_bundle.inventory_matches_bundle(root, bundle))
            page_objects = [
                page_object
                for asset in bundle["assets"].values()
                for page_object in asset.get("pageObjects", [])
            ]
            self.assertEqual(len(page_objects), 6)
            self.assertTrue(all(item["mediaType"] == "image/webp" for item in page_objects))
            self.assertEqual(
                len(list((root / "vault" / "rendered").glob("*.webp"))),
                6,
            )

    def test_cli_emits_only_fixed_codes_and_writes_exclusively(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, sources = prepare_run(Path(temporary))
            mapping = page_map(sources)
            mapping["title"]["text"] = CANARY
            (root / "private" / "page-map.json").write_text(
                json.dumps(mapping, ensure_ascii=False), encoding="utf-8"
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = build_page_bundle.main(["--run-root", str(root)])
            self.assertEqual(result, 0)
            self.assertEqual(stdout.getvalue(), '{"code":"PAGE_BUNDLE_BUILT","status":"private"}\n')
            self.assertEqual(stderr.getvalue(), "")
            self.assertNotIn(CANARY, stdout.getvalue() + stderr.getvalue())

            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = build_page_bundle.main(["--run-root", str(root)])
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(
                stderr.getvalue(),
                '{"code":"PAGE_MAP_BUILD_FAILED","reason":"BUNDLE_ALREADY_EXISTS","status":"failed"}\n',
            )
            self.assertNotIn(CANARY, stdout.getvalue() + stderr.getvalue())

    def test_unknown_page_map_fields_fail_closed_without_echoing_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, sources = prepare_run(Path(temporary))
            mapping = page_map(sources)
            mapping["unexpected"] = CANARY
            (root / "private" / "page-map.json").write_text(
                json.dumps(mapping, ensure_ascii=False), encoding="utf-8"
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = build_page_bundle.main(["--run-root", str(root)])
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(
                stderr.getvalue(),
                '{"code":"PAGE_MAP_BUILD_FAILED","reason":"INVALID_SHAPE","status":"failed"}\n',
            )
            self.assertNotIn(CANARY, stdout.getvalue() + stderr.getvalue())

    def test_solution_source_cannot_inherit_player_guide_visibility(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, sources = prepare_run(Path(temporary))
            mapping = page_map(sources)
            mapping["playerGuide"].append(reference(sources["solution.png"]))
            (root / "private" / "page-map.json").write_text(
                json.dumps(mapping, ensure_ascii=False), encoding="utf-8"
            )
            with self.assertRaisesRegex(build_page_bundle.PageMapError, "PLAYER_GUIDE_SOURCE_REJECTED"):
                build_page_bundle.build_bundle(root, render_media=False)

    def test_installer_copies_verified_pdf_page_objects_to_private_pack_storage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root, sources = prepare_run(parent)
            (root / "private" / "page-map.json").write_text(
                json.dumps(page_map(sources), ensure_ascii=False), encoding="utf-8"
            )
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(build_page_bundle.main(["--run-root", str(root)]), 0)
                self.assertEqual(validate_bundle.main(["--run-root", str(root)]), 0)
            data = parent / "data"
            data.mkdir()
            node = shutil.which("node")
            if not node:
                self.skipTest("node is unavailable")
            installer = SCRIPT_DIR.parents[3] / "scripts" / "install-validated-pack.mjs"
            result = subprocess.run(
                [
                    node,
                    str(installer),
                    "--run-root",
                    str(root),
                    "--data-dir",
                    str(data),
                    "--label",
                    "Synthetic pack",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '{"code":"PACK_INSTALLED","status":"private"}\n')
            bundle = json.loads((root / "vault" / "bundle.json").read_text(encoding="utf-8"))
            objects = data / "packs" / bundle["script"]["versionId"] / "objects"
            rendered = list(objects.glob("*.webp"))
            self.assertEqual(len(rendered), 6)
            for object_path in rendered:
                with Image.open(object_path) as image:
                    image.verify()


if __name__ == "__main__":
    unittest.main()
