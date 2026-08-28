#!/usr/bin/env python3
"""Focused synthetic regression tests for inventory hardening."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import inventory_sources  # noqa: E402
import validate_safe_report  # noqa: E402


VALID_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC"
)
SYNTHETIC_CANARY = "SYNTHETIC_PRIVATE_CANARY"


def make_run_root(parent: Path, name: str = "private-run") -> Path:
    root = parent / name
    root.mkdir(parents=True)
    (root / validate_safe_report.RUN_ROOT_MARKER).write_bytes(
        validate_safe_report.RUN_ROOT_MARKER_BYTES
    )
    return root


def output_paths(run_root: Path) -> tuple[Path, Path]:
    return (
        run_root / inventory_sources.PRIVATE_OUTPUT_RELATIVE,
        run_root / inventory_sources.SAFE_OUTPUT_RELATIVE,
    )


def vault_sources_path(run_root: Path) -> Path:
    return run_root / inventory_sources.VAULT_SOURCES_RELATIVE


def private_log_path(run_root: Path) -> Path:
    return run_root / inventory_sources.PRIVATE_LOG_RELATIVE


def write_stale_outputs(run_root: Path) -> tuple[Path, Path]:
    private_path, safe_path = output_paths(run_root)
    private_path.parent.mkdir(parents=True, exist_ok=True)
    safe_path.parent.mkdir(parents=True, exist_ok=True)
    private_path.write_text(SYNTHETIC_CANARY, encoding="utf-8")
    safe_path.write_text(SYNTHETIC_CANARY, encoding="utf-8")
    return private_path, safe_path


def issue_counts(report: dict[str, object]) -> dict[str, int]:
    return {item["code"]: item["count"] for item in report["issues"]}


class BrokenStdout:
    def write(self, _value: str) -> int:
        raise BrokenPipeError

    def flush(self) -> None:
        raise BrokenPipeError


class InventoryHardeningTests(unittest.TestCase):
    def test_run_id_is_derived_only_from_safe_body(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "source-a"
            second = root / "source-b"
            first.mkdir()
            second.mkdir()
            (first / "alpha.bin").write_bytes(b"abc")
            (second / "different.bin").write_bytes(b"xyz")

            first_private, first_safe = inventory_sources.build_inventory(first)
            second_private, second_safe = inventory_sources.build_inventory(second)

            self.assertEqual(first_safe, second_safe)
            self.assertEqual(first_safe["run_id"], validate_safe_report.derive_run_id(first_safe))
            self.assertNotEqual(first_private["source_fingerprint"], second_private["source_fingerprint"])
            self.assertNotEqual(first_private["pack_id"], second_private["pack_id"])
            self.assertNotEqual(first_private["pack_id"], first_safe["run_id"])

    def test_natural_key_never_converts_unbounded_digit_runs(self) -> None:
        key = inventory_sources.natural_key("9" * 10_000)
        self.assertEqual(key[1][1], 10_000)

    def test_added_source_is_detected_by_final_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "a.png").write_bytes(VALID_PNG)
            original = inventory_sources.inspect_image

            def mutate(stream: io.BufferedReader) -> tuple[dict[str, object], str | None]:
                result = original(stream)
                (source / "added.png").write_bytes(VALID_PNG)
                return result

            with patch.object(inventory_sources, "inspect_image", side_effect=mutate):
                with self.assertRaisesRegex(ValueError, "^SOURCE_CHANGED_DURING_INVENTORY$"):
                    inventory_sources.build_inventory(source)

    def test_deleted_source_is_detected_by_final_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "a.png").write_bytes(VALID_PNG)
            victim = source / "b.png"
            victim.write_bytes(VALID_PNG)
            original = inventory_sources.inspect_image
            calls = 0

            def mutate(stream: io.BufferedReader) -> tuple[dict[str, object], str | None]:
                nonlocal calls
                result = original(stream)
                calls += 1
                if calls == 1:
                    victim.unlink()
                return result

            with patch.object(inventory_sources, "inspect_image", side_effect=mutate):
                with self.assertRaisesRegex(ValueError, "^SOURCE_CHANGED_DURING_INVENTORY$"):
                    inventory_sources.build_inventory(source)

    def test_already_processed_source_change_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            processed = source / "a.png"
            processed.write_bytes(VALID_PNG)
            (source / "b.png").write_bytes(VALID_PNG)
            original = inventory_sources.inspect_image
            calls = 0

            def mutate(stream: io.BufferedReader) -> tuple[dict[str, object], str | None]:
                nonlocal calls
                result = original(stream)
                calls += 1
                if calls == 2:
                    processed.write_bytes(VALID_PNG + b"changed")
                return result

            with patch.object(inventory_sources, "inspect_image", side_effect=mutate):
                with self.assertRaisesRegex(ValueError, "^SOURCE_CHANGED_DURING_INVENTORY$"):
                    inventory_sources.build_inventory(source)

    def test_numeric_stem_length_limit_is_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            name = "9" * (inventory_sources.MAX_NUMERIC_STEM_DIGITS + 1) + ".png"
            (source / name).write_bytes(VALID_PNG)
            private, safe = inventory_sources.build_inventory(source)

            self.assertEqual(safe["status"], "blocked")
            self.assertEqual(issue_counts(safe)[inventory_sources.NUMERIC_SEQUENCE_LIMIT_CODE], 1)
            self.assertEqual(safe["counts"]["numeric_sequence_groups"], 0)
            self.assertEqual(
                private["sources"][0]["numeric_sequence_issue_code"],
                inventory_sources.NUMERIC_SEQUENCE_LIMIT_CODE,
            )
            self.assertTrue(validate_safe_report.validate_report(safe))

    def test_numeric_span_limit_does_not_materialize_range(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "0.png").write_bytes(VALID_PNG)
            (source / f"{inventory_sources.MAX_NUMERIC_SEQUENCE_SPAN}.png").write_bytes(VALID_PNG)

            with patch.object(
                inventory_sources,
                "range",
                side_effect=AssertionError("unbounded range"),
                create=True,
            ) as guarded_range:
                private, safe = inventory_sources.build_inventory(source)

            guarded_range.assert_not_called()
            self.assertEqual(issue_counts(safe)[inventory_sources.NUMERIC_SEQUENCE_LIMIT_CODE], 1)
            self.assertEqual(safe["quality"]["missing_numeric_pages"], 0)
            self.assertEqual(private["numeric_sequences"][0]["missing"], [])
            self.assertTrue(validate_safe_report.validate_report(safe))

    def test_pillow_verify_rejects_truncated_image(self) -> None:
        inventory_sources.load_optional_dependencies()
        if inventory_sources.Image is None:
            self.skipTest("Pillow unavailable")
        metadata, issue = inventory_sources.inspect_image(io.BytesIO(VALID_PNG[:-12]))
        self.assertEqual(metadata, {"metadata_status": "unreadable"})
        self.assertEqual(issue, "UNREADABLE_IMAGE")

    def test_cli_uses_fixed_paths_and_canonical_safe_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)
            stdout = io.StringIO()
            stderr = io.StringIO()

            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            private_path, safe_path = output_paths(run_root)
            safe_bytes = safe_path.read_bytes()
            report = validate_safe_report.load_canonical_safe_report(safe_path)[0]
            self.assertEqual(result, 0)
            self.assertTrue(private_path.is_file())
            self.assertEqual(safe_bytes, validate_safe_report.canonical_safe_bytes(report))
            self.assertEqual(
                stdout.getvalue(),
                '{"code":"INVENTORY_REPORT_WRITTEN","status":"private"}\n',
            )
            self.assertEqual(stderr.getvalue(), "")
            marker = validate_safe_report.load_run_root_marker(run_root)
            expected_run_id = validate_safe_report.expected_run_id_for_schema(
                inventory_sources.SAFE_SCHEMA, marker["nonce"]
            )
            self.assertTrue(
                validate_safe_report.validate_report(
                    report, expected_run_id=expected_run_id
                )
            )

    def test_cli_reads_source_once_and_commits_matching_vault_blob(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            source_file = source / "synthetic.bin"
            original_bytes = b"fixed synthetic bytes"
            source_file.write_bytes(original_bytes)
            run_root = make_run_root(root)
            opened_paths: list[Path] = []
            original_open = inventory_sources._open_source

            def track_open(path: Path) -> io.BufferedReader:
                opened_paths.append(Path(path))
                return original_open(path)

            with patch.object(inventory_sources, "_open_source", side_effect=track_open), redirect_stdout(
                io.StringIO()
            ), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            private_path, _safe_path = output_paths(run_root)
            manifest = json.loads(private_path.read_text(encoding="utf-8"))
            record = manifest["sources"][0]
            blob_ref = record["vault_blob_ref"]
            self.assertEqual(result, 0)
            self.assertEqual(record["path_ref"], "vault:path:0001")
            marker = validate_safe_report.load_run_root_marker(run_root)
            self.assertEqual(manifest["pack_id"], f"pack_{marker['nonce']}")
            self.assertEqual(sum(path == source_file for path in opened_paths), 1)
            self.assertTrue(blob_ref.startswith("vault:sources/src_"))
            blob_path = run_root / "vault" / Path(blob_ref.removeprefix("vault:"))
            self.assertEqual(blob_path.read_bytes(), original_bytes)
            self.assertEqual(
                record["sha256"],
                "sha256:" + hashlib.sha256(original_bytes).hexdigest(),
            )

    def test_source_change_after_commit_does_not_affect_vault_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            source_file = source / "synthetic.bin"
            original_bytes = b"before commit"
            source_file.write_bytes(original_bytes)
            run_root = make_run_root(root)
            original_commit = inventory_sources.commit_staged_sources

            def commit_then_change(staging: Path, committed: Path) -> None:
                original_commit(staging, committed)
                source_file.write_bytes(b"changed after commit")

            with patch.object(
                inventory_sources,
                "commit_staged_sources",
                side_effect=commit_then_change,
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            private_path, _safe_path = output_paths(run_root)
            manifest = json.loads(private_path.read_text(encoding="utf-8"))
            record = manifest["sources"][0]
            blob_path = (
                run_root
                / "vault"
                / Path(record["vault_blob_ref"].removeprefix("vault:"))
            )
            self.assertEqual(result, 0)
            self.assertEqual(blob_path.read_bytes(), original_bytes)
            self.assertEqual(record["byte_length"], len(original_bytes))
            self.assertEqual(
                record["sha256"],
                "sha256:" + hashlib.sha256(original_bytes).hexdigest(),
            )

    def test_python_and_native_canaries_are_confined_to_private_log(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)
            original_load = inventory_sources.load_optional_dependencies
            original_build = inventory_sources.build_inventory
            python_out = "PYTHON_STDOUT_CANARY"
            python_err = "PYTHON_STDERR_CANARY"
            native_out = b"NATIVE_STDOUT_CANARY\n"
            native_err = b"NATIVE_STDERR_CANARY\n"

            def noisy_load() -> None:
                print(python_out)
                print(python_err, file=sys.stderr)
                os.write(1, native_out)
                os.write(2, native_err)
                original_load()

            def noisy_build(*args: object, **kwargs: object) -> tuple[dict[str, object], dict[str, object]]:
                print("BUILD_STDOUT_CANARY")
                os.write(2, b"BUILD_NATIVE_STDERR_CANARY\n")
                return original_build(*args, **kwargs)

            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.object(
                inventory_sources,
                "load_optional_dependencies",
                side_effect=noisy_load,
            ), patch.object(
                inventory_sources,
                "build_inventory",
                side_effect=noisy_build,
            ), redirect_stdout(stdout), redirect_stderr(stderr):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            player_output = stdout.getvalue() + stderr.getvalue()
            private_log = private_log_path(run_root).read_bytes()
            self.assertEqual(result, 0)
            for canary in (
                python_out.encode(),
                python_err.encode(),
                native_out.strip(),
                native_err.strip(),
                b"BUILD_STDOUT_CANARY",
                b"BUILD_NATIVE_STDERR_CANARY",
            ):
                self.assertNotIn(canary.decode(), player_output)
                self.assertIn(canary, private_log)

    def test_committed_run_root_is_one_use_and_preserves_first_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                first_result = inventory_sources.main(
                    [str(source), "--run-root", str(run_root)]
                )
            private_path, safe_path = output_paths(run_root)
            committed = vault_sources_path(run_root)
            first_artifacts = (
                private_path.read_bytes(),
                safe_path.read_bytes(),
                tuple((path.name, path.read_bytes()) for path in committed.iterdir()),
            )

            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                second_result = inventory_sources.main(
                    [str(source), "--run-root", str(run_root)]
                )

            self.assertEqual(first_result, 0)
            self.assertEqual(second_result, 2)
            self.assertEqual(
                first_artifacts,
                (
                    private_path.read_bytes(),
                    safe_path.read_bytes(),
                    tuple((path.name, path.read_bytes()) for path in committed.iterdir()),
                ),
            )

    def test_parse_failure_preserves_every_preexisting_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            first = make_run_root(root, "private-a")
            second = make_run_root(root, "private-b")
            first_paths = write_stale_outputs(first)
            second_paths = write_stale_outputs(second)
            stdout = io.StringIO()
            stderr = io.StringIO()

            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = inventory_sources.main(
                    [
                        str(source),
                        "--run-root",
                        str(first),
                        f"--run-root={second}",
                        "--mixed-invalid-option",
                    ]
                )

            self.assertEqual(result, 2)
            self.assertTrue(all(path.is_file() for path in (*first_paths, *second_paths)))
            self.assertNotIn(SYNTHETIC_CANARY, stdout.getvalue() + stderr.getvalue())

    def test_parse_failure_with_one_candidate_preserves_preexisting_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            run_root = make_run_root(root)
            paths = write_stale_outputs(run_root)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main(
                    [str(source), "--run-root", str(run_root), "--unexpected"]
                )
            self.assertEqual(result, 2)
            self.assertTrue(all(path.is_file() for path in paths))

    def test_processing_failure_preserves_preexisting_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)
            paths = write_stale_outputs(run_root)

            with patch.object(
                inventory_sources,
                "atomic_write_safe_json",
                side_effect=OSError("synthetic failure"),
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            self.assertEqual(result, 2)
            self.assertTrue(all(path.is_file() for path in paths))
            self.assertFalse(vault_sources_path(run_root).exists())
            self.assertEqual(
                list((run_root / "vault").glob(f"{inventory_sources.STAGING_PREFIX}*")),
                [],
            )

    def test_build_failure_after_commit_removes_commit_and_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)

            with patch.object(
                inventory_sources,
                "build_inventory",
                side_effect=RuntimeError("synthetic build failure"),
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            self.assertEqual(result, 2)
            self.assertFalse(vault_sources_path(run_root).exists())
            self.assertEqual(
                list((run_root / "vault").glob(f"{inventory_sources.STAGING_PREFIX}*")),
                [],
            )
            self.assertTrue(private_log_path(run_root).is_file())
            self.assertTrue(all(not path.exists() for path in output_paths(run_root)))

    def test_partial_copy_failure_removes_exclusive_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abcdef")
            run_root = make_run_root(root)

            def fail_copy(source_stream: io.BufferedReader, destination: io.BufferedWriter) -> None:
                destination.write(source_stream.read(2))
                raise OSError("synthetic copy failure")

            with patch.object(
                inventory_sources,
                "_copy_stream_once",
                side_effect=fail_copy,
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            self.assertEqual(result, 2)
            self.assertFalse(vault_sources_path(run_root).exists())
            self.assertEqual(
                list((run_root / "vault").glob(f"{inventory_sources.STAGING_PREFIX}*")),
                [],
            )

    def test_broken_pipe_removes_both_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            run_root = make_run_root(root)

            with patch.object(sys, "stdout", BrokenStdout()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])

            self.assertEqual(result, 2)
            self.assertTrue(all(not path.exists() for path in output_paths(run_root)))
            self.assertFalse(vault_sources_path(run_root).exists())
            self.assertEqual(
                list((run_root / "vault").glob(f"{inventory_sources.STAGING_PREFIX}*")),
                [],
            )

    def test_public_run_root_is_rejected_without_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            run_root = make_run_root(root / "public")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = inventory_sources.main([str(source), "--run-root", str(run_root)])
            self.assertEqual(result, 2)
            self.assertTrue(all(not path.exists() for path in output_paths(run_root)))

    def test_source_root_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "synthetic.bin").write_bytes(b"abc")
            linked = root / "linked-source"
            try:
                linked.symlink_to(source, target_is_directory=True)
            except OSError:
                self.skipTest("directory symlinks unavailable")
            with self.assertRaisesRegex(ValueError, "^UNSAFE_SOURCE_ROOT$"):
                inventory_sources.build_inventory(linked)


if __name__ == "__main__":
    unittest.main()
