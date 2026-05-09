#!/usr/bin/env python3
"""Apply a draft JSON exported from the Blossom Editor to the source repo.

Usage:
    python scripts/apply-draft.py path/to/blossom-draft-2026-05-09.json

What it does:
    1. Text edits → applied to /<page>.html (live root site) via CSS selector
       - For the two pages still auto-built from _pages/*.yml (scones, about),
         ALSO updates the YAML so the change survives the next build.py run
    2. Image swaps → saves the new image to /images/<new-filename>
       and rewrites every <img src> in /*.html to point at the new file
    3. Page status (hide/show) → no-op on the live root (no site.js nav data
         file at root); silently skipped

Idempotent — running it twice with the same JSON has the same effect as once.
Prints a summary of what was changed and a list of items that couldn't be
auto-applied (so you can hand-fix and review the diff before pushing).

Requires:  pip install pyyaml beautifulsoup4
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
    from bs4 import BeautifulSoup
except ImportError:
    print("This script needs PyYAML and BeautifulSoup4:", file=sys.stderr)
    print("    pip install pyyaml beautifulsoup4", file=sys.stderr)
    sys.exit(1)


# ─── Paths ─────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
V2 = ROOT  # live site lives at the repo root; v2/ is an unused redesign draft
PAGES_DIR = ROOT / "_pages"
IMAGES_DIR = V2 / "images"

# Which page IDs are hand-crafted (HTML only — no YAML to update on the live
# root site). Only `scones` and `about` are still auto-built from _pages/*.yml
# by scripts/build.py; everything else has been promoted to hand-crafted HTML
# and the matching YAML files are now stale, so don't write back into them.
HAND_CRAFTED = {
    "index", "wedding-cakes", "wedding-bakes", "cupcakes", "contact",
    "cakes", "ganache-drip-cakes", "numbered-birthday-cakes",
    "childrens-cakes", "speciality-and-everyday-cakes",
    "handmade-biscuits", "giant-cookies", "traybakes",
    "afternoon-tea", "afternoon-teas", "customer-reviews",
}

# Map page id → file. Mirror the editor's PAGES list (editor-app.jsx).
PAGE_FILES = {
    "index": "index.html",
    "about": "about.html",
    "wedding-cakes": "wedding-cakes.html",
    "wedding-bakes": "wedding-bakes.html",
    "cakes": "cakes.html",
    "ganache-drip-cakes": "ganache-drip-cakes.html",
    "numbered-birthday-cakes": "numbered-birthday-cakes.html",
    "childrens-cakes": "childrens-cakes.html",
    "speciality-and-everyday-cakes": "speciality-and-everyday-cakes.html",
    "cupcakes": "cupcakes.html",
    "handmade-biscuits": "handmade-biscuits.html",
    "traybakes": "traybakes.html",
    "giant-cookies": "giant-cookies.html",
    "scones": "scones.html",
    "afternoon-tea": "afternoon-tea.html",
    "customer-reviews": "customer-reviews.html",
    "contact": "contact.html",
}


# ─── Selector parser ───────────────────────────────────────────────────
# The editor emits selectors like:
#   "main > section:nth-of-type(2) > div > h2"
#   "footer#site-footer > p"
# BeautifulSoup's .select() understands these — but it does NOT support :has().
# Our injected pathFor() avoids :has, so we should be fine.

def find_by_selector(soup: BeautifulSoup, selector: str):
    """Return the first matching element, or None."""
    try:
        results = soup.select(selector)
        return results[0] if results else None
    except Exception:
        return None


def replace_text(el, new_text: str) -> bool:
    """Replace the visible text of `el` with `new_text`, preserving its tag.
    Returns True if something changed.
    """
    if el is None:
        return False
    current = el.get_text()
    if current.strip() == new_text.strip():
        return False
    # Clear children, set text. This drops any nested formatting (em, strong).
    # The editor only edits leaf-ish elements so this is usually fine.
    el.clear()
    el.append(new_text)
    return True


# ─── YAML round-trip ───────────────────────────────────────────────────
def update_yaml_field(yaml_path: Path, old_text: str, new_text: str) -> bool:
    """Find a string anywhere in the YAML whose stripped value matches
    `old_text` and replace it with `new_text`. Returns True if changed.
    """
    if not yaml_path.exists():
        return False
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}

    changed = [False]

    def walk(node):
        if isinstance(node, dict):
            for k, v in list(node.items()):
                if isinstance(v, str) and v.strip() == old_text.strip():
                    node[k] = new_text
                    changed[0] = True
                else:
                    walk(v)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                if isinstance(v, str) and v.strip() == old_text.strip():
                    node[i] = new_text
                    changed[0] = True
                else:
                    walk(v)

    walk(data)

    if changed[0]:
        yaml_path.write_text(
            yaml.safe_dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
    return changed[0]


# ─── Image swaps ───────────────────────────────────────────────────────
def save_image(old_src: str, info: dict[str, str]) -> tuple[str, Path] | None:
    """Decode the data URL and write it next to the existing image.
    Returns (new_relative_src, absolute_path) or None on failure.
    """
    data_url = info.get("dataUrl") or ""
    m = re.match(r"data:(image/[^;]+);base64,(.+)", data_url, re.DOTALL)
    if not m:
        print(f"  ! image '{old_src}' is not a data URL — skipping", file=sys.stderr)
        return None

    mime, b64 = m.group(1), m.group(2)
    ext = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }.get(mime, ".bin")

    # Derive a new filename based on the original
    old_path = Path(old_src)
    stem = old_path.stem
    new_name = f"{stem}-edit{ext}"
    out = V2 / "images" / new_name

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(b64))

    new_src = f"images/{new_name}"
    return new_src, out


def rewrite_image_refs(old_src: str, new_src: str) -> int:
    """Walk every HTML file under the site root and rewrite <img src> + CSS url() refs.
    Returns number of files changed.
    """
    n = 0
    for html in V2.rglob("*.html"):
        if "edit-blossom" in html.parts:
            continue  # don't touch the editor itself
        text = html.read_text(encoding="utf-8")
        new = text.replace(f'src="{old_src}"', f'src="{new_src}"')
        # Also handle "./..." and "/v2/..." prefixed refs, but keep this simple.
        if new != text:
            html.write_text(new, encoding="utf-8")
            n += 1
    return n


# ─── Page status (hide/show in nav) ────────────────────────────────────
def update_page_status(page_id: str, published: bool) -> bool:
    """Comment out / uncomment the relevant `href: "<file>.html"` line in
    site.js. Best-effort — prints a warning if the page isn't in the nav.
    """
    site_js = V2 / "site.js"
    if not site_js.exists():
        return False
    text = site_js.read_text(encoding="utf-8")

    file = PAGE_FILES.get(page_id)
    if not file:
        return False

    # Match a line like:  { href: "cakes.html", title: "...", note: "..." },
    line_re = re.compile(
        r'^(?P<indent>\s*)(?P<comment>//\s*)?\{[^}]*href:\s*"' + re.escape(file) + r'"[^}]*\},?\s*$',
        re.MULTILINE,
    )

    def repl(m):
        indent = m.group("indent")
        commented = bool(m.group("comment"))
        body = m.group(0).lstrip().lstrip("/").lstrip()
        if not published and not commented:
            return f"{indent}// {body}"
        if published and commented:
            return f"{indent}{body}"
        return m.group(0)

    new_text, n = line_re.subn(repl, text)
    if n and new_text != text:
        site_js.write_text(new_text, encoding="utf-8")
        return True
    return False


# ─── Main ──────────────────────────────────────────────────────────────
def apply_draft(draft_path: Path) -> None:
    draft = json.loads(draft_path.read_text(encoding="utf-8"))
    edits: dict[str, dict[str, str]] = draft.get("edits", {}) or {}
    images: dict[str, dict[str, str]] = draft.get("images", {}) or {}
    page_status: dict[str, bool] = draft.get("pageStatus", {}) or {}

    summary = {"text_ok": 0, "text_skipped": [], "yaml_updated": 0, "images": 0, "page_status": 0}

    # ── 1. Text edits ───────────────────────────────────────────────
    for page_id, page_edits in edits.items():
        if not page_edits:
            continue
        file = PAGE_FILES.get(page_id)
        if not file:
            print(f"! Unknown page id '{page_id}' — skipping {len(page_edits)} edits")
            for sel, val in page_edits.items():
                summary["text_skipped"].append((page_id, sel, val, "unknown page id"))
            continue

        html_path = V2 / file
        if not html_path.exists():
            print(f"! Missing {file} at site root — skipping {len(page_edits)} edits")
            for sel, val in page_edits.items():
                summary["text_skipped"].append((page_id, sel, val, "html missing"))
            continue

        soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")

        # Track originals so we can update the YAML afterwards
        for sel, new_val in page_edits.items():
            el = find_by_selector(soup, sel)
            if el is None:
                summary["text_skipped"].append((page_id, sel, new_val, "selector did not match"))
                continue
            original = el.get_text()
            if replace_text(el, new_val):
                summary["text_ok"] += 1
                # Mirror to YAML for generated pages
                if page_id not in HAND_CRAFTED:
                    yaml_path = PAGES_DIR / f"{page_id}.yml"
                    if update_yaml_field(yaml_path, original, new_val):
                        summary["yaml_updated"] += 1

        html_path.write_text(str(soup), encoding="utf-8")

    # ── 2. Image swaps ─────────────────────────────────────────────
    for old_src, info in images.items():
        result = save_image(old_src, info)
        if not result:
            continue
        new_src, _ = result
        files_touched = rewrite_image_refs(old_src, new_src)
        summary["images"] += 1
        print(f"  ✓ image '{old_src}' → '{new_src}' (rewrote {files_touched} file{'s' if files_touched != 1 else ''})")

    # ── 3. Page status ─────────────────────────────────────────────
    for page_id, published in page_status.items():
        if update_page_status(page_id, bool(published)):
            summary["page_status"] += 1
            print(f"  ✓ page '{page_id}' → {'visible' if published else 'hidden'} in nav")

    # ── Summary ────────────────────────────────────────────────────
    print()
    print("─" * 56)
    print(f"  Applied: {summary['text_ok']} text edit(s)")
    print(f"           {summary['yaml_updated']} YAML field(s) updated")
    print(f"           {summary['images']} image swap(s)")
    print(f"           {summary['page_status']} page-status change(s)")
    if summary["text_skipped"]:
        print(f"  Skipped: {len(summary['text_skipped'])} edit(s) — see below")
        for page_id, sel, val, reason in summary["text_skipped"]:
            print(f"    [{page_id}] {sel}  → \"{val[:40]}…\"  ({reason})")
    print("─" * 56)
    print()
    print("Next: review the diff with `git diff`, commit, and push.")


def main() -> None:
    p = argparse.ArgumentParser(description="Apply a Blossom Editor draft to the repo.")
    p.add_argument("draft", type=Path, help="Path to the exported draft JSON")
    args = p.parse_args()

    if not args.draft.exists():
        print(f"Draft not found: {args.draft}", file=sys.stderr)
        sys.exit(1)

    apply_draft(args.draft)


if __name__ == "__main__":
    main()
