#!/usr/bin/env python3
"""Build one tailored resume (Word + PDF) from a tailoring file in tailor/.

    .venv/bin/python scripts/build_resume.py tailor/acme--operations-manager.json
    .venv/bin/python scripts/build_resume.py tailor/acme--operations-manager.json --position-id <id>

The tailoring file ("overlay") rewords and reorders what is already in
profile/resume.json for one job; see docs/dev/CONFIG.md. It never adds
experience the master resume does not have.

Writes:
  Applications/<Company>/<Name> - Resume - <Role> (<Company>).docx
  Applications/<Company>/<Name> - Resume - <Role> (<Company>).pdf

The PDF is made with LibreOffice (soffice --headless). Prints the PDF path
relative to the project folder on the last line, and with --position-id sets
that position's resume_path in dashboard/data/positions.json.

Exit codes: 0 built (PDF ok), 2 bad input, 3 Word file built but the PDF
could not be made (LibreOffice missing or failed), 4 PDF longer than expected.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import generate_resume as g  # noqa: E402
from jobsearch_lib import file_lock, load_positions, now_iso, save_positions  # noqa: E402


def find_soffice() -> str | None:
    home = Path.home()
    for cand in (
        home / ".local/bin/soffice",
        Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        home / "Applications/LibreOffice.app/Contents/MacOS/soffice",
        Path("/opt/homebrew/bin/soffice"),
        Path("/usr/local/bin/soffice"),
    ):
        if cand.exists() and os.access(cand, os.X_OK):
            return str(cand)
    return shutil.which("soffice")


def to_pdf(docx: Path) -> Path | None:
    soffice = find_soffice()
    if not soffice:
        print("LibreOffice is not installed, so only the Word file was made. "
              "Ask Claude to install LibreOffice.", file=sys.stderr)
        return None
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(docx.parent), str(docx)],
            check=False, capture_output=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        print("LibreOffice took too long to make the PDF.", file=sys.stderr)
        return None
    pdf = docx.with_suffix(".pdf")
    return pdf if pdf.exists() else None


def page_count(pdf: Path) -> int | None:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf)).pages)
    except ImportError:
        raw = pdf.read_bytes()
        n = len(re.findall(rb"/Type\s*/Page(?!s)", raw))
        return n or None
    except Exception:  # noqa: BLE001
        return None


def output_docx(data: dict, overlay: dict) -> Path:
    name = g.safe_filename(data.get("name") or "Resume")
    company = g.safe_filename(overlay.get("company") or "Company")
    role = g.safe_filename(overlay.get("role") or "Role")
    return ROOT / "Applications" / company / f"{name} - Resume - {role} ({company}).docx"


def load_overlay(path: Path) -> dict:
    try:
        overlay = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"The tailoring file {path} does not exist.")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"The tailoring file {path} has a typo (line {exc.lineno}).")
    if not overlay.get("company") or not overlay.get("role"):
        raise SystemExit("The tailoring file needs at least a 'company' and a 'role'.")
    return overlay


def build(overlay_path: Path) -> tuple[Path, Path | None, int | None, bool]:
    """Returns (docx, pdf or None, pages or None, one_page)."""
    overlay = load_overlay(overlay_path)
    data = g.apply_overlay(g.load_data(), overlay)
    one_page = bool(overlay.get("one_page"))
    docx = output_docx(data, overlay)
    g.create_resume(data, docx, one_page=one_page)
    pdf = to_pdf(docx)
    pages = page_count(pdf) if pdf else None
    return docx, pdf, pages, one_page


def set_resume_path(position_id: str, rel: str) -> bool:
    with file_lock():
        data = load_positions()
        pos = next((p for p in data["positions"] if p.get("id") == position_id), None)
        if pos is None:
            print(f"No position with id {position_id!r} was found, so the dashboard was not updated.",
                  file=sys.stderr)
            return False
        pos["resume_path"] = rel
        pos["resume_requested"] = False
        pos["resume_built_at"] = now_iso()
        save_positions(data)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("overlay", help="tailor/<file>.json")
    parser.add_argument("--position-id", help="set resume_path on this position")
    args = parser.parse_args()

    overlay_path = Path(args.overlay)
    if not overlay_path.is_absolute():
        overlay_path = (Path.cwd() / overlay_path) if (Path.cwd() / overlay_path).exists() else ROOT / overlay_path

    docx, pdf, pages, one_page = build(overlay_path)
    expected = 1 if one_page else 2
    final = pdf or docx
    rel = str(final.relative_to(ROOT))
    if args.position_id:
        set_resume_path(args.position_id, rel)

    code = 0
    if pdf is None:
        code = 3
    elif pages is not None and pages > expected:
        print(f"Warning: the PDF is {pages} pages, longer than the {expected} expected. "
              "Shorten a few bullets in the tailoring file and rebuild.", file=sys.stderr)
        code = 4
    else:
        print(f"PDF ready ({pages if pages is not None else '?'} page{'s' if pages != 1 else ''}).",
              file=sys.stderr)
    print(rel)
    return code


if __name__ == "__main__":
    sys.exit(main())
