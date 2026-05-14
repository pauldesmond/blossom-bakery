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
          <p>Homemade cakes and bakes for weddings, celebrations and everyday moments. Based in Great Baddow, Chelmsford, Essex.</p>
        </div>
        <div>
          <h4>Quick links</h4>
          <ul class="site-footer__links">
            <li><a href="about.html">About Helen</a></li>
            <li><a href="afternoon-tea.html">Afternoon Tea</a></li>
            <li><a href="handmade-biscuits.html">Bakes</a></li>
            <li><a href="cakes.html">Cakes</a></li>
            <li><a href="contact.html">Contact Us</a></li>
            <li><a href="cupcakes.html">Cupcakes</a></li>
            <li><a href="customer-reviews.html">Testimonials</a></li>
            <li><a href="wedding-cakes.html">Weddings</a></li>
          </ul>
        </div>
        <div>
          <h4>Additional Information</h4>
          <p><a href="mailto:blossombakedgoods@gmail.com">blossombakedgoods@gmail.com</a><br />07939 618787</p>
          <p style="margin-top: 12px;">Monday-Friday 9am-5pm<br />Saturday 9am-12pm</p>
          <p style="margin-top: 12px;"><a href="https://search.google.com/local/reviews?placeid=ChIJzcfuM0jp2EcRucu7NgmACCw" rel="noopener" target="_blank" style="color: var(--gold); font-weight: 600">★ Google reviews</a></p>
          <p style="margin-top: 16px;"><a href="https://ratings.food.gov.uk/business/1100840/blossom-bakery" rel="noopener" target="_blank" aria-label="Food hygiene rating: 5 stars"><img alt="Food hygiene rating: 5 stars" loading="lazy" src="images/5-star-food-hygiene.svg" width="160" height="79" style="display: block; max-width: 160px;" /></a></p>
        </div>
      </div>
      <div class="site-footer__bottom">
        © 2026 Blossom Bakery · Helen Desmond · Chelmsford
      </div>
      <div class="site-footer__bottom" style="margin-top: 6px; opacity: 0.55;">
        Under the same roof: <a href="https://pintpoint.co.uk" rel="noopener" target="_blank" style="color: inherit; text-decoration: underline">PINtPOINT</a> Pub Finder
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
  <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://myblossombakery.co.uk/{filename}" />
  <meta property="og:title" content="{title} — Blossom Bakery" />
  <meta property="og:description" content="{description}" />
  <meta property="og:image" content="https://myblossombakery.co.uk/{og_image}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600&family=Lora:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@type": "Bakery",
    "@id": "https://myblossombakery.co.uk/#bakery",
    "name": "Blossom Bakery",
    "alternateName": "Blossom Bakery Chelmsford",
    "description": "Bespoke wedding cakes, celebration cakes, cupcakes, hand-iced biscuits, tray bakes and afternoon teas — handmade by Helen Desmond in Great Baddow, Chelmsford. Gluten-free, dairy-free and vegan options available.",
    "url": "https://myblossombakery.co.uk/",
    "image": "https://myblossombakery.co.uk/images/helen-portrait.webp",
    "logo": "https://myblossombakery.co.uk/images/blossom_logo.png",
    "telephone": "+44 7939 618787",
    "email": "blossombakedgoods@gmail.com",
    "address": {{ "@type": "PostalAddress", "addressLocality": "Great Baddow, Chelmsford", "addressRegion": "Essex", "postalCode": "CM2", "addressCountry": "GB" }},
    "geo": {{ "@type": "GeoCoordinates", "latitude": 51.7138, "longitude": 0.4994 }},
    "areaServed": [{{ "@type": "City", "name": "Chelmsford" }}, {{ "@type": "AdministrativeArea", "name": "Essex" }}],
    "priceRange": "££",
    "founder": {{ "@type": "Person", "@id": "https://myblossombakery.co.uk/about.html#helen", "name": "Helen Desmond", "jobTitle": "Founder & Baker", "image": "https://myblossombakery.co.uk/images/helen-portrait.webp" }},
    "sameAs": ["https://www.instagram.com/blossombakedgoods/", "https://www.facebook.com/blossombakedgoods", "https://www.google.com/maps/place/?q=place_id:ChIJzcfuM0jp2EcRucu7NgmACCw"],
    "aggregateRating": {{ "@type": "AggregateRating", "ratingValue": "5.0", "reviewCount": "60", "bestRating": "5", "worstRating": "1" }}
  }}
  </script>
  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://myblossombakery.co.uk/#website",
    "url": "https://myblossombakery.co.uk/",
    "name": "Blossom Bakery",
    "publisher": {{ "@id": "https://myblossombakery.co.uk/#bakery" }}
  }}
  </script>{page_schema}
  <script src="blossom-analytics.js" defer></script>
