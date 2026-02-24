#!/usr/bin/env python3
"""Convert a Markdown file to PDF via headless Edge/Chrome print-to-pdf."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import markdown as md


DEFAULT_BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def find_browser(custom: str | None) -> Path:
    if custom:
        p = Path(custom)
        if p.exists():
            return p
        raise FileNotFoundError(f"Browser not found: {custom}")
    for item in DEFAULT_BROWSER_CANDIDATES:
        p = Path(item)
        if p.exists():
            return p
    raise FileNotFoundError("Neither Edge nor Chrome was found in default locations.")


def md_to_html(markdown_text: str, title: str) -> str:
    body = md.markdown(
        markdown_text,
        extensions=[
            "extra",
            "toc",
            "tables",
            "fenced_code",
            "sane_lists",
        ],
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title}</title>
  <style>
    @page {{
      size: A4;
      margin: 18mm 14mm 18mm 14mm;
    }}
    html, body {{
      padding: 0;
      margin: 0;
      background: #fff;
      color: #111;
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      line-height: 1.6;
      font-size: 13px;
    }}
    body {{
      max-width: 180mm;
      margin: 0 auto;
      padding: 8mm 2mm;
      box-sizing: border-box;
    }}
    h1 {{ font-size: 24px; margin: 1.2em 0 0.6em; }}
    h2 {{ font-size: 20px; margin: 1.1em 0 0.5em; }}
    h3 {{ font-size: 17px; margin: 1.0em 0 0.4em; }}
    h4, h5, h6 {{ font-size: 15px; margin: 0.9em 0 0.35em; }}
    p, li {{ margin: 0.35em 0; }}
    ul, ol {{ padding-left: 1.4em; }}
    code, pre {{
      font-family: Consolas, "Courier New", monospace;
    }}
    pre {{
      white-space: pre-wrap;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 8px;
      background: #f7f7f7;
    }}
    a {{
      color: #1a5fb4;
      text-decoration: none;
    }}
  </style>
</head>
<body>
{body}
</body>
</html>"""


def path_to_file_url(path: Path) -> str:
    abs_path = path.resolve().as_posix()
    return f"file:///{quote(abs_path, safe='/:')}"


def convert(markdown_path: Path, pdf_path: Path, browser_path: Path) -> None:
    markdown_text = markdown_path.read_text(encoding="utf-8")
    html = md_to_html(markdown_text, markdown_path.stem)

    pdf_path = pdf_path.resolve()
    temp_html_path = pdf_path.with_suffix(".print.html")
    temp_html_path.write_text(html, encoding="utf-8")

    cmd = [
        str(browser_path),
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--print-to-pdf-no-header",
        f"--print-to-pdf={pdf_path.as_posix()}",
        path_to_file_url(temp_html_path),
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True)

    if not pdf_path.exists():
        stdout = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            "Browser did not generate PDF file. "
            f"stdout={stdout!r} stderr={stderr!r}"
        )

    # Keep workspace clean.
    try:
        os.remove(temp_html_path)
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert markdown file to PDF.")
    parser.add_argument("--input", required=True, help="Input markdown file path.")
    parser.add_argument("--output", required=True, help="Output PDF file path.")
    parser.add_argument("--browser", default=None, help="Edge/Chrome executable path.")
    args = parser.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    browser = find_browser(args.browser)
    convert(in_path, out_path, browser)
    print(f"PDF generated: {out_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
