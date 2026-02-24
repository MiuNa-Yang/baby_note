#!/usr/bin/env python3
"""Convert an EPUB file to Markdown with jump links.

Features:
- Keep chapter ordering by EPUB spine.
- Generate section anchors (`section-1`, `section-2`, ...).
- Parse TOC (`toc.ncx`) and inject subheading anchors when possible.
- Keep heading tags (`h1`..`h6`) as markdown headings.
"""

from __future__ import annotations

import argparse
import posixpath
import re
import sys
import zipfile
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import xml.etree.ElementTree as ET


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def normalize_text(raw: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.splitlines()]
    out: list[str] = []
    prev_blank = False
    for line in lines:
        if not line:
            if not prev_blank:
                out.append("")
            prev_blank = True
            continue
        out.append(line)
        prev_blank = False
    return "\n".join(out).strip()


def decode_html(raw: bytes) -> str:
    head = raw[:400]
    match = re.search(br'encoding=["\']([A-Za-z0-9_.-]+)["\']', head)
    candidates: list[str] = []
    if match:
        try:
            candidates.append(match.group(1).decode("ascii", errors="ignore"))
        except Exception:
            pass
    candidates.extend(["utf-8", "utf-16", "gb18030"])
    for enc in candidates:
        if not enc:
            continue
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="ignore")


def extract_html_title(html: str, fallback: str) -> str:
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.I | re.S)
    if not title_match:
        return fallback
    title = re.sub(r"\s+", " ", title_match.group(1)).strip()
    return title or fallback


def escape_md_link_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