</head>
<body>
  <a href="#main" class="skip-link">Skip to content</a>
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

  <main id="main">'''

# Per-page schema injected by render_page. Empty by default; about/scones
# get a richer block (Person for Helen on /about, Service on /scones).
PAGE_SCHEMA_TPL = {
    'about': '''
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": "https://myblossombakery.co.uk/about.html#profile",
    "mainEntity": {
      "@type": "Person",
      "@id": "https://myblossombakery.co.uk/about.html#helen",
      "name": "Helen Desmond",
      "jobTitle": "Founder & Baker",
      "worksFor": { "@id": "https://myblossombakery.co.uk/#bakery" },
      "image": "https://myblossombakery.co.uk/images/helen-portrait.webp",
      "sameAs": ["https://www.instagram.com/blossombakedgoods/", "https://www.facebook.com/blossombakedgoods", "https://www.google.com/maps/place/?q=place_id:ChIJzcfuM0jp2EcRucu7NgmACCw"],
      "description": "Helen Desmond is the founder and baker behind Blossom Bakery in Great Baddow, Chelmsford. Specialises in bespoke wedding cakes, celebration cakes, hand-iced biscuits, cupcakes, tray bakes and afternoon teas, with gluten-free, dairy-free and vegan options available."
    }
  }
  </script>''',
}

# Block-level tags from the rich-text allow-list. When intro markup
# contains any of these we can't put it inside a <p>, because that
# produces invalid <p><ul>…</p> structures the browser then reparses
# unpredictably (dropping or splitting the <p>).
_BLOCK_TAGS_RE = re.compile(
    r'</?(?:ul|ol|li|table|thead|tbody|tr|th|td)\b[^>]*>',
    re.IGNORECASE,
)


def _intro_has_block(intro: str) -> bool:
    return bool(intro and _BLOCK_TAGS_RE.search(intro))


def hero_html(eyebrow, title):
    # Title can carry inline rich text (b/i/u/strong/em/u/span/br). The
    # sanitiser strips anything else and HTML-escapes plain text, so the
    # output is always safe to embed raw inside <h1>. Without this a
    # rich-text title edit (Helen taps Bold) would render as literal
    # &lt;strong&gt; on next rebuild.
    return f'''<section class="page-hero">
      <div class="container container--narrow">
        <p class="eyebrow">{ihtml.escape(eyebrow)}</p>
        <h1>{_sanitise_intro(title)}</h1>
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
        <p style="margin: 24px 0 8px;"><strong><a href="mailto:blossombakedgoods@gmail.com">blossombakedgoods@gmail.com</a></strong></p>
        <p style="color: var(--muted);">Mobile: 07939 618787 · Mon-Fri 9am-5pm · Sat 9am-12pm</p>
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

_INLINE_TAGS_RE = re.compile(
    r'</?(?:b|strong|i|em|u|br|span|ul|ol|li|table|thead|tbody|tr|th|td)\b[^>]*>',
    re.IGNORECASE,
)


