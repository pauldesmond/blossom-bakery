#!/usr/bin/env python3
"""Build static HTML pages from /_pages/*.yml content files.

This is the build step that runs automatically via GitHub Actions
whenever Helen edits content in Decap CMS. Reads /_pages/<slug>.yml
and writes /<slug>.html using the shared template.
"""

import re, html as ihtml, sys, yaml as _y
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = ROOT / '_pages'
IMG_DIR = ROOT / 'images'
OUT = ROOT

# slug → (filename, eyebrow shown above hero title)
PAGE_META = {
    # ---------------------------------------------------------------------
    # Only TWO pages are still auto-generated from _pages/*.yml: about and
    # scones. Everything else has been hand-crafted in the v2 redesign and
    # is edited directly (via the editor → apply-draft pipeline). Adding a
    # slug here MUST be matched by flipping its `generated: true` flag in
    # _data/pages.json AND verifying the YAML's content reflects what's
    # currently on the live HTML, or the next CI build will overwrite it.
    # ---------------------------------------------------------------------
    'about':                           ('about.html',                         'Meet the baker'),
    'scones':                          ('scones.html',                        'Classic'),
}

# ---------------------------------------------------------------------------
# Site nav is built from _data/pages.json — the single source of truth shared
# with the editor and apply-draft.py. To add or rearrange a nav item, edit
# pages.json (no Python changes needed).
#
# Nav model:
#   - A page with nav.topLevel=true appears on the main bar.
#   - Pages sharing nav.section form a dropdown; the topLevel page in that
#     section is the dropdown's parent link AND its first child entry.
#   - A topLevel page with no section is a plain top-level link.
#   - Pages with no nav field (or unpublished) are hidden.
#   - Active highlighting cascades: a child page in a dropdown highlights its
#     parent's top-level item.
# ---------------------------------------------------------------------------

import json as _json

def _load_nav_data():
    """Read pages.json and return list of published pages with nav data."""
    pages_json = ROOT / '_data' / 'pages.json'
    with pages_json.open('r', encoding='utf-8') as f:
        data = _json.load(f)
    return [p for p in data.get('pages', []) if p.get('published') and p.get('nav')]

def _build_nav_tree(pages):
    """Group pages into top-level entries (with optional dropdown children)."""
    sections = {}  # section_key -> { parent, children, sectionLabel, sectionOrder }
    standalone = []  # top-level entries with no section
    for p in pages:
        nav = p['nav']
        section = nav.get('section')
        if section:
            bucket = sections.setdefault(section, {'parent': None, 'children': [], 'sectionLabel': section, 'sectionOrder': 9999})
            bucket['children'].append(p)
            if nav.get('topLevel'):
                bucket['parent'] = p
                bucket['sectionLabel'] = nav.get('sectionLabel', section)
                bucket['sectionOrder'] = nav.get('sectionOrder', 9999)
        elif nav.get('topLevel'):
            standalone.append(p)
    # Sort children within each section by nav.order
    for bucket in sections.values():
        bucket['children'].sort(key=lambda p: p['nav'].get('order', 9999))
    # Build top-level list mixing dropdowns and standalone, sorted by sectionOrder
    top_level = []
    for key, bucket in sections.items():
        if not bucket['parent']:
            # Section with children but no topLevel anchor — skip (misconfigured)
            continue
        top_level.append(('dropdown', bucket))
    for p in standalone:
        top_level.append(('link', p))
    top_level.sort(key=lambda item: (item[1]['nav'].get('sectionOrder', 9999) if item[0] == 'link' else item[1]['sectionOrder']))
    return top_level

def _section_for_filename(pages, filename):
    """Find which section (if any) a given page filename belongs to."""
    for p in pages:
        if p['file'] == filename:
            return p['nav'].get('section')
    return None

_CARET_SVG = '<span class="caret"><svg viewBox="0 0 12 6" fill="none" aria-hidden="true"><path d="M1 1.5c1.5 0 1.5 3 3 3s1.5-3 3-3 1.5 3 3 3 1.5-3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'

_MOBILE_TOGGLE = '<button class="mobile-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="primaryNav"><span></span><span></span><span></span></button>'

