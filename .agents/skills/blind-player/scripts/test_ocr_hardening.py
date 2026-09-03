"""Synthetic regressions for the private OCR stage."""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import extract_ocr  # noqa: E402


class Box:
    def tolist(self) -> list[list[int]]:
        return [[0, 0], [100, 0], [100, 50], [0, 50]]


class Result:
    txts = ["synthetic text"]
    scores = [0.875]
    boxes = [Box()]


class Engine:
    def __call__(self, _image: object) -> Result:
        return Result()


class OcrHardeningTests(unittest.TestCase):
    def test_engine_versions_come_from_installed_distributions(self) -> None:
        with patch.object(extract_ocr.importlib.metadata, "version", return_value="1.23.2"):
            self.assertEqual(extract_ocr.installed_version("onnxruntime"), "1.23.2")

    def test_invalid_engine_version_fails_closed(self) -> None:
        with patch.object(extract_ocr.importlib.metadata, "version", return_value="bad value"):
            with self.assertRaisesRegex(ValueError, "INVALID_OCR_ENGINE_VERSION"):
                extract_ocr.installed_version("onnxruntime")

    def test_normalized_polygon_is_bounded_and_stable(self) -> None:
        self.assertEqual(
            extract_ocr.normalized_polygon(Box(), 100, 50),
            [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
        )

    def test_private_lines_have_opaque_ids_and_geometry(self) -> None:
        lines = extract_ocr.extract_lines(Engine(), object(), 100, 50, "page_aaaaaaaa")
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0]["line_id"], r"^ocr_[0-9a-f]{16}$")
        self.assertEqual(lines[0]["confidence"], 0.875)
        self.assertEqual(lines[0]["text"], "synthetic text")

    def test_failure_output_is_fixed(self) -> None:
        original = sys.stderr
        stream = io.StringIO()
        try:
            sys.stderr = stream
            extract_ocr._emit_failure()
        finally:
            sys.stderr = original
        self.assertEqual(
            stream.getvalue(),
            '{"code":"OCR_EXTRACTION_FAILED","status":"failed"}\n',
        )


if __name__ == "__main__":
    unittest.main()