def _sanitise_intro(intro: str) -> str:
    """If `intro` contains any of the editor's allowed inline tags, parse
    it, drop anything else, return the safe HTML to embed raw. Otherwise
    return html-escaped plain text (legacy behaviour).

    This bridges the rich-text editor flow (apply-draft.py writes the
    full HTML fragment into the YAML mirror for about / scones) and
    build.py's render — without this, Cmd-B / Cmd-I edits to those
    generated pages would render as literal `&lt;strong&gt;` text on
    next build.
    """
    if not intro or not _INLINE_TAGS_RE.search(intro):
        return ihtml.escape(intro or '')
    # Match the apply-draft.py allow-list exactly. Anything else gets
    # unwrapped; every attribute except colspan on th/td gets stripped.
    from bs4 import BeautifulSoup as _BS
    allowed = {'b', 'strong', 'i', 'em', 'u', 'br', 'span',
               'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td'}
    frag = _BS(intro, 'html.parser')
    for tag in list(frag.find_all(True)):
        if tag.name not in allowed:
            tag.unwrap()
            continue
        for attr in list(tag.attrs):
            if not (tag.name in ('td', 'th') and attr == 'colspan'):
                del tag.attrs[attr]
    return frag.decode()


def render_page(filename, title, eyebrow, intro, images):
    description = f'{title} from Blossom Bakery in Chelmsford. Homemade by Helen Desmond.'
    og_image = f'images/{images[0]}' if images else 'images/blossom_logo.png'
    slug = filename.replace('.html', '')
    page_schema = PAGE_SCHEMA_TPL.get(slug, '')
    head = HEADER_TPL.format(title=title, description=description, filename=filename,
                             og_image=og_image, nav=render_nav(filename),
                             page_schema=page_schema)
    blocks = [hero_html(eyebrow, title)]
    if intro and len(intro.strip()) > 30:
        body = _sanitise_intro(intro)
        # If the intro is plain text or just inline tags, wrap in a <p>
        # (legacy shape). If it contains block-level rich-text tags
        # (<ul>/<table>/<li>/etc), DON'T wrap — putting a block element
        # inside <p> is invalid and the browser will reparse it,
        # splitting or dropping the paragraph. Render the sanitised
        # block content directly with a class that carries the same
        # font-size/line-height the <p> would have given it.
        if _intro_has_block(intro):
            blocks.append(f'''<section>
      <div class="container container--narrow">
        <div class="prose-intro">{body}</div>
      </div>
    </section>''')
        else:
            # Split on blank lines so paragraph breaks in the YAML
            # actually become separate <p> tags. Otherwise the whole
            # intro renders as one wall of text and the \n\n inside
            # is collapsed to whitespace by HTML.
            paragraphs = [p.strip() for p in body.split('\n\n') if p.strip()]
            ps = '\n        '.join(f'<p class="intro-p">{p}</p>' for p in paragraphs)
            blocks.append(f'''<section>
      <div class="container container--narrow">
        {ps}
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
  <script>
  (function(){{
    document.addEventListener('DOMContentLoaded', function() {{
      var toggle = document.querySelector('.mobile-toggle');
      var nav = document.querySelector('.site-nav');
      if (toggle && nav) {{
        nav.id = nav.id || 'primaryNav';
        toggle.addEventListener('click', function() {{
          var open = nav.classList.toggle('is-open');
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }});
      }}
      document.querySelectorAll('.site-nav__item.has-dropdown > a').forEach(function(a) {{
        a.addEventListener('click', function(e) {{
          if (window.innerWidth <= 880) {{
            e.preventDefault();
            var li = a.parentElement;
            var wasOpen = li.classList.contains('is-open');
            document.querySelectorAll('.site-nav__item.has-dropdown.is-open').forEach(function(o){{
              o.classList.remove('is-open');
            }});
            if (!wasOpen) li.classList.add('is-open');
          }}
        }});
      }});
    }});
  }})();
  </script>
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
