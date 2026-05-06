// Shared header, nav (mega menu), footer, lightbox, density/dark tweaks
(function () {
  const NAV = [
    {
      label: "Cakes",
      items: [
        { href: "wedding-cakes.html", title: "Wedding Cakes", note: "For your day" },
        { href: "cakes.html", title: "Speciality Cakes", note: "All occasions" },
        { href: "ganache-drip-cakes.html", title: "Ganache Drip", note: "Modern · glossy" },
        { href: "buttercream-flower-cakes.html", title: "Buttercream Flower", note: "Floral, by hand" },
        { href: "numbered-birthday-cakes.html", title: "Numbered Birthday", note: "Big-number" },
        { href: "childrens-cakes.html", title: "Children's Cakes", note: "Birthdays" },
      ],
    },
    {
      label: "Bakes",
      items: [
        { href: "cupcakes.html", title: "Cupcakes", note: "Boxes from 6" },
        { href: "handmade-biscuits.html", title: "Handmade Biscuits", note: "All-butter" },
        { href: "giant-cookies.html", title: "Giant Cookies", note: "Personalised" },
        { href: "scones.html", title: "Scones", note: "Sweet & savoury" },
        { href: "traybakes.html", title: "Traybakes", note: "Catering & sharing" },
        { href: "cakesicles.html", title: "Cakesicles", note: "Cake on a stick" },
      ],
    },
    {
      label: "Weddings",
      items: [
        { href: "wedding-cakes.html", title: "Wedding Cakes", note: "Bespoke design" },
        { href: "weddings.html", title: "Wedding Bakes", note: "Favours & dessert tables" },
      ],
    },
    {
      label: "Catering",
      items: [
        { href: "afternoon-teas.html", title: "Afternoon Teas", note: "Pre-order" },
        { href: "catering-packages.html", title: "Catering Packages", note: "Events" },
      ],
    },
    { label: "About", href: "about.html" },
    { label: "Reviews", href: "customer-reviews.html" },
  ];

  const FEATURE = {
    Cakes: { img: "images/wedding-cake-pearl-cascade.jpg", title: "The Pearl Cascade", eyebrow: "Featured" },
    Bakes: { img: "images/cupcake-d34e.jpeg", title: "'Oh Baby' Cupcakes", eyebrow: "Featured" },
    Weddings: { img: "images/wedding-cake-pink-garden-roses.jpg", title: "Garden Roses, hand-pressed", eyebrow: "Recently baked" },
    Catering: { img: "images/afternoon-tea.jpeg", title: "Afternoon tea tower", eyebrow: "Most loved" },
  };

  function renderHeader(active) {
    const navLinks = NAV.map((n) => {
      const isActive = active && (n.href === active || (n.items && n.items.some((i) => i.href === active)));
      if (n.items) {
        return `<button class="site-nav__link${isActive ? " active" : ""}" data-mega="${n.label}" type="button">${n.label}<svg viewBox="0 0 8 5" fill="none"><path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
      }
      return `<a class="site-nav__link${isActive ? " active" : ""}" href="${n.href}">${n.label}</a>`;
    }).join("");

    const megas = NAV.filter((n) => n.items)
      .map((n) => {
        const f = FEATURE[n.label];
        const cols = n.items
          .map(
            (i) =>
              `<li><a href="${i.href}"><div>${i.title}</div><small style="display:block;font-family:var(--sans);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--muted);margin-top:2px;font-style:normal;">${i.note}</small></a></li>`
          )
          .join("");
        return `<div class="mega" data-mega-panel="${n.label}">
          <div class="container">
            <div class="mega__inner">
              <div class="mega__col" style="grid-column: span 2;">
                <h4>${n.label}</h4>
                <ul style="columns: 2; column-gap: 32px;">${cols}</ul>
              </div>
              <div class="mega__col">
                <h4>Quick</h4>
                <ul>
                  <li><a href="contact.html">Send a message</a></li>
                  <li><a href="customer-reviews.html">Customer reviews</a></li>
                  <li><a href="about.html">About Helen</a></li>
                </ul>
              </div>
              <div class="mega__feature">
                <img src="${f.img}" alt="" />
                <div class="mega__feature-cap"><small>${f.eyebrow}</small><div>${f.title}</div></div>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");

    return `<header class="site-header">
      <div class="container">
        <div class="site-header__inner">
          <a href="index.html" class="site-header__logo">
            <img src="images/blossom_logo_transparent.png" alt="Blossom Bakery" />
            <div>
              <div class="site-header__tagline">Chelmsford · Essex</div>
            </div>
          </a>
          <nav class="site-nav">${navLinks}<a class="site-nav__cta" href="contact.html">Enquire</a></nav>
          <button class="btn btn--outline" id="mobileNavBtn" style="display:none;padding:10px 16px;font-size:12px;">Menu</button>
        </div>
      </div>
      ${megas}
    </header>`;
  }

  function renderFooter() {
    return `<footer class="site-footer">
      <div class="container">
        <div class="site-footer__brand">Blossom Bakery</div>
        <p style="max-width:520px;margin:-6px 0 30px;color:rgba(255,253,251,.65);">Homemade cakes &amp; bakes for weddings, celebrations, and the small everyday moments that deserve something a little sweeter.</p>
        <div class="site-footer__grid">
          <div>
            <h4>Visit</h4>
            <p>42 Greenland Gardens<br/>Great Baddow, Chelmsford<br/>Essex CM2 8ZF</p>
            <p style="margin-top:14px;"><strong style="color:var(--paper);">07939 618787</strong><br/>blossombakedgoods@gmail.com</p>
          </div>
          <div>
            <h4>Hours</h4>
            <ul><li>Mon – Fri · 9–5</li><li>Saturday · 9–2</li><li>Sunday · closed</li></ul>
          </div>
          <div>
            <h4>Cakes</h4>
            <ul>
              <li><a href="wedding-cakes.html">Wedding</a></li>
              <li><a href="cupcakes.html">Cupcakes</a></li>
              <li><a href="ganache-drip-cakes.html">Drip cakes</a></li>
              <li><a href="buttercream-flower-cakes.html">Buttercream</a></li>
            </ul>
          </div>
          <div>
            <h4>Studio</h4>
            <ul>
              <li><a href="about.html">About Helen</a></li>
              <li><a href="customer-reviews.html">Reviews</a></li>
              <li><a href="contact.html">Enquire</a></li>
            </ul>
          </div>
        </div>
        <div class="site-footer__petals">blossom.</div>
        <div class="site-footer__bottom">
          <span>© 2026 Blossom Bakery · Helen Victors</span>
          <span>5★ Hygiene · Free-range eggs · Locally sourced</span>
        </div>
      </div>
    </footer>`;
  }

  function wireMega() {
    const triggers = document.querySelectorAll("[data-mega]");
    const panels = document.querySelectorAll("[data-mega-panel]");
    let openName = null;
    let timeout;

    function close() {
      panels.forEach((p) => p.classList.remove("open"));
      triggers.forEach((t) => t.classList.remove("active"));
      openName = null;
    }
    function open(name) {
      panels.forEach((p) => p.classList.toggle("open", p.dataset.megaPanel === name));
      triggers.forEach((t) => t.classList.toggle("active", t.dataset.mega === name));
      openName = name;
    }

    triggers.forEach((t) => {
      t.addEventListener("mouseenter", () => { clearTimeout(timeout); open(t.dataset.mega); });
      t.addEventListener("focus", () => open(t.dataset.mega));
      t.addEventListener("click", (e) => { e.preventDefault(); openName === t.dataset.mega ? close() : open(t.dataset.mega); });
    });
    panels.forEach((p) => {
      p.addEventListener("mouseenter", () => clearTimeout(timeout));
      p.addEventListener("mouseleave", () => { timeout = setTimeout(close, 120); });
    });
    document.querySelector(".site-header")?.addEventListener("mouseleave", () => { timeout = setTimeout(close, 120); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  // Lightbox
  function wireLightbox() {
    let lb = document.getElementById("lb");
    if (!lb) {
      lb = document.createElement("div");
      lb.id = "lb";
      lb.className = "lb";
      lb.innerHTML = `
        <button class="lb__close" aria-label="Close">✕</button>
        <button class="lb__nav prev" aria-label="Previous">‹</button>
        <button class="lb__nav next" aria-label="Next">›</button>
        <div class="lb__inner"><img alt=""/><div class="lb__cap"></div></div>`;
      document.body.appendChild(lb);
    }
    const img = lb.querySelector("img");
    const cap = lb.querySelector(".lb__cap");
    let group = [];
    let i = 0;
    function show(idx) {
      i = (idx + group.length) % group.length;
      const item = group[i];
      img.src = item.src;
      cap.textContent = item.cap || "";
    }
    function open(triggers, idx) {
      group = Array.from(triggers).map((t) => ({ src: t.dataset.full || t.querySelector("img")?.src || t.src, cap: t.dataset.cap || t.alt || "" }));
      show(idx);
      lb.classList.add("open");
      document.body.style.overflow = "hidden";
    }
    function close() { lb.classList.remove("open"); document.body.style.overflow = ""; }
    lb.querySelector(".lb__close").addEventListener("click", close);
    lb.querySelector(".prev").addEventListener("click", () => show(i - 1));
    lb.querySelector(".next").addEventListener("click", () => show(i + 1));
    lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
    document.addEventListener("keydown", (e) => {
      if (!lb.classList.contains("open")) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") show(i - 1);
      if (e.key === "ArrowRight") show(i + 1);
    });

    document.querySelectorAll("[data-lightbox-group]").forEach((group) => {
      const triggers = group.querySelectorAll("[data-lightbox]");
      triggers.forEach((t, idx) => {
        t.style.cursor = "zoom-in";
        t.addEventListener("click", (e) => { e.preventDefault(); open(triggers, idx); });
      });
    });
  }

  function applyTweaks(t) {
    document.documentElement.dataset.theme = t.dark ? "dark" : "";
    document.documentElement.dataset.density = t.density;
  }

  function wireTweaksPanel() {
    // host protocol
    const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
      "density": "airy",
      "dark": false
    }/*EDITMODE-END*/;
    let state = { ...TWEAK_DEFAULTS };
    applyTweaks(state);

    // simple custom panel rather than React (we don't load babel on these pages)
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:120;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:var(--shadow);font-family:var(--sans);min-width:220px;display:none;";
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <strong style="font-family:var(--serif);font-style:italic;font-size:18px;">Tweaks</strong>
        <button id="twClose" style="background:none;border:0;font-size:18px;cursor:pointer;color:var(--muted);">×</button>
      </div>
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Density</div>
        <div id="twDensity" style="display:flex;gap:6px;">
          <button data-v="airy" style="flex:1;padding:8px;border:1px solid var(--line);background:var(--bg);border-radius:8px;cursor:pointer;font-size:12px;">Airy</button>
          <button data-v="compact" style="flex:1;padding:8px;border:1px solid var(--line);background:var(--bg);border-radius:8px;cursor:pointer;font-size:12px;">Compact</button>
        </div>
      </div>
      <div>
        <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Mode</div>
        <div id="twMode" style="display:flex;gap:6px;">
          <button data-v="false" style="flex:1;padding:8px;border:1px solid var(--line);background:var(--bg);border-radius:8px;cursor:pointer;font-size:12px;">Light</button>
          <button data-v="true" style="flex:1;padding:8px;border:1px solid var(--line);background:var(--bg);border-radius:8px;cursor:pointer;font-size:12px;">Dark</button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    function refresh() {
      panel.querySelectorAll("#twDensity button").forEach((b) => b.style.background = b.dataset.v === state.density ? "var(--ink)" : "var(--bg)");
      panel.querySelectorAll("#twDensity button").forEach((b) => b.style.color = b.dataset.v === state.density ? "var(--paper)" : "var(--ink)");
      panel.querySelectorAll("#twMode button").forEach((b) => b.style.background = String(state.dark) === b.dataset.v ? "var(--ink)" : "var(--bg)");
      panel.querySelectorAll("#twMode button").forEach((b) => b.style.color = String(state.dark) === b.dataset.v ? "var(--paper)" : "var(--ink)");
    }
    refresh();

    panel.querySelectorAll("#twDensity button").forEach((b) => {
      b.addEventListener("click", () => { state.density = b.dataset.v; applyTweaks(state); refresh(); persist(); });
    });
    panel.querySelectorAll("#twMode button").forEach((b) => {
      b.addEventListener("click", () => { state.dark = b.dataset.v === "true"; applyTweaks(state); refresh(); persist(); });
    });

    function persist() {
      window.parent.postMessage({ type: "__edit_mode_set_keys", edits: state }, "*");
    }
    function show() { panel.style.display = "block"; }
    function hide() { panel.style.display = "none"; window.parent.postMessage({ type: "__edit_mode_dismissed" }, "*"); }
    panel.querySelector("#twClose").addEventListener("click", hide);

    window.addEventListener("message", (e) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "__activate_edit_mode") show();
      if (e.data.type === "__deactivate_edit_mode") hide();
    });
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
  }

  window.BB = {
    init({ active } = {}) {
      const headerHost = document.getElementById("site-header");
      const footerHost = document.getElementById("site-footer");
      if (headerHost) headerHost.outerHTML = renderHeader(active);
      if (footerHost) footerHost.outerHTML = renderFooter();
      wireMega();
      wireLightbox();
      wireTweaksPanel();
    },
  };
})();
