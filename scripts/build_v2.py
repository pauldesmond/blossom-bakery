#!/usr/bin/env python3
"""Build /v2/ preview pages from /_pages/*.yml content files.

Writes generated category pages into /v2/ alongside the four hand-crafted
pages already in /v2/ (index, wedding-cakes, cupcakes, contact). The live
root site is untouched.

When ready to promote /v2/ to live, copy /v2/* to the repo root and update
OUT in this script back to ROOT.

Reads /_pages/<slug>.yml — same shape Decap CMS already writes:
  title:  <page heading>
  intro:  <body copy>
  images: [<image filename relative to /images>, ...]
"""

import html as ihtml, sys, re, yaml as _y
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = ROOT / '_pages'
IMG_DIR = ROOT / 'images'
OUT = ROOT / 'v2'
OUT.mkdir(exist_ok=True)

# Preview build: writes into /v2/ alongside the live root site.
# The live root pages are NEVER touched by this script.

# slug → (output filename, eyebrow shown above hero title, optional price hint)
PAGE_META = {
    'about':                          ('about.html',                          'Meet the baker'),
    'weddings':                       ('weddings.html',                       'For your day'),
    'handmade-biscuits':              ('handmade-biscuits.html',              'From £2.50'),
    'afternoon-teas':                 ('afternoon-teas.html',                 'Pre-order · 48h notice'),
    'cakes':                          ('cakes.html',                          'All cakes'),
    'childrens-cakes':                ("childrens-cakes.html",                'Birthdays & celebrations'),
    'ganache-drip-cakes':             ('ganache-drip-cakes.html',             'Modern · glossy'),
    'speciality-and-everyday-cakes':  ('speciality-and-everyday-cakes.html',  'Cakes for any reason'),
    'catering-packages':              ('catering-packages.html',              'Events & functions'),
    'numbered-birthday-cakes':        ('numbered-birthday-cakes.html',        'Big-number birthdays'),
    'buttercream-flower-cakes':       ('buttercream-flower-cakes.html',       'From £70'),
    'giant-cookies':                  ('giant-cookies.html',                  'From £30'),
    'traybakes':                      ('traybakes.html',                      'Catering & sharing'),
    'cakesicles':                     ('cakesicles.html',                     'Cake on a stick'),
    'scones':                         ('scones.html',                         'Sweet & savoury'),
    'customer-reviews':               ('customer-reviews.html',               'In their own words'),
}


# ---------- copy clean-up ----------

# Decap CMS often pastes intro copy that includes navigation crumbs from the
# original WordPress source. Strip those before rendering.
INTRO_NOISE = [
    re.compile(r'^[^.]*?\bSkip to content\s*', re.IGNORECASE),
    re.compile(r'\bScreenshot\b', re.IGNORECASE),
    re.compile(r'\bPrivacy\s+Blossom Bakery\b', re.IGNORECASE),
    re.compile(r'^[A-Z][^.]*?–\s*Blossom Bakery\s*', re.IGNORECASE),
]

def clean_intro(text):
    if not text:
        return ''
    out = text
    for r in INTRO_NOISE:
        out = r.sub('', out)
    return re.sub(r'\s+', ' ', out).strip()


