#!/usr/bin/env python3
"""Create one explicitly marked private run root without echoing its path."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import secrets
import sys

from validate_safe_report import (
    RUN_ROOT_MARKER,
    SafeArgumentParser,
    _is_link_or_junction,
    canonical_run_root_marker_bytes,
    resolve_private_run_root,
)


def validate_parent(candidate: Path) -> tuple[Path, Path]:
    lexical = Path(os.path.abspath(candidate))
    parent = lexical.parent.resolve(strict=True)
    if not parent.is_dir() or lexical.exists():
        raise ValueError("RUN_ROOT_ALREADY_EXISTS")
    for component in (parent, *parent.parents):
        if _is_link_or_junction(component):
            raise ValueError("UNSAFE_RUN_ROOT_PARENT")
        if (component / ".git").exists():
            raise ValueError("RUN_ROOT_IN_GIT")
    return lexical, parent


def initialize(candidate: Path) -> Path:
    root, _parent = validate_parent(candidate)
    nonce = secrets.token_hex(16)
    marker_bytes = canonical_run_root_marker_bytes(nonce)
    created = False
    try:
        root.mkdir(mode=0o700, parents=False, exist_ok=False)
        created = True
        for name in ("vault", "private", "safe"):
            (root / name).mkdir(mode=0o700)
        marker = root / RUN_ROOT_MARKER
        with marker.open("xb") as stream:
            stream.write(marker_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        return resolve_private_run_root(root)
    except Exception:
        if created:
            marker = root / RUN_ROOT_MARKER
            if marker.is_file() and not _is_link_or_junction(marker):
                marker.unlink(missing_ok=True)
            for name in ("safe", "private", "vault"):
                child = root / name
                if child.is_dir() and not _is_link_or_junction(child):
                    child.rmdir()
            root.rmdir()
        raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = SafeArgumentParser(description="Initialize a blind-player private run root.")
    parser.add_argument("root", type=Path)
    return parser.parse_args(argv)


def main() -> int:
    try:
        args = parse_args()
        initialize(args.root)
        print('{"code":"RUN_ROOT_READY","status":"private"}', flush=True)
        return 0
    except Exception:
        print('{"code":"RUN_ROOT_INIT_FAILED","status":"failed"}', file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
