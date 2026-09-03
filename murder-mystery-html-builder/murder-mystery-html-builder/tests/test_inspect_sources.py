from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "inspect_sources.py"
SPEC = importlib.util.spec_from_file_location("inspect_sources", SCRIPT)
assert SPEC and SPEC.loader
inspect_sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inspect_sources)


class _Box:
    width = 612
    height = 792


class _Page:
    mediabox = _Box()

    def __init__(self) -> None:
        self.extract_calls = 0

    def extract_text(self) -> str:
        self.extract_calls += 1
        return "private page text"


class _Reader:
    def __init__(self, page: _Page) -> None:
        self.pages = [page]
        self.outline_calls = 0

    @property
    def outline(self) -> list[object]:
        self.outline_calls += 1
        return []


class _UnreadablePage(_Page):
    def extract_text(self) -> str:
        self.extract_calls += 1
        raise ValueError("synthetic extraction failure")


class InspectPdfTests(unittest.TestCase):
    def test_participant_safe_inventory_never_reads_page_text(self) -> None:
        page = _Page()
        reader = _Reader(page)
        with patch.object(inspect_sources, "PdfReader", return_value=reader):
            result = inspect_sources._inspect_pdf(Path("opaque.pdf"))

        self.assertEqual(page.extract_calls, 0)
        self.assertEqual(reader.outline_calls, 0)
        self.assertNotIn("bookmarks", result)
        self.assertNotIn("titleCandidates", result)

    def test_text_candidates_require_explicit_opt_in(self) -> None:
        page = _Page()
        reader = _Reader(page)
        with patch.object(inspect_sources, "PdfReader", return_value=reader):
            result = inspect_sources._inspect_pdf(
                Path("opaque.pdf"),
                include_text_candidates=True,
            )

        self.assertEqual(page.extract_calls, 1)
        self.assertEqual(reader.outline_calls, 1)
        self.assertEqual(result["bookmarks"], [])
        self.assertEqual(result["titleCandidates"], ["private page text"])

    def test_opt_in_keeps_structure_when_one_page_text_is_unreadable(self) -> None:
        page = _UnreadablePage()
        with patch.object(inspect_sources, "PdfReader", return_value=_Reader(page)):
            result = inspect_sources._inspect_pdf(
                Path("opaque.pdf"),
                include_text_candidates=True,
            )

        self.assertEqual(result["pageCount"], 1)
        self.assertEqual(result["titleCandidates"], [""])
        self.assertNotIn("error", result)


if __name__ == "__main__":
    unittest.main()
