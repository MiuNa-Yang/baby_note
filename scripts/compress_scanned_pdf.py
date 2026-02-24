#!/usr/bin/env python3
"""Compress large scanned PDFs for RAGFlow upload limits.

Requires Ghostscript (gswin64c/gswin32c/gs) installed on the machine.

Example:
  python scripts/compress_scanned_pdf.py  --input "E:\\迅雷下载\\dn\\育儿相关书籍\\海蒂育儿大百科\\海蒂育儿大百科  0-1岁.pdf" --output "E:\\迅雷下载\\dn\\育儿相关书籍\\海蒂育儿大百科\\海蒂育儿大百科  0-1岁.compressed.pdf"   --target-mb 128
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Preset:
    name: str
    pdf_setting: str
    dpi: int
    jpeg_q: int
    grayscale: bool


PRESETS: list[Preset] = [
    Preset("balanced-color", "/ebook", 170, 72, False),
    Preset("small-color", "/screen", 140, 62, False),
    Preset("smaller-color", "/screen", 120, 55, False),
    Preset("balanced-gray", "/ebook", 170, 72, True),
    Preset("small-gray", "/screen", 130, 60, True),
    Preset("tiny-gray", "/screen", 110, 48, True),
    Preset("extreme-gray", "/screen", 96, 42, True),
]


def find_gs() -> Path | None:
    candidates = [
        shutil.which("gswin64c"),
        shutil.which("gswin32c"),
        shutil.which("gs"),
        r"C:\Program Files\gs\gs10.05.1\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs10.04.0\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs10.06.0\bin\gswin64c.exe"
    ]
    for item in candidates:
        if not item:
            continue
        p = Path(item)
        if p.exists():
            return p
    return None


def file_mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024)


def gs_compress(gs_bin: Path, input_pdf: Path, output_pdf: Path, preset: Preset) -> None:
    cmd = [
        str(gs_bin),
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dSubsetFonts=true",
        f"-dPDFSETTINGS={preset.pdf_setting}",
        "-dDownsampleColorImages=true",
        "-dDownsampleGrayImages=true",
        "-dDownsampleMonoImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        "-dGrayImageDownsampleType=/Bicubic",
        f"-dColorImageResolution={preset.dpi}",
        f"-dGrayImageResolution={preset.dpi}",
        f"-dMonoImageResolution={max(200, preset.dpi * 2)}",
        f"-dJPEGQ={preset.jpeg_q}",
    ]
    if preset.grayscale:
        cmd.extend(
            [
                "-sColorConversionStrategy=Gray",
                "-dProcessColorModel=/DeviceGray",
            ]
        )
    cmd.extend(
        [
            f"-sOutputFile={output_pdf}",
            str(input_pdf),
        ]
    )
    subprocess.run(cmd, check=True)


def compress_until_target(
    gs_bin: Path, input_pdf: Path, output_pdf: Path, target_mb: float
) -> tuple[Path, Preset, float, bool]:
    best_file: Path | None = None
    best_size = float("inf")
    best_preset: Preset | None = None

    with tempfile.TemporaryDirectory(prefix="pdf_compress_") as tmpdir:
        tmp = Path(tmpdir)
        for i, preset in enumerate(PRESETS, start=1):
            trial_path = tmp / f"trial_{i:02d}.pdf"
            print(f"[{i}/{len(PRESETS)}] Trying preset: {preset.name}")
            gs_compress(gs_bin, input_pdf, trial_path, preset)
            size = file_mb(trial_path)
            print(f"    -> {size:.2f} MB")

            if size < best_size:
                best_size = size
                best_file = trial_path
                best_preset = preset

            if size <= target_mb:
                output_pdf.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(trial_path, output_pdf)
                return output_pdf, preset, size, True

        if best_file is None or best_preset is None:
            raise RuntimeError("Compression failed: no output generated.")
        output_pdf.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best_file, output_pdf)
        return output_pdf, best_preset, best_size, False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compress scanned PDF to fit upload limits (default 128 MB)."
    )
    parser.add_argument("--input", required=True, help="Input PDF path.")
    parser.add_argument("--output", required=True, help="Output PDF path.")
    parser.add_argument(
        "--target-mb",
        type=float,
        default=128.0,
        help="Target max size in MB (default: 128).",
    )
    args = parser.parse_args()

    input_pdf = Path(args.input).expanduser().resolve()
    output_pdf = Path(args.output).expanduser().resolve()
    target_mb = float(args.target_mb)

    if not input_pdf.exists():
        raise FileNotFoundError(f"Input PDF not found: {input_pdf}")

    gs_bin = find_gs()
    if gs_bin is None:
        print("ERROR: Ghostscript is not installed or not found in PATH.", file=sys.stderr)
        print("Install Ghostscript: https://ghostscript.com/releases/gsdnld.html", file=sys.stderr)
        print("After install, ensure gswin64c is callable from terminal.", file=sys.stderr)
        return 2

    original_size = file_mb(input_pdf)
    print(f"Input:  {input_pdf}")
    print(f"Output: {output_pdf}")
    print(f"Target: <= {target_mb:.2f} MB")
    print(f"Original size: {original_size:.2f} MB")
    print(f"Ghostscript: {gs_bin}")

    out_file, preset, final_size, reached = compress_until_target(
        gs_bin, input_pdf, output_pdf, target_mb
    )

    print("")
    print(f"Best preset: {preset.name}")
    print(f"Result: {out_file}")
    print(f"Final size: {final_size:.2f} MB")
    print(f"Reduced: {max(0.0, original_size - final_size):.2f} MB")
    if reached:
        print("Status: target reached.")
        return 0

    print("Status: target NOT reached; output is smallest result from tested presets.")
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
