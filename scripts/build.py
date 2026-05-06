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
    'weddings':                        ('weddings.html',                      'Weddings'),
    'handmade-biscuits':               ('handmade-biscuits.html',             'Biscuits'),
    'wedding-cakes':                   ('wedding-cakes.html',                 'For your day'),
    'afternoon-teas':                  ('afternoon-teas.html',                'Catering'),
    'cakes':                           ('cakes.html',                         'All cakes'),
    'childrens-cakes':                 ("childrens-cakes.html",               'Birthdays & celebrations'),
    'cupcakes':                        ('cupcakes.html',                      'Boxes from 6'),
    'ganache-drip-cakes':              ('ganache-drip-cakes.html',            'Modern · glossy'),
    'speciality-and-everyday-cakes':   ('speciality-and-everyday-cakes.html', 'Cakes for any reason'),
    'catering-packages':               ('catering-packages.html',             'Events'),
    'numbered-birthday-cakes':         ('numbered-birthday-cakes.html',       'Big-number birthdays'),
    'buttercream-flower-cakes':        ('buttercream-flower-cakes.html',      'Floral, by hand'),
    'giant-cookies':                   ('giant-cookies.html',                 'Decorated · personalised'),
    'traybakes':                       ('traybakes.html',                     'Catering & sharing'),
    'scones':                          ('scones.html',                        'Classic'),
    'customer-reviews':                ('customer-reviews.html',              'In their own words'),
    'contact':                         ('contact.html',                       'Send a message'),
    'about':                           ('about.html',                         'Meet the baker'),
}

NAV_HTML = '''<nav class="site-nav">
        <ul class="site-nav__list">
          <li><a href="cakes.html"{CAKES_ACTIVE}>Cakes</a></li>
          <li><a href="weddings.html"{WED_ACTIVE}>Weddings</a></li>
          <li><a href="handmade-biscuits.html"{BIS_ACTIVE}>Biscuits</a></li>
          <li><a href="cupcakes.html"{CC_ACTIVE}>Cupcakes</a></li>
          <li><a href="traybakes.html"{TB_ACTIVE}>Tray bakes</a></li>
          <li><a href="afternoon-teas.html"{AT_ACTIVE}>Afternoon tea</a></li>
          <li><a href="customer-reviews.html"{CR_ACTIVE}>Testimonials</a></li>
        </ul>
      </nav>'''

# Map of page filename → active-flag key. Helen's nav is intentionally slim:
# only the 7 items are highlightable. Pages outside the list (giant cookies,
# scones, contact, etc.) still render with the nav, just no highlighted item.
NAV_KEY = {
    'cakes.html':              'CAKES',
    'weddings.html':           'WED',
    'handmade-biscuits.html':  'BIS',
    'cupcakes.html':           'CC',
    'traybakes.html':          'TB',
    'afternoon-teas.html':     'AT',
    'customer-reviews.html':   'CR',
}

def render_nav(active_filename):
    nav = NAV_HTML
    for fn, key in NAV_KEY.items():
        replace = ' class="active"' if fn == active_filename else ''
        nav = nav.replace('{' + key + '_ACTIVE}', replace)
    return nav

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
        © 2026 Blossom Bakery · Helen Victors · Great Baddow, Chelmsford
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
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Lora:wght@400;500;600&display=swap" rel="stylesheet" />
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

def render_page(filename, title, eyebrow, intro, images):
    description = f'{title} from Blossom Bakery in Chelmsford. Homemade by Helen Victors.'
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
