from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image


SCHEMA_VERSION = 1
MODES = {"guided-single", "open-single", "split"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
class BuildReport:
    output_path: Path
    embedded_media_count: int
    file_count: int
    file_size: int


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取项目清单：{error}") from error
    if not isinstance(value, dict):
        raise ValueError("项目清单根节点必须是对象")
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} 必须是非空文字")
    return value.strip()


def _require_list(value: Any, label: str, *, nonempty: bool = False) -> list[Any]:
    if not isinstance(value, list) or (nonempty and not value):
        qualifier = "非空列表" if nonempty else "列表"
        raise ValueError(f"{label} 必须是{qualifier}")
    return value


def _register_identifier(value: Any, label: str, identifiers: set[str]) -> str:
    identifier = _require_text(value, label)
    if identifier in identifiers:
        raise ValueError(f"发现重复 id：{identifier}")
    identifiers.add(identifier)
    return identifier


def _safe_source_path(source_root: Path, raw_source: Any, label: str) -> tuple[str, Path]:
    source = _require_text(raw_source, f"{label}.source")
    candidate = Path(source)
    if "://" in source or candidate.is_absolute():
        raise ValueError(f"{label}.source 必须是来源文件夹内的本地相对路径")
    root = source_root.resolve()
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label}.source 必须是来源文件夹内的本地相对路径") from error
    if not resolved.is_file():
        raise ValueError(f"{label} 引用的文件不存在：{source}")
    return candidate.as_posix(), resolved


def _normalize_media(reference: Any, source_root: Path, label: str) -> dict[str, Any]:
    if not isinstance(reference, dict):
        raise ValueError(f"{label} 必须是媒体引用对象")
    source, resolved = _safe_source_path(source_root, reference.get("source"), label)
    suffix = resolved.suffix.lower()
    if suffix != ".pdf" and suffix not in IMAGE_SUFFIXES:
        raise ValueError(f"{label} 使用了不支持的文件类型：{suffix}")
    normalized: dict[str, Any] = {"source": source}
    if suffix == ".pdf":
        page = reference.get("page")
        if not isinstance(page, int) or isinstance(page, bool) or page < 1:
            raise ValueError(f"{label}.page 必须是一页起算的正整数")
        normalized["page"] = page
    elif "page" in reference:
        raise ValueError(f"{label}.page 只适用于 PDF")
    if "crop" in reference:
        crop = reference["crop"]
        if (
            not isinstance(crop, list)
            or len(crop) != 4
            or any(not isinstance(number, (int, float)) or isinstance(number, bool) for number in crop)
        ):
            raise ValueError(f"{label}.crop 必须是 [x, y, width, height]")
        x, y, width, height = (float(number) for number in crop)
        if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
            raise ValueError(f"{label}.crop 必须位于 0 到 1 的归一化页面范围内")
        normalized["crop"] = [x, y, width, height]
    return normalized


def _normalize_items(value: Any, source_root: Path, label: str) -> list[dict[str, Any]]:
    items = _require_list(value, label, nonempty=True)
    return [_normalize_media(item, source_root, f"{label}[{index}]") for index, item in enumerate(items)]


