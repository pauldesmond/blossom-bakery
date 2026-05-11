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

# Pull build.py's nav renderer so we use the EXACT same nav model when
# rewriting hand-crafted pages' nav blocks. Keeps a single source of truth
# for the markup; build.py and apply-draft.py never disagree on what
# the nav should look like.
def _import_build():
    import importlib.util
    spec = importlib.util.spec_from_file_location("blossom_build", Path(__file__).resolve().parent / "build.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

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


# ─── Per-element text colour palette (mirrors editor-app.jsx TEXT_COLOURS) ───
# Helen can only pick from this set in the editor; we still validate here
# so a hand-edited draft can't inject arbitrary CSS.
ALLOWED_TEXT_COLOURS = {
    '#d89396',  # blush
    '#b8676a',  # deep rose
    '#9bb098',  # sage
    '#4a423a',  # soft ink
    '#7a7068',  # muted
}

# Mirrors editor-app.jsx TEXT_SIZES — keep in sync.
ALLOWED_FONT_SIZES = {
    '14px',  # small
    '17px',  # body
    '28px',  # subhead
    '48px',  # heading
    '80px',  # display
}

# Mirrors editor-app.jsx TEXT_ALIGNS — keep in sync.
ALLOWED_TEXT_ALIGNS = {'left', 'center', 'right'}


def apply_element_styles(soup, decls_by_selector: dict) -> tuple[int, list]:
    """Apply inline styles to elements. Supports `color` and `font-size`.
    Returns (n_applied, list_of_skipped_msgs).
    """
    applied = 0
    skipped = []
    for sel, decls in (decls_by_selector or {}).items():
        el = find_by_selector(soup, sel)
        if el is None:
            skipped.append(f"selector did not match: {sel}")
            continue
        style_attr = el.get('style', '') or ''
        cur = {}
        for part in style_attr.split(';'):
            if ':' in part:
                k, v = part.split(':', 1)
                cur[k.strip().lower()] = v.strip()
        d = decls or {}
        colour = d.get('color')
        if colour is None or colour == '':
            cur.pop('color', None)
        else:
            colour = colour.strip().lower()
            if colour not in ALLOWED_TEXT_COLOURS:
                skipped.append(f"colour '{colour}' not in palette: {sel}")
                continue
            cur['color'] = colour
        size = d.get('fontSize')
        if size is None or size == '':
            cur.pop('font-size', None)
        else:
            size = size.strip().lower()
            if size not in ALLOWED_FONT_SIZES:
                skipped.append(f"font-size '{size}' not in palette: {sel}")
                continue
            cur['font-size'] = size
        align = d.get('textAlign')
        if align is None or align == '':
            cur.pop('text-align', None)
        else:
            align = align.strip().lower()
            if align not in ALLOWED_TEXT_ALIGNS:
                skipped.append(f"text-align '{align}' not allowed: {sel}")
                continue
            cur['text-align'] = align
        if cur:
            el['style'] = '; '.join(f"{k}: {v}" for k, v in cur.items())
        elif 'style' in el.attrs:
            del el['style']
        applied += 1
    return applied, skipped


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


def _el_text_with_br(el) -> str:
    """Return el's text with '\\n' wherever a <br> appears among its
    immediate children. Inverse of replace_text — used for honest equality
    checks before rewriting.
    """
    parts = []
    for child in el.children:
        if getattr(child, 'name', None) == 'br':
            parts.append('\n')
        else:
            parts.append(child.get_text() if hasattr(child, 'get_text') else str(child))
    return ''.join(parts) if parts else el.get_text()


def replace_text(soup: BeautifulSoup, el, new_text: str) -> bool:
    """Replace the visible text of `el` with `new_text`, preserving its tag.
    Newlines in new_text become <br> elements so multi-line edits roundtrip.
    Returns True if something changed.
    """
    if el is None:
        return False
    current = _el_text_with_br(el)
    if current.strip() == new_text.strip():
        return False
    # Clear and rebuild as text nodes interleaved with <br>. Drops any inner
    # formatting (em, strong) — the iframe-side isEditable guard prevents
    # this for compound elements with non-<br> children.
    el.clear()
    parts = new_text.split('\n')
    for i, line in enumerate(parts):
        if i > 0:
            el.append(soup.new_tag('br'))
        el.append(line)
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
    """Walk every HTML file at the repo root and rewrite all references
    pointing at old_src — both <img src="…"> and the absolute-URL form
    <meta content="https://…/old_src"> used for og:image. Missing the
    meta-tag variant previously left og:image pointing at deleted files
    after a swap, so social-share previews 404'd until manual fix-up.
    Returns number of files changed.
    """
    n = 0
    abs_url = f"https://myblossombakery.co.uk/{old_src}"
    new_abs = f"https://myblossombakery.co.uk/{new_src}"
    for html in SITE.glob("*.html"):
        if "edit-blossom" in html.parts:
            continue  # don't touch the editor itself
        text = html.read_text(encoding="utf-8")
        new = (text
               .replace(f'src="{old_src}"', f'src="{new_src}"')
               .replace(f'content="{abs_url}"', f'content="{new_abs}"'))
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


# ─── Page deletion (archive + drop from registry) ────────────────────────
# Distinct from page-status hide (toggles nav visibility only). Delete
# physically moves /<slug>.html → _archive/<slug>-YYYYMMDD.html and drops
# the entry from _data/pages.json. The live URL 404s after this; archived
# file is recoverable by hand (mv back, re-add to pages.json).
ARCHIVE_DIR = SITE / "_archive"


def _drop_from_registry(page_id: str) -> None:
    """Remove the page from _data/pages.json so build.py + the editor
    stop seeing it. No-op if the registry or entry doesn't exist."""
    if not PAGES_JSON.exists():
        return
    reg = json.loads(PAGES_JSON.read_text(encoding="utf-8"))
    pages = reg.get("pages", [])
    new_pages = [p for p in pages if p.get("id") != page_id]
    if len(new_pages) != len(pages):
        reg["pages"] = new_pages
        PAGES_JSON.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def archive_and_unlink_page(page_id: str) -> tuple[bool, str]:
    """Move /<slug>.html to _archive/<slug>-YYYYMMDD.html, remove its
    nav entry, drop from pages.json. Returns (ok, message)."""
    file = PAGE_FILES.get(page_id)
    if not file:
        return (False, f"unknown page id '{page_id}'")
    src = SITE / file
    if not src.exists():
        # File already gone — still clean nav + registry, treat as success.
        update_page_status(page_id, False)
        _drop_from_registry(page_id)
        return (True, "file already missing — cleaned nav/registry only")

    ARCHIVE_DIR.mkdir(exist_ok=True)
    from datetime import date
    stamp = date.today().strftime("%Y%m%d")
    dst = ARCHIVE_DIR / f"{Path(file).stem}-{stamp}{Path(file).suffix}"
    n = 2
    while dst.exists():
        dst = ARCHIVE_DIR / f"{Path(file).stem}-{stamp}-{n}{Path(file).suffix}"
        n += 1
    src.rename(dst)
    update_page_status(page_id, False)  # comment out nav entry if site.js-style
    _drop_from_registry(page_id)
    return (True, f"archived → _archive/{dst.name}")


# ─── Nav + cat-grid sync ────────────────────────────────────────────────
# Site nav and the homepage cat-grid are hand-coded into every HTML file.
# These two helpers regenerate them from _data/pages.json so a new page
# created via the editor automatically wires into the menus and homepage.

# Match the block render_nav() emits in build.py: mobile-toggle button
# followed (after whitespace) by <nav class="site-nav">…</nav>. We
# replace that whole region; everything outside it (brand link, Enquire
# button, etc.) stays untouched.
#
# Attribute order in the opening <button> tag is order-agnostic — the
# repo's auto-formatter sometimes reorders attrs so `class="mobile-toggle"`
# ends up after `aria-controls`, etc. Previous regex required class= to
# come first, which silently skipped ~9 pages on each nav sync.
_NAV_BLOCK_RE = re.compile(
    r'<button[^>]*class="mobile-toggle"[^>]*>.*?</button>\s*<nav class="site-nav">.*?</nav>',
    re.DOTALL,
)


def sync_navs() -> int:
    """Rewrite the nav block in every hand-crafted HTML file from pages.json.
    Returns the number of files that actually changed."""
    build_mod = _import_build()
    changed = 0
    for html_path in sorted(SITE.glob("*.html")):
        if "edit-blossom" in html_path.parts:
            continue
        text = html_path.read_text(encoding="utf-8")
        if 'class="site-nav"' not in text:
            continue
        new_nav = build_mod.render_nav(html_path.name)
        new_text, n = _NAV_BLOCK_RE.subn(new_nav, text, count=1)
        if n and new_text != text:
            html_path.write_text(new_text, encoding="utf-8")
            changed += 1
    return changed


def _first_real_img_src(html_path: Path) -> tuple[str, str] | None:
    """Find the first <img> in a page that points at a real photo (not the
    placeholder SVG). Returns (src, alt) or None if there isn't one."""
    if not html_path.exists():
        return None
    soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()
        if not src or "_add-photo.svg" in src:
            continue
        # Skip header/footer/nav imgs (logo, social icons, etc.) — only
        # body content imgs are good cat-card candidates.
        if img.find_parent(["header", "footer", "nav"]):
            continue
        return (src, (img.get("alt") or "").strip())
    return None


def sync_cat_grid_for_new_pages(new_page_entries: list[dict]) -> int:
    """Append a cat-card to index.html's .cat-grid for each new page.
    Existing cards are left alone — Paul's hand-crafted ordering wins.
    Returns the number of cards added."""
    if not new_page_entries:
        return 0
    index_path = SITE / "index.html"
    if not index_path.exists():
        return 0
    soup = BeautifulSoup(index_path.read_text(encoding="utf-8"), "html.parser")
    grid = soup.find("div", class_="cat-grid")
    if not grid:
        return 0
    existing_hrefs = {
        (a.get("href") or "").strip()
        for a in grid.find_all("a", class_="cat-card")
    }
    added = 0
    for np in new_page_entries:
        href = np.get("file", "")
        if not href or href in existing_hrefs:
            continue
        page_path = SITE / href
        first = _first_real_img_src(page_path)
        if first:
            card_src, card_alt = first
        else:
            card_src = "images/_add-photo.svg?slot=card-" + np.get("id", "new")
            card_alt = np.get("label", np.get("id", ""))
        nav = np.get("nav") or {}
        title = np.get("label", np.get("id", ""))
        meta = nav.get("note", "Click to explore")
        # Build the card with the same shape as Paul's existing cat-cards.
        new_card_html = (
            f'<a href="{href}" class="cat-card">'
            f'<div class="cat-card__img"><img src="{card_src}" alt="{card_alt}" loading="lazy" /></div>'
            f'<div class="cat-card__body">'
            f'<div class="cat-card__title">{title}</div>'
            f'<div class="cat-card__meta">{meta}</div>'
            f'</div>'
            f'</a>'
        )
        grid.append(BeautifulSoup(new_card_html, "html.parser"))
        added += 1
    if added:
        index_path.write_text(str(soup), encoding="utf-8")
    return added


# ─── Main ──────────────────────────────────────────────────────────────
def apply_draft(draft_path: Path) -> None:
    draft = json.loads(draft_path.read_text(encoding="utf-8"))
    edits: dict[str, dict[str, str]] = draft.get("edits", {}) or {}
    images: dict[str, dict[str, str]] = draft.get("images", {}) or {}
    image_deletes: list[str] = draft.get("imageDeletes", []) or []
    page_status: dict[str, bool] = draft.get("pageStatus", {}) or {}
    new_pages: list[dict] = draft.get("newPages", []) or []
    deleted_pages: list = draft.get("deletedPages", []) or []
    styles: dict[str, dict] = draft.get("styles", {}) or {}

    # ── 0. Materialise new pages (copy template HTML, register in pages.json)
    if new_pages:
        registry = json.loads(PAGES_JSON.read_text(encoding="utf-8")) if PAGES_JSON.exists() else {"pages": []}
        existing_ids = {p["id"] for p in registry.get("pages", [])}
        registry_dirty = False
        for np in new_pages:
            nid = np["id"]
            template_id = np.get("template")
            template_file = PAGE_FILES.get(template_id)
            new_file = np.get("file") or f"{nid}.html"
            if not template_file:
                print(f"! New page '{nid}': unknown template '{template_id}' — skipping", file=sys.stderr)
                continue
            tpl_path = SITE / template_file
            new_path = SITE / new_file
            if not tpl_path.exists():
                print(f"! New page '{nid}': template /{template_file} missing — skipping", file=sys.stderr)
                continue
            if not new_path.exists():
                new_path.write_bytes(tpl_path.read_bytes())
                print(f"  + created /{new_file} from /{template_file}")
            if nid not in existing_ids:
                entry = {
                    # New page is being PROMOTED to the live site right now,
                    # so it goes into pages.json as published=true regardless
                    # of the draft entry's value (the draft's `published`
                    # flag means "not yet on live" while it's still in
                    # editor state — once apply-draft runs, that's no
                    # longer true). Helen can hide later via the Hide
                    # toggle if she wants.
                    "id": nid, "file": new_file, "label": np.get("label", nid),
                    "published": True, "generated": False,
                }
                # Optional nav placement chosen in NewPageModal: section is
                # one of "cakes" / "weddings" / "bakes" / None. If supplied,
                # auto-pick an order at the bottom of that section so the
                # new page lands last in the dropdown.
                section = np.get("section")
                if section:
                    existing_orders = [
                        (p.get("nav") or {}).get("order", 0)
                        for p in registry.get("pages", [])
                        if (p.get("nav") or {}).get("section") == section
                    ]
                    next_order = (max(existing_orders) if existing_orders else 0) + 10
                    entry["nav"] = {
                        "section": section,
                        "label": np.get("label", nid),
                        "order": next_order,
                    }
                    note = (np.get("note") or "").strip()
                    if note:
                        entry["nav"]["note"] = note
                registry.setdefault("pages", []).append(entry)
                registry_dirty = True
                # Make this page editable in subsequent runs
                PAGE_FILES[nid] = new_file
        if registry_dirty:
            PAGES_JSON.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"  ✓ _data/pages.json updated ({len(new_pages)} new page(s))")

    summary = {"text_ok": 0, "text_skipped": [], "yaml_updated": 0, "yaml_misses": [], "images": 0, "images_deleted": 0, "page_status": 0, "styles_ok": 0, "styles_skipped": [], "nav_synced": 0, "cards_added": 0, "deleted": 0, "delete_skipped": []}

    # Latent landmine check: warn about _pages/*.yml files that are NOT in
    # GENERATED. They aren't consumed today, but if anyone re-adds them to
    # build.py's PAGE_META later, the stale content overwrites the live HTML.
    if PAGES_DIR.exists():
        stale = sorted(p.stem for p in PAGES_DIR.glob("*.yml") if p.stem not in GENERATED)
        if stale:
            print("  ⓘ stale YAML files (not consumed by build.py): " + ", ".join(stale))
            print("    safe to delete — they only become a trap if re-added to PAGE_META.")

    # ── 0b. Page deletions ──────────────────────────────────────────
    # Runs BEFORE text/styles/images so we don't waste cycles editing a
    # file that's about to be archived. Index/homepage is permanently
    # exempt — guarded on both sides (editor hides the Delete button;
    # we double-check here in case the draft somehow contains it).
    for page_id in deleted_pages:
        if page_id == "index":
            summary["delete_skipped"].append((page_id, "homepage cannot be deleted"))
            print(f"  ! page '{page_id}' → homepage cannot be deleted")
            continue
        ok, msg = archive_and_unlink_page(page_id)
        if ok:
            summary["deleted"] += 1
            print(f"  ✓ page '{page_id}' → {msg}")
        else:
            summary["delete_skipped"].append((page_id, msg))
            print(f"  ! page '{page_id}' → {msg}")

    # ── 1. Text edits ───────────────────────────────────────────────
    for page_id, page_edits in edits.items():
        if not page_edits:
            continue
        # Defensive: if a page was queued for deletion in the same draft,
        # skip its pending edits. The editor strips these client-side
        # already, but cheap to belt-and-braces here.
        if page_id in deleted_pages:
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
            original = _el_text_with_br(el)
            if replace_text(soup, el, new_val):
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

    # ── 1b. Per-element styles (text colour + size) ─────────────────
    # Second pass — re-open each page's HTML so we apply against the latest
    # text-edited state. Validates against ALLOWED_TEXT_COLOURS / _FONT_SIZES.
    for page_id, page_styles in styles.items():
        if not page_styles:
            continue
        # Same defensive skip as text edits — page is being archived.
        if page_id in deleted_pages:
            continue
        file = PAGE_FILES.get(page_id)
        if not file:
            print(f"! Unknown page id '{page_id}' for styles — skipping {len(page_styles)} entries")
            for sel in page_styles:
                summary["styles_skipped"].append((page_id, sel, "unknown page id"))
            continue
        html_path = SITE / file
        if not html_path.exists():
            print(f"! Missing /{file} for styles — skipping {len(page_styles)} entries")
            for sel in page_styles:
                summary["styles_skipped"].append((page_id, sel, "html missing"))
            continue
        soup_styles = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
        n_ok, skipped = apply_element_styles(soup_styles, page_styles)
        summary["styles_ok"] += n_ok
        for msg in skipped:
            summary["styles_skipped"].append((page_id, msg, ""))
        if n_ok:
            html_path.write_text(str(soup_styles), encoding="utf-8")
            print(f"  ✓ styles applied to /{file} ({n_ok} element{'s' if n_ok != 1 else ''})")

    # ── 2. Image swaps ─────────────────────────────────────────────
    for old_src, info in images.items():
        # Skip "chained" re-swap entries where the old_src is itself a data
        # URL. These happen when Helen swaps photo A → B → C — the second
        # entry has dataUrl-of-B as its key. There's no HTML reference to
        # rewrite (no <img src="data:image/..."> on disk), and Path(SITE/<huge
        # data url>) overflows the OS filename limit. Apply the FIRST swap
        # only and warn.
        if old_src.startswith("data:"):
            print(f"  ! image entry with data:URL key — chained re-swap, skipping (the prior swap on this image still lands)")
            continue
        # Pre-uploaded path: the editor uploaded the photo to the repo
        # via publish-draft mode=upload before publishing, and stored the
        # returned newSrc string as the dict value here. The file already
        # exists on disk; we just need to rewrite refs and clean up the
        # old original.
        if isinstance(info, str) and not info.startswith("data:"):
            new_src = info
            new_path = SITE / new_src
            files_touched = rewrite_image_refs(old_src, new_src)
            summary["images"] += 1
            old_path_abs = SITE / old_src
            if old_path_abs.exists() and old_path_abs.resolve() != new_path.resolve():
                still_used = any(
                    f'src="{old_src}"' in h.read_text(encoding="utf-8")
                    for h in SITE.glob("*.html") if "edit-blossom" not in h.parts
                )
                if not still_used:
                    old_path_abs.unlink()
                    print(f"  ✓ image '{old_src}' → '{new_src}' (pre-uploaded; rewrote {files_touched}, removed old)")
                    continue
            print(f"  ✓ image '{old_src}' → '{new_src}' (pre-uploaded; rewrote {files_touched} file(s))")
            continue
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

    # ── 2b. Image deletes ──────────────────────────────────────────
    # Helen flagged photos to remove (e.g. cloning a template page that
    # had more photos than her new page needs). Strip the matching <img>
    # tags from every HTML file. If the underlying image file is no
    # longer referenced anywhere, unlink it from disk too.
    for del_src in image_deletes:
        files_touched = 0
        total_removed = 0
        for html_path in SITE.glob("*.html"):
            if "edit-blossom" in html_path.parts:
                continue
            soup_d = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
            removed_here = 0
            for img in list(soup_d.find_all("img")):
                src = img.get("src", "")
                if src == del_src or src.endswith("/" + del_src):
                    img.decompose()
                    removed_here += 1
            if removed_here:
                html_path.write_text(str(soup_d), encoding="utf-8")
                files_touched += 1
                total_removed += removed_here
        if total_removed:
            summary["images_deleted"] += total_removed
            print(f"  ✓ photo '{del_src}' removed ({total_removed} occurrence(s) across {files_touched} file(s))")
        # Unlink the file too if it's now orphaned. Only consider srcs
        # that look like real image files (skip placeholder SVG with
        # ?slot= query strings — those resolve to a file used elsewhere).
        clean_src = del_src.split("?")[0]
        src_path = SITE / clean_src
        if src_path.exists() and src_path.is_file():
            still_used = any(
                clean_src in h.read_text(encoding="utf-8")
                for h in SITE.glob("*.html") if "edit-blossom" not in h.parts
            )
            if not still_used and "_add-photo.svg" not in clean_src:
                src_path.unlink()
                print(f"  ✓ unlinked orphan file '{clean_src}'")

    # ── 2c. Nav + homepage cat-grid sync ───────────────────────────
    # Only fires when the editor's draft created at least one new page —
    # otherwise the existing hand-crafted nav and cat-grid are left alone.
    # Runs AFTER image swaps so the cat-card image-lookup sees Helen's
    # latest uploaded photo (not the template's stale one).
    if new_pages:
        nav_changed = sync_navs()
        if nav_changed:
            summary["nav_synced"] = nav_changed
            print(f"  ✓ site nav synced across {nav_changed} HTML file(s)")
        # Reload the registry so we know each new page's final nav metadata
        # (the entry we wrote in section 0). Pass those entries to the
        # cat-grid syncer so the homepage gets matching cards.
        registry_now = json.loads(PAGES_JSON.read_text(encoding="utf-8")) if PAGES_JSON.exists() else {"pages": []}
        new_ids = {np["id"] for np in new_pages}
        new_entries = [p for p in registry_now.get("pages", []) if p.get("id") in new_ids]
        cards_added = sync_cat_grid_for_new_pages(new_entries)
        if cards_added:
            summary["cards_added"] = cards_added
            print(f"  ✓ homepage cat-grid: +{cards_added} card(s)")

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
    print(f"           {summary['images_deleted']} image delete(s)")
    if summary["nav_synced"]:
        print(f"           nav synced across {summary['nav_synced']} file(s)")
    if summary["cards_added"]:
        print(f"           {summary['cards_added']} new card(s) on homepage")
    print(f"           {summary['page_status']} page-status change(s)")
    print(f"           {summary['deleted']} page deletion(s)")
    print(f"           {summary['styles_ok']} per-element style change(s)")
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