class HtmlToTextParser(HTMLParser):
    """Fallback parser when heading-preserving parse yields empty content."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        t = tag.lower()
        if t in {"br", "hr"}:
            self._parts.append("\n")
        elif t == "li":
            self._parts.append("\n- ")

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if tag.lower() in {
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "p",
            "div",
            "section",
            "article",
            "li",
            "ul",
            "ol",
            "table",
            "tr",
            "td",
            "th",
            "blockquote",
            "pre",
        }:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if not data:
            return
        cleaned = data.replace("\r", " ").replace("\t", " ").replace("\xa0", " ")
        if cleaned.strip():
            self._parts.append(cleaned)

    def finish(self) -> str:
        return normalize_text("".join(self._parts))


class HtmlToMarkdownParser(HTMLParser):
    """Parse HTML body to markdown, injecting TOC-anchor headings when available."""

    def __init__(self, section_prefix: str, toc_anchor_entries: dict[str, list[dict[str, object]]]) -> None:
        super().__init__(convert_charrefs=True)
        self.section_prefix = section_prefix
        self.toc_anchor_entries = toc_anchor_entries

        self.lines: list[str] = []
        self.headings: list[dict[str, str | int]] = []

        self._buffer: list[str] = []
        self._block_type: str | None = None
        self._heading_level = 0
        self._heading_id: str | None = None
        self._list_stack: list[str] = []
        self._ignore_depth = 0
        self._anchors: set[str] = set()
        self._inserted_toc_fragments: set[str] = set()

    def _append_blank(self) -> None:
        if self.lines and self.lines[-1] != "":
            self.lines.append("")

    def _make_anchor(self, candidate_id: str | None, heading_text: str) -> str:
        source = (candidate_id or heading_text).strip().lower()
        source = re.sub(r"\s+", "-", source)
        source = re.sub(r"[^0-9a-z_\-\u4e00-\u9fff]+", "", source)
        if not source:
            source = "heading"
        base = f"{self.section_prefix}-{source}"
        anchor = base
        n = 2
        while anchor in self._anchors:
            anchor = f"{base}-{n}"
            n += 1
        self._anchors.add(anchor)
        return anchor

    def _inject_toc_heading(self, fragment_id: str) -> None:
        entries = self.toc_anchor_entries.get(fragment_id, [])
        for entry in entries:
            text = str(entry.get("title") or "").strip()
            level = int(entry.get("level") or 1)
            if not text:
                continue
            anchor = self._make_anchor(fragment_id, text)
            md_level = max(3, min(6, level + 2))
            self.lines.extend([f'<a id="{anchor}"></a>', f'{"#" * md_level} {text}', ""])
            self.headings.append({"level": level, "text": text, "anchor": anchor})

    def _flush_block(self) -> None:
        if self._block_type is None:
            self._buffer = []
            return

        text = normalize_text("".join(self._buffer)).replace("\n", " ").strip()
        block_type = self._block_type
        heading_level = self._heading_level
        heading_id = self._heading_id

        self._buffer = []
        self._block_type = None
        self._heading_level = 0
        self._heading_id = None

        if block_type == "skip_heading":
            return
        if not text:
            return

        if block_type == "heading":
            anchor = self._make_anchor(heading_id, text)
            md_level = max(3, min(6, heading_level + 2))
            self.lines.extend([f'<a id="{anchor}"></a>', f'{"#" * md_level} {text}', ""])
            self.headings.append({"level": heading_level, "text": text, "anchor": anchor})
            return

        if block_type == "li":
            marker = "1. " if self._list_stack and self._list_stack[-1] == "ol" else "- "
            self.lines.append(f"{marker}{text}")
            return

        self.lines.extend([text, ""])

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        t = tag.lower()
        attrs_map = dict(attrs)

        if t in {"script", "style"}:
            self._ignore_depth += 1
            return
        if self._ignore_depth > 0:
            return

        elem_id = (attrs_map.get("id") or "").strip()
        if elem_id and elem_id in self.toc_anchor_entries and elem_id not in self._inserted_toc_fragments:
            self._flush_block()
            self._inject_toc_heading(elem_id)
            self._inserted_toc_fragments.add(elem_id)

        if t in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush_block()
            self._heading_level = int(t[1])
            self._heading_id = attrs_map.get("id")
            # Avoid duplicate headings when TOC heading was just injected for same id.
            if elem_id and elem_id in self.toc_anchor_entries:
                self._block_type = "skip_heading"
            else:
                self._block_type = "heading"
            return

        if t in {"ul", "ol"}:
            self._flush_block()
            self._list_stack.append(t)
            return

        if t == "li":
            self._flush_block()
            self._block_type = "li"
            return

        if t in {"p", "div", "section", "article", "blockquote", "pre", "td", "th"}:
            if self._block_type is None:
                self._block_type = "p"
            return

        if t in {"br", "hr"}:
            self._buffer.append("\n")

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        t = tag.lower()

        if t in {"script", "style"}:
            if self._ignore_depth > 0:
                self._ignore_depth -= 1
            return
        if self._ignore_depth > 0:
            return

        if t in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._block_type in {"heading", "skip_heading"}:
            self._flush_block()
            return

        if t == "li" and self._block_type == "li":
            self._flush_block()
            return

        if t in {"p", "div", "section", "article", "blockquote", "pre", "td", "th"} and self._block_type == "p":
            self._flush_block()
            return

        if t in {"ul", "ol"}:
            self._flush_block()
            if self._list_stack:
                self._list_stack.pop()
            self._append_blank()

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._ignore_depth > 0 or self._block_type == "skip_heading" or not data:
            return
        cleaned = data.replace("\r", " ").replace("\t", " ").replace("\xa0", " ")
        if cleaned.strip():
            self._buffer.append(cleaned)

    def finish(self) -> tuple[str, list[dict[str, str | int]]]:
        self._flush_block()
        content = "\n".join(self.lines).strip()
        content = re.sub(r"\n{3,}", "\n\n", content)
        return content, self.headings


def parse_ncx_toc(
    zf: zipfile.ZipFile,
    opf_dir: str,
    manifest_by_id: dict[str, dict[str, str]],
    spine_toc_id: str | None,
) -> list[dict[str, object]]:
    ncx_item = manifest_by_id.get(spine_toc_id or "")
    if not ncx_item:
        for item in manifest_by_id.values():
            if item.get("media_type", "").lower() == "application/x-dtbncx+xml":
                ncx_item = item
                break
    if not ncx_item:
        return []

    ncx_path = posixpath.normpath(posixpath.join(opf_dir, ncx_item["href"]))
    root = ET.fromstring(zf.read(ncx_path))
    base_dir = posixpath.dirname(ncx_path)
    entries: list[dict[str, object]] = []

    def walk(nav_parent: ET.Element, depth: int) -> None:
        for node in nav_parent:
            if local_name(node.tag) != "navPoint":
                continue

            label = ""
            src = ""
            for child in node:
                child_name = local_name(child.tag)
                if child_name == "navLabel":
                    for sub in child:
                        if local_name(sub.tag) == "text" and sub.text:
                            label = normalize_text(sub.text)
                            break
                elif child_name == "content":
                    src = child.attrib.get("src", "")

            if src:
                if "#" in src:
                    href, fragment = src.split("#", 1)
                else:
                    href, fragment = src, ""
                path = posixpath.normpath(posixpath.join(base_dir, href))
                entries.append(
                    {
                        "path": path,
                        "fragment": fragment.strip(),
                        "title": label or fragment or href,
                        "level": depth,
                    }
                )

            walk(node, depth + 1)

    nav_map = None
    for child in root:
        if local_name(child.tag) == "navMap":
            nav_map = child
            break
    if nav_map is not None:
        walk(nav_map, 1)
    return entries


def parse_epub(epub_path: Path) -> list[dict[str, object]]:
    sections: list[dict[str, object]] = []
    with zipfile.ZipFile(epub_path, "r") as zf:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
        rootfile = None
        for elem in container.iter():
            if local_name(elem.tag) == "rootfile":
                rootfile = elem.attrib.get("full-path")
                if rootfile:
                    break
        if not rootfile:
            raise RuntimeError("Cannot find OPF rootfile in EPUB container.xml")

        opf_root = ET.fromstring(zf.read(rootfile))
        opf_dir = posixpath.dirname(rootfile)

        manifest_by_id: dict[str, dict[str, str]] = {}
        manifest_elem = None
        spine_elem = None
        for child in opf_root:
            name = local_name(child.tag)
            if name == "manifest":
                manifest_elem = child
            elif name == "spine":
                spine_elem = child
        if manifest_elem is None or spine_elem is None:
            raise RuntimeError("Invalid OPF: missing manifest or spine")

        for item in manifest_elem:
            if local_name(item.tag) != "item":
                continue
            item_id = item.attrib.get("id")
            href = item.attrib.get("href")
            media_type = item.attrib.get("media-type", "")
            if item_id and href:
                manifest_by_id[item_id] = {"href": href, "media_type": media_type}

        toc_entries = parse_ncx_toc(zf, opf_dir, manifest_by_id, spine_elem.attrib.get("toc"))
        toc_entries_by_path: dict[str, list[dict[str, object]]] = defaultdict(list)
        for entry in toc_entries:
            toc_entries_by_path[str(entry["path"])].append(entry)

        spine_ids: list[str] = []
        for itemref in spine_elem:
            if local_name(itemref.tag) != "itemref":
                continue
            item_idref = itemref.attrib.get("idref")
            if item_idref:
                spine_ids.append(item_idref)

        for index, item_id in enumerate(spine_ids, start=1):
            item = manifest_by_id.get(item_id)
            if not item:
                continue
            href = item["href"]
            media_type = item["media_type"].lower()
            ext = Path(href).suffix.lower()
            if media_type not in {"application/xhtml+xml", "text/html"} and ext not in {
                ".xhtml",
                ".html",
                ".htm",
            }:
                continue

            internal_path = posixpath.normpath(posixpath.join(opf_dir, href))
            raw = zf.read(internal_path)
            html = decode_html(raw)

            html_title = extract_html_title(html, f"Chapter {index}")
            file_toc_entries = toc_entries_by_path.get(internal_path, [])
            title_candidates = [str(e.get("title") or "").strip() for e in file_toc_entries if not e.get("fragment")]
            section_title = title_candidates[0] if title_candidates else html_title

            toc_anchor_entries: dict[str, list[dict[str, object]]] = defaultdict(list)
            for entry in file_toc_entries:
                fragment = str(entry.get("fragment") or "").strip()
                if fragment:
                    toc_anchor_entries[fragment].append(entry)

            parser = HtmlToMarkdownParser(section_prefix=f"s{index}", toc_anchor_entries=toc_anchor_entries)
            parser.feed(html)
            md_text, headings = parser.finish()

            if not md_text:
                fallback = HtmlToTextParser()
                fallback.feed(html)
                md_text = fallback.finish()
            if not md_text:
                continue

            sections.append({"title": section_title, "text": md_text, "headings": headings})

    if not sections:
        raise RuntimeError("No readable HTML/XHTML content found in EPUB.")
    return sections


def iter_heading_toc(headings: Iterable[dict[str, str | int]]) -> list[str]:
    toc_lines: list[str] = []
    for heading in headings:
        level = int(heading.get("level") or 1)
        text = escape_md_link_text(str(heading.get("text") or "").strip())
        anchor = str(heading.get("anchor") or "").strip()
        if not text or not anchor:
            continue
        indent = "  " * max(0, min(level - 1, 3))
        toc_lines.append(f"{indent}- [{text}](#{anchor})")
    return toc_lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert EPUB to Markdown.")
    parser.add_argument("--input", required=True, help="Input .epub file path.")
    parser.add_argument("--output", required=True, help="Output .md file path.")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    sections = parse_epub(input_path)
    generated_at = datetime.now(timezone.utc).isoformat()

    lines = [
        "# EPUB Converted Document",
        "",
        f"- Source EPUB: `{input_path.as_posix()}`",
        f"- Generated at (UTC): `{generated_at}`",
        "",
        "## Table of Contents (Jump Links)",
        "",
    ]

    for idx, section in enumerate(sections, start=1):
        section_title = escape_md_link_text(str(section["title"]))
        section_anchor = f"section-{idx}"
        lines.append(f"- [{section_title}](#{section_anchor})")
        lines.extend(iter_heading_toc(section.get("headings", [])))
    lines.append("")

    for idx, section in enumerate(sections, start=1):
        section_title = str(section["title"])
        section_text = str(section["text"])
        section_anchor = f"section-{idx}"
        lines.extend([f'<a id="{section_anchor}"></a>', f"## {section_title}", "", section_text, ""])

    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(
        "Converted EPUB to Markdown: "
        f"{output_path} ({len(sections)} sections, jump links enabled)"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