def validate_manifest(data: dict[str, Any], source_root: Path) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("项目清单根节点必须是对象")
    source_root = Path(source_root)
    if not source_root.is_dir():
        raise ValueError(f"来源文件夹不存在：{source_root}")
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"schemaVersion 必须是 {SCHEMA_VERSION}")
    title = _require_text(data.get("title"), "title")
    mode = data.get("mode", "guided-single")
    if mode not in MODES:
        raise ValueError(f"mode 必须是：{', '.join(sorted(MODES))}")

    identifiers: set[str] = set()
    roles: list[dict[str, Any]] = []
    for role_index, role in enumerate(_require_list(data.get("roles"), "roles", nonempty=True)):
        if not isinstance(role, dict):
            raise ValueError(f"roles[{role_index}] 必须是对象")
        role_id = _register_identifier(role.get("id"), f"roles[{role_index}].id", identifiers)
        normalized_role: dict[str, Any] = {
            "id": role_id,
            "name": _require_text(role.get("name"), f"roles[{role_index}].name"),
            "stages": [],
        }
        if role.get("cover") is not None:
            normalized_role["cover"] = _normalize_media(
                role["cover"], source_root, f"roles[{role_index}].cover"
            )
        for stage_index, stage in enumerate(
            _require_list(role.get("stages"), f"roles[{role_index}].stages", nonempty=True)
        ):
            if not isinstance(stage, dict):
                raise ValueError(f"roles[{role_index}].stages[{stage_index}] 必须是对象")
            normalized_role["stages"].append(
                {
                    "id": _register_identifier(
                        stage.get("id"),
                        f"roles[{role_index}].stages[{stage_index}].id",
                        identifiers,
                    ),
                    "title": _require_text(
                        stage.get("title"), f"roles[{role_index}].stages[{stage_index}].title"
                    ),
                    "items": _normalize_items(
                        stage.get("items"),
                        source_root,
                        f"roles[{role_index}].stages[{stage_index}].items",
                    ),
                }
            )
        roles.append(normalized_role)

    shared_unlock_ceiling = min(len(role["stages"]) for role in roles)

    def normalize_unlock(value: Any, label: str, *, minimum: int) -> int:
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or value < minimum
            or value > shared_unlock_ceiling
        ):
            raise ValueError(
                f"{label}.unlockStage 必须介于 {minimum} 和 {shared_unlock_ceiling} 之间"
            )
        return value

    clue_groups: list[dict[str, Any]] = []
    for group_index, group in enumerate(_require_list(data.get("clueGroups", []), "clueGroups")):
        if not isinstance(group, dict):
            raise ValueError(f"clueGroups[{group_index}] 必须是对象")
        cards: list[dict[str, Any]] = []
        for card_index, card in enumerate(
            _require_list(group.get("cards"), f"clueGroups[{group_index}].cards", nonempty=True)
        ):
            if not isinstance(card, dict):
                raise ValueError(f"clueGroups[{group_index}].cards[{card_index}] 必须是对象")
            normalized_card = {
                "id": _register_identifier(
                    card.get("id"),
                    f"clueGroups[{group_index}].cards[{card_index}].id",
                    identifiers,
                ),
                "label": _require_text(
                    card.get("label"), f"clueGroups[{group_index}].cards[{card_index}].label"
                ),
                "front": _normalize_media(
                    card.get("front"),
                    source_root,
                    f"clueGroups[{group_index}].cards[{card_index}].front",
                ),
            }
            if card.get("back") is not None:
                normalized_card["back"] = _normalize_media(
                    card["back"],
                    source_root,
                    f"clueGroups[{group_index}].cards[{card_index}].back",
                )
            cards.append(normalized_card)
        clue_groups.append(
            {
                "id": _register_identifier(
                    group.get("id"), f"clueGroups[{group_index}].id", identifiers
                ),
                "title": _require_text(group.get("title"), f"clueGroups[{group_index}].title"),
                "unlockStage": normalize_unlock(
                    group.get("unlockStage", 1), f"clueGroups[{group_index}]", minimum=1
                ),
                "cards": cards,
            }
        )

    manual_steps: list[dict[str, Any]] = []
    for step_index, step in enumerate(_require_list(data.get("manualSteps", []), "manualSteps")):
        if not isinstance(step, dict):
            raise ValueError(f"manualSteps[{step_index}] 必须是对象")
        manual_steps.append(
            {
                "id": _register_identifier(
                    step.get("id"), f"manualSteps[{step_index}].id", identifiers
                ),
                "title": _require_text(step.get("title"), f"manualSteps[{step_index}].title"),
                "unlockStage": normalize_unlock(
                    step.get("unlockStage", 0), f"manualSteps[{step_index}]", minimum=0
                ),
                "items": _normalize_items(
                    step.get("items"), source_root, f"manualSteps[{step_index}].items"
                ),
            }
        )

    raw_settings = data.get("settings", {})
    if not isinstance(raw_settings, dict):
        raise ValueError("settings 必须是对象")
    dpi = raw_settings.get("dpi", 120)
    quality = raw_settings.get("quality", 84)
    if not isinstance(dpi, int) or isinstance(dpi, bool) or not 72 <= dpi <= 240:
        raise ValueError("settings.dpi 必须介于 72 和 240 之间")
    if not isinstance(quality, int) or isinstance(quality, bool) or not 50 <= quality <= 95:
        raise ValueError("settings.quality 必须介于 50 和 95 之间")
    progress_key = raw_settings.get("progressKey") or "murder-mystery-progress"
    settings = {
        "progressKey": _require_text(progress_key, "settings.progressKey"),
        "dpi": dpi,
        "quality": quality,
        "intro": str(raw_settings.get("intro", "请选择角色并按流程推进。")),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "title": title,
        "mode": mode,
        "roles": roles,
        "clueGroups": clue_groups,
        "manualSteps": manual_steps,
        "settings": settings,
    }