def render_nav(active_filename):
    pages = _load_nav_data()
    top_level = _build_nav_tree(pages)
    active_section = _section_for_filename(pages, active_filename)

    # Mobile-toggle button precedes <nav> — the live styles.css and the JS
    # `aria-controls="primaryNav"` wiring both depend on this exact markup.
    out = [_MOBILE_TOGGLE, '      <nav class="site-nav">', '        <ul class="site-nav__list">']
    for kind, item in top_level:
        if kind == 'link':
            href = item['file']
            label = item['nav'].get('label', item['label'])
            cls = ' class="active"' if href == active_filename else ''
            out.append(f'          <li class="site-nav__item"><a href="{ihtml.escape(href)}"{cls}>{ihtml.escape(label)}</a></li>')
        else:  # dropdown
            bucket = item
            parent = bucket['parent']
            section_key = parent['nav'].get('section')
            parent_href = parent['file']
            section_label = bucket['sectionLabel']
            is_active = (section_key and section_key == active_section)
            cls = ' class="active"' if is_active else ''
            out.append('          <li class="site-nav__item has-dropdown">')
            # Caret is the SVG version — styles.css `.site-nav__list .caret svg`
            # styles it specifically; a plain `▾` won't render correctly.
            out.append(f'            <a href="{ihtml.escape(parent_href)}"{cls}>{ihtml.escape(section_label)} {_CARET_SVG}</a>')
            out.append('            <div class="site-dropdown">')
            out.append('              <ul>')
            for child in bucket['children']:
                child_href = child['file']
                child_label = child['nav'].get('label', child['label'])
                child_note = child['nav'].get('note', '')
                note_html = f'<span>{ihtml.escape(child_note)}</span>' if child_note else ''
                out.append(f'                <li><a href="{ihtml.escape(child_href)}"><strong>{ihtml.escape(child_label)}</strong>{note_html}</a></li>')
            out.append('              </ul>')
            out.append('            </div>')
            out.append('          </li>')
    out.append('        </ul>')
    out.append('      </nav>')
    return '\n'.join(out)

FOOTER = '''<footer class="site-footer">
    <div class="container">
      <div class="site-footer__grid">
        <div>
          <h4>Blossom Bakery</h4>
          <p>Homemade cakes and bakes for weddings, celebrations and every-day moments. Based in Great Baddow, Chelmsford, Essex.</p>
        </div>
        <div>
          <h4>Quick links</h4>
          <ul>
            <li><a href="about.html">About Helen</a></li>
            <li><a href="wedding-cakes.html">Wedding Cakes</a></li>
            <li><a href="customer-reviews.html">Customer Reviews</a></li>
            <li><a href="contact.html">Contact</a></li>
          </ul>
        </div>
        <div>
          <h4>Contact</h4>
          <p>blossombakedgoods@gmail.com<br />07939 618787</p>
          <p style="margin-top: 12px;">Monday-Friday 9am-5pm<br />Saturday 9am-2pm</p>
        </div>
      </div>
      <div class="site-footer__bottom">
        © 2026 Blossom Bakery · Helen Desmond · Chelmsford
      </div>
    </div>
  </footer>'''

HEADER_TPL = '''<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} — Blossom Bakery, Chelmsford</title>
  <meta name="description" content="{description}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="https://myblossombakery.co.uk/{filename}" />
  <link rel="icon" type="image/png" href="images/blossom_logo.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://myblossombakery.co.uk/{filename}" />
  <meta property="og:title" content="{title} — Blossom Bakery" />
  <meta property="og:description" content="{description}" />
  <meta property="og:image" content="https://myblossombakery.co.uk/{og_image}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600&family=Lora:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="site-header">
    <div class="container">
      <div class="site-header__inner">
        <a href="index.html" class="site-header__brand">
          <div class="site-header__name">Blossom Bakery</div>
          <div class="site-header__tagline">Chelmsford · Essex</div>
        </a>
        {nav}
        <a href="contact.html" class="btn btn--outline btn--pill">Enquire</a>
      </div>
    </div>
  </header>

  <main>'''

def hero_html(eyebrow, title):
    return f'''<section class="page-hero">
      <div class="container container--narrow">
        <p class="eyebrow">{ihtml.escape(eyebrow)}</p>
        <h1>{ihtml.escape(title)}</h1>
      </div>
    </section>'''

