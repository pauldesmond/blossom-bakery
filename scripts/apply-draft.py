#!/usr/bin/env python3
"""Apply a draft JSON exported from the Blossom Editor to the source repo.

Usage:
    python scripts/apply-draft.py path/to/blossom-draft-2026-05-09.json

What it does:
    1. Text edits → applied to /<page>.html via CSS selector
       - For pages that originate from _pages/*.yml, ALSO updates the YAML
         (so the change survives the next build.py run)
    2. Image swaps → saves the new image to /images/<new-filename>
       and rewrites every <img src> in /*.html to point at the new file
    3. Page status (hide/show) → comments out the entry in nav data inside
       /scripts/build.py (best-effort, with a warning if the entry can't be
       found)

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
# The editor (edit-blossom/editor.html) loads pages from the repo root
# (BASE_PATH = '../'), so apply-draft must write back to the same root.
ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT
PAGES_DIR = ROOT / "_pages"
IMAGES_DIR = SITE / "images"

# ─── Canonical page registry ─────────────────────────────────────
PAGES_JSON = ROOT / "_data" / "pages.json"

def _load_pages_registry():
    """Single source of truth shared with edit-blossom/editor-app.jsx.
    Returns (PAGE_FILES dict, GENERATED set). Falls back to empty on error.
    """
    if not PAGES_JSON.exists():
        print(f"! {PAGES_JSON} not found — cannot apply draft.", file=sys.stderr)
        return {}, set()
    data = json.loads(PAGES_JSON.read_text(encoding="utf-8"))
    page_files = {p["id"]: p["file"] for p in data.get("pages", [])}
    generated = {p["id"] for p in data.get("pages", []) if p.get("generated")}
    return page_files, generated

PAGE_FILES, GENERATED = _load_pages_registry()


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

    # Derive a new filename based on the original. Strip any trailing
    # "-edit" / "-editN" suffix so repeat swaps don't accumulate
    # (foo-edit.jpg → foo-edit.jpg, not foo-edit-edit.jpg).
    old_path = Path(old_src)
    stem = re.sub(r"-edit\d*$", "", old_path.stem)
    new_name = f"{stem}-edit{ext}"
    out = SITE / "images" / new_name

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(b64))

    new_src = f"images/{new_name}"
    return new_src, out


def rewrite_image_refs(old_src: str, new_src: str) -> int:
    """Walk every HTML file at the repo root and rewrite <img src> refs.
    Returns number of files changed.
    """
    n = 0
    for html in SITE.glob("*.html"):
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
    """Comment out / uncomment the relevant nav entry. Tries site.js first
    (if a v2-style site.js exists at root), else scripts/build.py.
    """
    candidates = [SITE / "site.js", ROOT / "scripts" / "build.py"]
    site_js = next((p for p in candidates if p.exists()), None)
    if site_js is None:
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

    summary = {"text_ok": 0, "text_skipped": [], "yaml_updated": 0, "yaml_misses": [], "images": 0, "page_status": 0}

    # Latent landmine check: warn about _pages/*.yml files that are NOT in
    # GENERATED. They aren't consumed today, but if anyone re-adds them to
    # build.py's PAGE_META later, the stale content overwrites the live HTML.
    if PAGES_DIR.exists():
        stale = sorted(p.stem for p in PAGES_DIR.glob("*.yml") if p.stem not in GENERATED)
        if stale:
            print("  ⓘ stale YAML files (not consumed by build.py): " + ", ".join(stale))
            print("    safe to delete — they only become a trap if re-added to PAGE_META.")

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

        html_path = SITE / file
        if not html_path.exists():
            print(f"! Missing /{file} — skipping {len(page_edits)} edits")
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
                # Mirror to YAML for generated pages — if this fails, CI
                # will overwrite the HTML edit on the next build. Loud warn.
                if page_id in GENERATED:
                    yaml_path = PAGES_DIR / f"{page_id}.yml"
                    if update_yaml_field(yaml_path, original, new_val):
                        summary["yaml_updated"] += 1
                    else:
                        msg = (
                            f"YAML mirror MISSED for {page_id}.yml — build.py will\n"
                            f"      overwrite this edit on next CI run. Hand-fix the\n"
                            f"      YAML before pushing. Selector: {sel}"
                        )
                        print(f"  ⚠  {msg}", file=sys.stderr)
                        summary.setdefault("yaml_misses", []).append((page_id, sel, original, new_val))

        html_path.write_text(str(soup), encoding="utf-8")

    # ── 2. Image swaps ─────────────────────────────────────────────
    for old_src, info in images.items():
        result = save_image(old_src, info)
        if not result:
            continue
        new_src, new_path = result
        files_touched = rewrite_image_refs(old_src, new_src)
        summary["images"] += 1
        # If the old image is no longer referenced anywhere and isn't the
        # same file we just wrote, remove it so disk doesn't accumulate cruft.
        old_path_abs = SITE / old_src
        if old_path_abs.exists() and old_path_abs.resolve() != new_path.resolve():
            still_used = any(
                f'src="{old_src}"' in h.read_text(encoding="utf-8")
                for h in SITE.glob("*.html") if "edit-blossom" not in h.parts
            )
            if not still_used:
                old_path_abs.unlink()
                print(f"  ✓ image '{old_src}' → '{new_src}' (rewrote {files_touched}, removed old)")
                continue
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
    if summary["yaml_misses"]:
        print(f"  ⚠  {len(summary['yaml_misses'])} YAML mirror miss(es) — "
              f"hand-fix these BEFORE pushing or CI will revert:")
        for page_id, sel, orig, new_val in summary["yaml_misses"]:
            print(f"    _pages/{page_id}.yml  was: \"{orig[:40]}…\"  →  \"{new_val[:40]}…\"")
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
