from __future__ import annotations

import argparse
import base64
import io
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image


CONTENT_PATTERN = re.compile(
    r'<script id="content-data" type="application/json">(.*?)</script>', re.DOTALL
)
ALL_DATA_PATTERN = re.compile(r"data:image/jpeg;base64,([A-Za-z0-9+/=]+)")
IMAGE_DATA_PATTERN = re.compile(
    r'<img[^>]+src=["\']data:image/jpeg;base64,([A-Za-z0-9+/=]+)', re.IGNORECASE
)
EXTERNAL_ASSET_PATTERN = re.compile(
    r'<(?:script|link|img|source)[^>]+(?:src|href)=["\']https?://', re.IGNORECASE
)


@dataclass(frozen=True)
class AuditReport:
    path: Path
    file_count: int
    embedded_media_count: int
    external_asset_count: int
    content_counts: dict[str, int]
    file_size: int


def _verify_payloads(payloads: list[str], label: str) -> None:
    for index, encoded in enumerate(payloads, 1):
        try:
            with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
                image.verify()
        except Exception as error:
            raise ValueError(f"{label} 的第 {index} 个内嵌图片无效：{error}") from error


def _content_counts(content: dict[str, Any]) -> dict[str, int]:
    roles = content.get("roles", [])
    return {
        "roles": len(roles),
        "stages": sum(len(role.get("stages", [])) for role in roles),
        "clueGroups": len(content.get("clueGroups", [])),
        "clueCards": sum(len(group.get("cards", [])) for group in content.get("clueGroups", [])),
        "manualSteps": len(content.get("manualSteps", [])),
    }


def _validate_single(path: Path) -> AuditReport:
    document = path.read_text(encoding="utf-8")
    external = EXTERNAL_ASSET_PATTERN.findall(document)
    if external:
        raise ValueError(f"输出包含 {len(external)} 个外部网络资源")
    match = CONTENT_PATTERN.search(document)
    if not match:
        raise ValueError("找不到内嵌 content-data")
    try:
        content = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise ValueError(f"content-data 不是有效 JSON：{error}") from error
    payloads = ALL_DATA_PATTERN.findall(match.group(1))
    _verify_payloads(payloads, path.name)
    if '<img src="data:image/' in document or "<img src='data:image/" in document:
        raise ValueError("单文件初始 HTML 不应静态创建全部内容图片")
    return AuditReport(
        path=path,
        file_count=1,
        embedded_media_count=len(payloads),
        external_asset_count=0,
        content_counts=_content_counts(content),
        file_size=path.stat().st_size,
    )


def _validate_split(path: Path) -> AuditReport:
    files = sorted(path.glob("*.html"))
    if not files or not (path / "index.html").is_file():
        raise ValueError("split 输出缺少 index.html")
    media_count = 0
    file_size = 0
    part_ids: set[str] = set()
    for document_path in files:
        document = document_path.read_text(encoding="utf-8")
        external = EXTERNAL_ASSET_PATTERN.findall(document)
        if external:
            raise ValueError(f"{document_path.name} 包含外部网络资源")
        part_match = re.search(r'<meta name="mm-part-id" content="([^"]+)"', document)
        if not part_match or part_match.group(1) in part_ids:
            raise ValueError(f"{document_path.name} 缺少唯一 mm-part-id")
        part_ids.add(part_match.group(1))
        payloads = IMAGE_DATA_PATTERN.findall(document)
        _verify_payloads(payloads, document_path.name)
        media_count += len(payloads)
        file_size += document_path.stat().st_size
    return AuditReport(
        path=path,
        file_count=len(files),
        embedded_media_count=media_count,
        external_asset_count=0,
        content_counts={"parts": len(part_ids)},
        file_size=file_size,
    )


def validate_output(path: Path) -> AuditReport:
    target = Path(path)
    if target.is_file():
        return _validate_single(target)
    if target.is_dir():
        return _validate_split(target)
    raise ValueError(f"输出路径不存在：{target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit an offline interactive HTML output.")
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    report = validate_output(args.path)
    result = asdict(report)
    result["path"] = str(result["path"])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