def gallery_html(filenames):
    if not filenames: return ''
    items = '\n          '.join(
        f'<img src="images/{f}" alt="" loading="lazy" />' for f in filenames
    )
    return f'''<section>
      <div class="container">
        <div class="photo-grid">
          {items}
        </div>
      </div>
    </section>'''

CTA = '''<section class="alt">
      <div class="container container--narrow" style="text-align:center;">
        <p class="section-eyebrow">Order yours</p>
        <h2 class="section-title">Let's bake something for you</h2>
        <p style="margin: 24px 0 8px;"><strong>blossombakedgoods@gmail.com</strong></p>
        <p style="color: var(--muted);">Mobile: 07939 618787 · Mon-Fri 9am-5pm · Sat 9am-2pm</p>
        <a href="contact.html" class="btn" style="margin-top: 24px;">Send a message</a>
      </div>
    </section>'''

# Wedding-Cakes-only closer: the v2 'Your dream cake, made stress-free' 4-step
# process panel on a dark ink background. Hard-coded here (not in YAML) so
# Helen can edit the body content via Decap without accidentally breaking the
# styled steps panel.
WEDDING_PROCESS = '''<section class="section-ink">
      <div class="container">
        <div class="section-head">
          <div>
            <p class="section-eyebrow section-eyebrow--rose">For your wedding day</p>
            <h2 class="section-title">Your dream cake,<br/>made <em class="accent-rose">stress-free</em>.</h2>
          </div>
          <div class="section-num">N° 03</div>
        </div>
        <div class="steps">
          <div class="step">
            <div class="step__num">1</div>
            <h3>Tell me your day</h3>
            <p>Send a quick note — date, venue, rough numbers, the look you love. Pinterest boards welcome.</p>
          </div>
          <div class="step">
            <div class="step__num">2</div>
            <h3>We design together</h3>
            <p>I'll come back with sketches, flavours and a clear quote — no surprises, no upsell.</p>
          </div>
          <div class="step">
            <div class="step__num">3</div>
            <h3>Tasting box</h3>
            <p>Pop round (or I can post) for sponges, fillings and a chat about every detail.</p>
          </div>
          <div class="step">
            <div class="step__num">4</div>
            <h3>Delivery &amp; set up</h3>
            <p>I deliver and set up at your venue across Essex and the surrounding counties.</p>
          </div>
        </div>
        <div class="steps-cta">
          <a href="wedding-cakes.html" class="btn btn--rose">Wedding cakes</a>
          <a href="contact.html" class="btn btn--outline btn--outline-light">Start an enquiry</a>
        </div>
      </div>
    </section>'''

def render_page(filename, title, eyebrow, intro, images):
    description = f'{title} from Blossom Bakery in Chelmsford. Homemade by Helen Desmond.'
    og_image = f'images/{images[0]}' if images else 'images/blossom_logo.png'
    head = HEADER_TPL.format(title=title, description=description, filename=filename,
                             og_image=og_image, nav=render_nav(filename))
    blocks = [hero_html(eyebrow, title)]
    if intro and len(intro.strip()) > 30:
        blocks.append(f'''<section>
      <div class="container container--narrow">
        <p style="font-size: 1.05rem; color: var(--ink); line-height: 1.85;">{ihtml.escape(intro)}</p>
      </div>
    </section>''')
    if images:
        blocks.append(gallery_html(images))
    if filename != 'contact.html':
        blocks.append(CTA)
    return f"""{head}
{chr(10).join(blocks)}
  </main>

  {FOOTER}
</body>
</html>
"""

def main():
    built = 0
    for path in sorted(PAGES_DIR.glob('*.yml')):
        slug = path.stem
        if slug not in PAGE_META:
            print(f'  ⚠ unknown slug: {slug}', file=sys.stderr); continue
        filename, eyebrow = PAGE_META[slug]
        with open(path) as f:
            data = _y.safe_load(f)
        title = data.get('title', slug)
        intro = data.get('intro', '')
        images = [i for i in (data.get('images') or []) if (IMG_DIR / i).exists()]
        page = render_page(filename, title, eyebrow, intro, images)
        (OUT / filename).write_text(page)
        built += 1
        print(f'  ✓ {filename:<42} ({len(images)} imgs)')
    print(f'\nBuilt {built} pages.')

if __name__ == '__main__':
    main()
