from __future__ import annotations

from pathlib import Path
import re
import unittest


TEMPLATE = Path(__file__).parents[1] / "assets" / "interactive-shell.html"


class InteractiveShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = TEMPLATE.read_text(encoding="utf-8")

    def test_shell_has_no_remote_asset_dependencies(self) -> None:
        self.assertIsNone(
            re.search(
                r'<(?:script|link|img|source)[^>]+(?:src|href)=["\']https?://',
                self.document,
                re.IGNORECASE,
            )
        )

    def test_zoom_is_modal_keyboard_trapped_and_restores_focus(self) -> None:
        self.assertIn(
            'class="zoom" role="dialog" aria-modal="true"',
            self.document,
        )
        self.assertIn("event.key==='Escape'", self.document)
        self.assertIn("event.key==='Tab'", self.document)
        self.assertIn("zoomReturnFocus?.focus()", self.document)

    def test_confirmation_dialog_has_an_accessible_name(self) -> None:
        self.assertIn(
            '<dialog aria-labelledby="confirm-dialog-title"',
            self.document,
        )
        self.assertIn('id="confirm-dialog-title"', self.document)

    def test_card_flip_updates_accessible_name_and_zoom_uses_visible_side(self) -> None:
        self.assertIn("startsWithBack=!!card.back", self.document)
        self.assertIn("startsWithBack?card.back.data:card.front.data", self.document)
        self.assertIn("let showingBack=true", self.document)
        self.assertIn("action('查看正面'", self.document)
        self.assertIn("reveal.textContent=showingBack?'查看正面':'返回背面'", self.document)
        self.assertIn("zoom.querySelector('img').src=img.src", self.document)
        self.assertIn("img.alt=card.label+side", self.document)
        self.assertIn(
            "imageControl.setAttribute('aria-label','放大查看'+img.alt)",
            self.document,
        )

    def test_wisteria_theme_is_responsive_and_reduced_motion_safe(self) -> None:
        self.assertIn(".role-grid { grid-template-columns: repeat(3", self.document)
        self.assertIn("@media (max-width: 900px)", self.document)
        self.assertIn("@media (max-width: 560px)", self.document)
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.document)


if __name__ == "__main__":
    unittest.main()
