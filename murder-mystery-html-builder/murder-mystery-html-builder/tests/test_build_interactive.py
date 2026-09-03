from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

from PIL import Image


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import build_interactive  # noqa: E402
import validate_output  # noqa: E402


class RenderMediaTests(unittest.TestCase):
    def test_image_exif_orientation_is_applied(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "page.jpg"
            image = Image.new("RGB", (8, 4), "purple")
            exif = image.getexif()
            exif[274] = 6
            image.save(source, exif=exif)

            payload = build_interactive.render_media(
                root,
                {"source": source.name},
                dpi=120,
                quality=90,
            )

            with Image.open(BytesIO(payload)) as rendered:
                self.assertEqual(rendered.size, (4, 8))

    def test_crop_coordinates_apply_after_exif_orientation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "page.jpg"
            image = Image.new("RGB", (8, 4), "purple")
            exif = image.getexif()
            exif[274] = 6
            image.save(source, exif=exif)

            payload = build_interactive.render_media(
                root,
                {"source": source.name, "crop": [0, 0, 1, 0.5]},
                dpi=120,
                quality=90,
            )

            with Image.open(BytesIO(payload)) as rendered:
                self.assertEqual(rendered.size, (4, 4))

    def test_transparency_is_flattened_on_white(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "page.png"
            Image.new("RGBA", (4, 4), (0, 0, 0, 0)).save(source)

            payload = build_interactive.render_media(
                root,
                {"source": source.name},
                dpi=120,
                quality=95,
            )

            with Image.open(BytesIO(payload)) as rendered:
                red, green, blue = rendered.convert("RGB").getpixel((0, 0))
                self.assertGreaterEqual(min(red, green, blue), 245)

    def test_palette_transparency_is_flattened_on_white(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "page.png"
            image = Image.new("P", (4, 4), 0)
            image.putpalette([0, 0, 0] * 256)
            image.save(source, transparency=0)

            payload = build_interactive.render_media(
                root,
                {"source": source.name},
                dpi=120,
                quality=95,
            )

            with Image.open(BytesIO(payload)) as rendered:
                red, green, blue = rendered.convert("RGB").getpixel((0, 0))
                self.assertGreaterEqual(min(red, green, blue), 245)


class BuildProjectTests(unittest.TestCase):
    def test_guided_single_build_and_audit_round_trip(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source_root = root / "source"
            source_root.mkdir()
            source = source_root / "page.png"
            Image.new("RGB", (8, 12), "purple").save(source)
            manifest_path = root / "project.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "title": "Synthetic offline game",
                        "mode": "guided-single",
                        "roles": [
                            {
                                "id": "role-a",
                                "name": "Role A",
                                "cover": {"source": source.name},
                                "stages": [
                                    {
                                        "id": "role-a-stage-1",
                                        "title": "Stage 1",
                                        "items": [{"source": source.name}],
                                    }
                                ],
                            }
                        ],
                        "clueGroups": [],
                        "manualSteps": [],
                        "settings": {"dpi": 120, "quality": 84},
                    }
                ),
                encoding="utf-8",
            )
            output = root / "output" / "game.html"

            report = build_interactive.build_project(
                source_root,
                manifest_path,
                output,
            )
            audit = validate_output.validate_output(output)

            self.assertEqual(report.embedded_media_count, 2)
            self.assertEqual(audit.embedded_media_count, 2)
            self.assertEqual(audit.content_counts["roles"], 1)
            self.assertEqual(audit.content_counts["stages"], 1)
            self.assertNotIn("__CONTENT_DATA__", output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