def split_paragraphs(text):
    """Split a long intro into 2-3 sensible paragraphs at sentence boundaries."""
    if not text:
        return []
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) <= 3:
        return [text]
    # Aim for paragraphs of 2-3 sentences each.
    chunks, buf = [], []
    target = max(2, len(sentences) // 3)
    for s in sentences:
        buf.append(s)
        if len(buf) >= target:
            chunks.append(' '.join(buf))
            buf = []
    if buf:
        if chunks:
            chunks[-1] += ' ' + ' '.join(buf)
        else:
            chunks.append(' '.join(buf))
    return chunks[:3]


# ---------- gallery layout ----------

# Repeating bento pattern. Length 8 — page wraps if more images.
SPAN_PATTERN = ['span-7 tall', 'span-5 tall', 'span-4', 'span-4', 'span-4',
                'span-6', 'span-6', 'span-12 short']

def gallery_html(filenames):
    if not filenames:
        return ''
    items = []
    for i, f in enumerate(filenames):
        span = SPAN_PATTERN[i % len(SPAN_PATTERN)]
        items.append(
            f'          <div class="cake-card {span}" data-lightbox>'
            f'<div class="photo"><img src="images/{ihtml.escape(f)}" alt="" loading="lazy" /></div></div>'
        )
    return ('<section class="section">\n'
            '      <div class="container">\n'
            '        <div class="cake-grid" data-lightbox-group>\n'
            + '\n'.join(items) + '\n'
            '        </div>\n'
            '      </div>\n'
            '    </section>')


def intro_html(paragraphs):
    if not paragraphs:
        return ''
    p_html = '\n        '.join(
        f'<p style="font-size:18px;line-height:1.7;color:var(--ink-soft);margin-bottom:1.2em;">{ihtml.escape(p)}</p>'
        for p in paragraphs
    )
    return ('<section class="section section--sm">\n'
            '      <div class="container container--narrow">\n'
            f'        {p_html}\n'
            '      </div>\n'
            '    </section>')


CTA_HTML = '''<section class="section ink">
      <div class="container container--narrow" style="text-align:center;">
        <p class="eyebrow" style="color:var(--rose);justify-content:center;">Order yours</p>
        <h2 style="color:var(--paper);">Let's bake<br/><em style="font-style:italic;color:var(--rose);">something good.</em></h2>
        <p style="color:rgba(255,253,251,.75);font-size:17px;margin:24px auto 32px;max-width:520px;">Drop me a message and I'll be back in touch within a day. Replies Mon–Sat.</p>
        <div style="display:flex;justify-content:center;gap:14px;flex-wrap:wrap;">
          <a href="contact.html" class="btn btn--rose">Send a message</a>
          <a href="tel:07939618787" class="btn btn--outline" style="color:var(--paper);border-color:rgba(255,253,251,.4);">07939 618787</a>
        </div>
      </div>
    </section>'''


PAGE_TPL = '''<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} — Blossom Bakery, Chelmsford</title>
  <meta name="description" content="{description}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="https://myblossombakery.com/{filename}" />
  <link rel="icon" type="image/png" href="images/blossom_logo.png" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://myblossombakery.com/{filename}" />
  <meta property="og:title" content="{title} — Blossom Bakery" />
  <meta property="og:description" content="{description}" />
  <meta property="og:image" content="https://myblossombakery.com/{og_image}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..700,30..100;1,9..144,300..700,30..100&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body data-screen-label="{title}">
  <div id="site-header"></div>

  <main>
    <section class="page-hero">
      <div class="container container--narrow">
        <p class="eyebrow" style="justify-content:center;">{eyebrow}</p>
        <h1>{title_html}</h1>
{lede}      </div>
    </section>

    {intro}

    {gallery}

    {cta}
  </main>

  <div id="site-footer"></div>
  <script src="site.js"></script>
  <script>BB.init({{ active: "{filename}" }});</script>
</body>
</html>
'''


def title_html(title):
    """Italicise the last word of the title in rose-deep, for a softer hero."""
    parts = title.rsplit(' ', 1)
    if len(parts) == 2:
        head, tail = parts
        return (f'{ihtml.escape(head)}<br/>'
                f'<em style="color:var(--rose-deep);font-style:italic;">{ihtml.escape(tail)}.</em>')
    return f'<em style="color:var(--rose-deep);font-style:italic;">{ihtml.escape(title)}.</em>'


def lede_html(paragraphs):
    """Use the first sentence as a lede under the hero."""
    if not paragraphs:
        return ''
    first = paragraphs[0]
    sentence = re.split(r'(?<=[.!?])\s+', first, maxsplit=1)[0]
    if len(sentence) < 30 or len(sentence) > 220:
        return ''
    return f'        <p class="lede">{ihtml.escape(sentence)}</p>\n'


def intro_paragraphs_after_lede(paragraphs):
    """If we lifted the first sentence as a lede, drop it from the body intro."""
    if not paragraphs:
        return []
    first = paragraphs[0]
    sentence = re.split(r'(?<=[.!?])\s+', first, maxsplit=1)[0]
    if 30 <= len(sentence) <= 220:
        rest = first[len(sentence):].strip()
        out = ([rest] if rest else []) + paragraphs[1:]
        return [p for p in out if p]
    return paragraphs


def render_page(filename, title, eyebrow, intro, images):
    description = f'{title} from Blossom Bakery in Chelmsford. Homemade by Helen Victors.'
    og_image = f'images/{images[0]}' if images else 'images/blossom_logo.png'
    paragraphs = split_paragraphs(clean_intro(intro))
    lede = lede_html(paragraphs)
    body_paragraphs = intro_paragraphs_after_lede(paragraphs)
    return PAGE_TPL.format(
        title=ihtml.escape(title),
        title_html=title_html(title),
        eyebrow=ihtml.escape(eyebrow),
        description=ihtml.escape(description, quote=True),
        filename=filename,
        og_image=og_image,
        lede=lede,
        intro=intro_html(body_paragraphs),
        gallery=gallery_html(images),
        cta=CTA_HTML,
    )


def main():
    built, skipped = 0, 0
    for path in sorted(PAGES_DIR.glob('*.yml')):
        slug = path.stem
        if slug not in PAGE_META:
            print(f'  ⚠ unknown slug: {slug}', file=sys.stderr)
            continue
        filename, eyebrow = PAGE_META[slug]
        # Skip the four hand-crafted pages already in /v2/.
        if filename in {'index.html', 'wedding-cakes.html', 'cupcakes.html', 'contact.html'}:
            skipped += 1
            print(f'  ◦ {filename:<42} (hand-crafted, skipped)')
            continue
        with open(path) as f:
            data = _y.safe_load(f) or {}
        title = data.get('title', slug)
        intro = data.get('intro', '')
        images = [i for i in (data.get('images') or []) if (IMG_DIR / i).exists()]
        page = render_page(filename, title, eyebrow, intro, images)
        (OUT / filename).write_text(page)
        built += 1
        print(f'  ✓ {filename:<42} ({len(images)} imgs)')
    print(f'\nBuilt {built} pages, skipped {skipped} hand-crafted.')


if __name__ == '__main__':
    main()
