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
    # 'weddings' removed — weddings.html is now a 301 stub redirecting to
    # wedding-bakes.html. Both wedding-cakes.html and wedding-bakes.html are
    # hand-crafted (multi-section, with price tables) — not auto-built.
# 'wedding-cakes' removed from PAGE_META — page is hand-crafted (matches the WP
# weddings-4 multi-section layout with interleaved photo blocks + the v2 'stress-
# free' panel). Helen edits it via direct collaboration with Paul, not via Decap.
    # 'afternoon-teas' removed — afternoon-tea.html is now hand-crafted as a
    # menu of cards (one per tea offering, with price + photo). The old
    # afternoon-teas.html URL is a meta-refresh redirect.
    'scones':                          ('scones.html',                        'Classic'),
    'customer-reviews':                ('customer-reviews.html',              'In their own words'),
    'about':                           ('about.html',                         'Meet the baker'),
}

NAV_HTML = '''<button class="mobile-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="primaryNav"><span></span><span></span><span></span></button>
      <nav class="site-nav">
        <ul class="site-nav__list">
          <li class="site-nav__item has-dropdown">
            <a href="cakes.html"{CAKES_ACTIVE}>Cakes <span class="caret"><svg viewBox="0 0 12 6" fill="none" aria-hidden="true"><path d="M1 1.5c1.5 0 1.5 3 3 3s1.5-3 3-3 1.5 3 3 3 1.5-3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a>
            <div class="site-dropdown">
              <ul>
                <li><a href="cakes.html"><strong>All Cakes</strong><span>Browse the gallery</span></a></li>
                <li><a href="ganache-drip-cakes.html"><strong>Drip Cakes</strong><span>Modern · glossy</span></a></li>
                <li><a href="numbered-birthday-cakes.html"><strong>Numbered Birthday</strong><span>Big-number</span></a></li>
                <li><a href="childrens-cakes.html"><strong>Children's Cakes</strong><span>Birthdays</span></a></li>
                <li><a href="speciality-and-everyday-cakes.html"><strong>Speciality Cakes</strong><span>Every occasion</span></a></li>
              </ul>
            </div>
          </li>
          <li class="site-nav__item has-dropdown">
            <a href="weddings.html"{WED_ACTIVE}>Weddings <span class="caret"><svg viewBox="0 0 12 6" fill="none" aria-hidden="true"><path d="M1 1.5c1.5 0 1.5 3 3 3s1.5-3 3-3 1.5 3 3 3 1.5-3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a>
            <div class="site-dropdown">
              <ul>
                <li><a href="wedding-cakes.html"><strong>Wedding Cakes</strong><span>For your day</span></a></li>
                <li><a href="wedding-bakes.html"><strong>Wedding Bakes</strong><span>Favours &amp; dessert tables</span></a></li>
              </ul>
            </div>
          </li>
          <li class="site-nav__item has-dropdown">
            <a href="handmade-biscuits.html"{BAKES_ACTIVE}>Bakes <span class="caret"><svg viewBox="0 0 12 6" fill="none" aria-hidden="true"><path d="M1 1.5c1.5 0 1.5 3 3 3s1.5-3 3-3 1.5 3 3 3 1.5-3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a>
            <div class="site-dropdown">
              <ul>
                <li><a href="handmade-biscuits.html"><strong>Biscuits</strong><span>All-butter, hand-iced</span></a></li>
                <li><a href="traybakes.html"><strong>Tray bakes</strong><span>Catering &amp; sharing</span></a></li>
              </ul>
            </div>
          </li>
          <li class="site-nav__item"><a href="cupcakes.html"{CC_ACTIVE}>Cupcakes</a></li>
          <li class="site-nav__item"><a href="afternoon-tea.html"{AT_ACTIVE}>Afternoon tea</a></li>
          <li class="site-nav__item"><a href="customer-reviews.html"{CR_ACTIVE}>Testimonials</a></li>
        </ul>
      </nav>'''

# Map of page filename → active-flag key. Helen's nav is intentionally slim:
# only the 7 top-level items are highlightable. Pages reached via dropdown
# sub-links (drip cakes, children's cakes, wedding cakes, etc.) inherit the
# parent's active state at runtime via CSS — no separate flag needed.
NAV_KEY = {
    'cakes.html':              'CAKES',
    'wedding-cakes.html':      'WED',  # Wedding Cakes sub-item — highlight the Weddings parent
    'wedding-bakes.html':      'WED',  # Wedding Bakes sub-item — highlight the Weddings parent
    'handmade-biscuits.html':  'BAKES',  # Biscuits sub-item lives in Bakes dropdown — highlight the parent
    'traybakes.html':          'BAKES',  # Tray bakes sub-item lives in Bakes dropdown — highlight the parent
    'cupcakes.html':           'CC',
    'afternoon-tea.html':      'AT',  # singular URL after rename from afternoon-teas.html
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