def _iter_media(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        if isinstance(value.get("source"), str):
            yield value
        else:
            for child in value.values():
                yield from _iter_media(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_media(child)


def content_fingerprint(manifest: dict[str, Any]) -> str:
    canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _find_pdftoppm() -> str:
    discovered = shutil.which("pdftoppm")
    if discovered:
        return discovered
    bundled = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "native" / "poppler" / "Library" / "bin" / "pdftoppm.exe"
    if bundled.is_file():
        return str(bundled)
    raise RuntimeError("找不到 pdftoppm；请加载工作区 PDF 运行环境后重试")


def _apply_crop(image: Image.Image, crop: list[float] | None) -> Image.Image:
    if not crop:
        return image
    x, y, width, height = crop
    left = round(image.width * x)
    top = round(image.height * y)
    right = round(image.width * (x + width))
    bottom = round(image.height * (y + height))
    return image.crop((left, top, right, bottom))


def render_media(
    source_root: Path,
    reference: dict[str, Any],
    *,
    dpi: int,
    quality: int,
) -> bytes:
    source_root = Path(source_root).resolve()
    source = (source_root / reference["source"]).resolve()
    try:
        source.relative_to(source_root)
    except ValueError as error:
        raise ValueError("媒体引用超出来源文件夹") from error
    if not source.is_file():
        raise ValueError(f"媒体文件不存在：{reference['source']}")
    if source.suffix.lower() == ".pdf":
        page = reference.get("page")
        if not isinstance(page, int) or page < 1:
            raise ValueError("PDF 媒体引用需要一页起算的 page")
        with tempfile.TemporaryDirectory(prefix="mm-html-") as temp_dir:
            prefix = Path(temp_dir) / "page"
            command = [
                _find_pdftoppm(),
                "-f",
                str(page),
                "-l",
                str(page),
                "-r",
                str(dpi),
                "-singlefile",
                "-png",
                str(source),
                str(prefix),
            ]
            completed = subprocess.run(command, capture_output=True, text=True, check=False)
            rendered = prefix.with_suffix(".png")
            if completed.returncode != 0 or not rendered.is_file():
                message = completed.stderr.strip() or f"无法渲染 PDF 第 {page} 页"
                raise ValueError(message)
            with Image.open(rendered) as opened:
                image = opened.convert("RGB")
    else:
        with Image.open(source) as opened:
            image = opened.convert("RGB")
    image = _apply_crop(image, reference.get("crop"))
    output = io.BytesIO()
    image.save(output, "JPEG", quality=quality, optimize=True, progressive=True)
    return output.getvalue()


def _data_uri(payload: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(payload).decode("ascii")


def _embed_manifest(
    value: Any,
    source_root: Path,
    *,
    dpi: int,
    quality: int,
    counter: list[int],
) -> Any:
    if isinstance(value, dict):
        if isinstance(value.get("source"), str):
            counter[0] += 1
            return {"data": _data_uri(render_media(source_root, value, dpi=dpi, quality=quality))}
        return {
            key: _embed_manifest(child, source_root, dpi=dpi, quality=quality, counter=counter)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [
            _embed_manifest(child, source_root, dpi=dpi, quality=quality, counter=counter)
            for child in value
        ]
    return value


def render_single_html(manifest: dict[str, Any], source_root: Path) -> tuple[str, int]:
    counter = [0]
    embedded = _embed_manifest(
        manifest,
        Path(source_root),
        dpi=manifest["settings"]["dpi"],
        quality=manifest["settings"]["quality"],
        counter=counter,
    )
    embedded["fingerprint"] = content_fingerprint(manifest)
    serialized = json.dumps(embedded, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    skill_root = Path(__file__).resolve().parents[1]
    template = (skill_root / "assets" / "interactive-shell.html").read_text(encoding="utf-8")
    progress_script = (skill_root / "assets" / "progress.js").read_text(encoding="utf-8")
    result = template.replace("__TITLE__", html.escape(manifest["title"] + " · 离线互动版"))
    result = result.replace("__CONTENT_DATA__", serialized)
    result = result.replace("__PROGRESS_SCRIPT__", progress_script)
    return result, counter[0]


def _safe_token(identifier: str) -> str:
    token = re.sub(r"[^A-Za-z0-9._-]+", "-", identifier).strip("-.")
    return token or hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:12]


def _static_document(title: str, body: str, *, part_id: str) -> str:
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="mm-part-id" content="{html.escape(part_id)}"><title>{html.escape(title)}</title><style>
*{{box-sizing:border-box}}html{{background:#0d110f}}body{{width:min(100% - 1rem,64rem);margin:auto;padding:1rem 0 4rem;color:#f5f0e5;background:#0d110f;font-family:"Microsoft YaHei",system-ui,sans-serif}}a{{color:#d8ba78}}h1{{font:500 clamp(2rem,8vw,4rem) serif}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:1rem}}figure{{margin:0 0 1rem}}button{{display:block;width:100%;padding:0;border:1px solid #465048;border-radius:.8rem;overflow:hidden;background:#111;cursor:zoom-in}}img{{display:block;width:100%;height:auto}}figcaption{{padding:.45rem;color:#b9b6ad;text-align:center}}.card{{padding:1rem;border:1px solid #465048;border-radius:1rem;background:#19211b}}nav{{display:flex;flex-wrap:wrap;gap:.7rem;margin-bottom:1rem}}nav a{{padding:.6rem .8rem;border:1px solid #465048;border-radius:999px;text-decoration:none}}
</style></head><body>{body}<script>document.querySelectorAll('button[data-src]').forEach(b=>b.addEventListener('click',()=>{{const w=open('','_blank');if(w)w.document.write('<img style="max-width:100%" src="'+b.dataset.src+'">')}}));</script></body></html>'''


def _media_figures(
    source_root: Path,
    items: list[dict[str, Any]],
    *,
    dpi: int,
    quality: int,
    label: str,
) -> tuple[str, int]:
    figures: list[str] = []
    for index, reference in enumerate(items, 1):
        uri = _data_uri(render_media(source_root, reference, dpi=dpi, quality=quality))
        escaped_uri = html.escape(uri, quote=True)
        alt = html.escape(f"{label} {index}")
        figures.append(
            f'<figure><button type="button" data-src="{escaped_uri}" aria-label="放大查看{alt}"><img src="{escaped_uri}" alt="{alt}"></button><figcaption>{index} / {len(items)}</figcaption></figure>'
        )
    return '<section class="grid">' + "".join(figures) + "</section>", len(items)


def _build_split(manifest: dict[str, Any], source_root: Path, output_path: Path) -> BuildReport:
    if output_path.exists() and (not output_path.is_dir() or any(output_path.iterdir())):
        raise ValueError(f"split 输出目录必须不存在或为空：{output_path}")
    output_path.mkdir(parents=True, exist_ok=True)
    dpi = manifest["settings"]["dpi"]
    quality = manifest["settings"]["quality"]
    filenames: set[str] = {"index.html"}
    created: list[Path] = []
    total_media = 0

    def reserve(prefix: str, *identifiers: str) -> str:
        filename = prefix + "-" + "-".join(_safe_token(value) for value in identifiers) + ".html"
        if filename in filenames:
            raise ValueError(f"split 输出文件名冲突：{filename}")
        filenames.add(filename)
        return filename

    index_sections: list[str] = [f'<h1>{html.escape(manifest["title"])}</h1><p>请选择角色或资料分区。每个文件只包含对应内容。</p>']
    for role in manifest["roles"]:
        role_links: list[str] = []
        for stage in role["stages"]:
            filename = reserve("role", role["id"], stage["id"])
            figures, count = _media_figures(
                source_root, stage["items"], dpi=dpi, quality=quality, label=role["name"] + stage["title"]
            )
            total_media += count
            body = f'<nav><a href="index.html">← 返回入口</a></nav><h1>{html.escape(role["name"])} · {html.escape(stage["title"])}</h1>{figures}'
            path = output_path / filename
            path.write_text(_static_document(manifest["title"], body, part_id=stage["id"]), encoding="utf-8")
            created.append(path)
            role_links.append(f'<a href="{html.escape(filename)}">{html.escape(stage["title"])}</a>')
        cover_html = ""
        if role.get("cover"):
            uri = _data_uri(render_media(source_root, role["cover"], dpi=dpi, quality=quality))
            total_media += 1
            escaped_uri = html.escape(uri, quote=True)
            cover_html = f'<button type="button" data-src="{escaped_uri}"><img src="{escaped_uri}" alt="{html.escape(role["name"])}角色封面"></button>'
        index_sections.append(f'<article class="card">{cover_html}<h2>{html.escape(role["name"])}</h2><nav>{"".join(role_links)}</nav></article>')

    for group in manifest["clueGroups"]:
        filename = reserve("clues", group["id"])
        cards_html: list[str] = []
        for card in group["cards"]:
            refs = [card["front"]] + ([card["back"]] if card.get("back") else [])
            figures, count = _media_figures(
                source_root, refs, dpi=dpi, quality=quality, label=card["label"]
            )
            total_media += count
            cards_html.append(f'<article class="card"><h2>{html.escape(card["label"])}</h2>{figures}</article>')
        body = f'<nav><a href="index.html">← 返回入口</a></nav><h1>{html.escape(group["title"])}</h1>{"".join(cards_html)}'
        path = output_path / filename
        path.write_text(_static_document(manifest["title"], body, part_id=group["id"]), encoding="utf-8")
        created.append(path)
        index_sections.append(f'<article class="card"><h2>{html.escape(group["title"])}</h2><a href="{html.escape(filename)}">打开资料分区</a></article>')

    for step in manifest["manualSteps"]:
        filename = reserve("manual", step["id"])
        figures, count = _media_figures(
            source_root, step["items"], dpi=dpi, quality=quality, label=step["title"]
        )
        total_media += count
        body = f'<nav><a href="index.html">← 返回入口</a></nav><h1>{html.escape(step["title"])}</h1>{figures}'
        path = output_path / filename
        path.write_text(_static_document(manifest["title"], body, part_id=step["id"]), encoding="utf-8")
        created.append(path)
        index_sections.append(f'<article class="card"><h2>{html.escape(step["title"])}</h2><a href="{html.escape(filename)}">打开流程资料</a></article>')

    index_body = index_sections[0] + '<section class="grid">' + "".join(index_sections[1:]) + "</section>"
    index_path = output_path / "index.html"
    index_path.write_text(_static_document(manifest["title"], index_body, part_id="index"), encoding="utf-8")
    created.append(index_path)
    return BuildReport(
        output_path=output_path,
        embedded_media_count=total_media,
        file_count=len(created),
        file_size=sum(path.stat().st_size for path in created),
    )


def build_project(source_root: Path, manifest_path: Path, output_path: Path) -> BuildReport:
    source_root = Path(source_root)
    manifest = validate_manifest(load_manifest(manifest_path), source_root)
    output_path = Path(output_path)
    if manifest["mode"] == "split":
        return _build_split(manifest, source_root, output_path)
    document, count = render_single_html(manifest, source_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(document, encoding="utf-8")
    return BuildReport(
        output_path=output_path,
        embedded_media_count=count,
        file_count=1,
        file_size=output_path.stat().st_size,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build offline interactive HTML from a manifest.")
    parser.add_argument("source_root", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    report = build_project(args.source_root, args.manifest, args.output)
    print(json.dumps({
        "output": str(report.output_path),
        "embeddedMedia": report.embedded_media_count,
        "fileCount": report.file_count,
        "fileSize": report.file_size,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
