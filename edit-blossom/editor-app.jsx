// Blossom Editor — WYSIWYG editor for Helen
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ──────────────────────────────────────────────────────────────────
// Page registry — fetched from canonical source at /_data/pages.json
// (the SAME file scripts/apply-draft.py reads, so the two can never drift).
// Synchronously injected via <script> in editor.html before this file runs.
// ──────────────────────────────────────────────────────────────────
const PAGES = (window.__BLOSSOM_PAGES__ || []).map(p => ({
  id: p.id, file: p.file, label: p.label, published: p.published !== false,
}));
if (!PAGES.length) {
  console.error('Blossom editor: page registry missing — _data/pages.json failed to load.');
}

const STORAGE_KEY = 'blossom-editor-draft-v1';
const PASSWORD_KEY = 'blossom-publish-password';
const PUBLISHES_KEY = 'blossom-recent-publishes';
// Editor lives at /edit-blossom/editor.html; the live site is one level up
// so iframe srcs need '../' to escape the editor folder.
const BASE_PATH = '../';

// publish-draft Supabase edge function — broker that triggers the
// apply-helen-draft GitHub Actions workflow. Replace the URL after deploy.
const PUBLISH_ENDPOINT = 'https://rvokskoevmcekkgiglpa.supabase.co/functions/v1/publish-draft';

// ──────────────────────────────────────────────────────────────────
// Per-element text colour palette — brand-locked. Pops up in the
// inspector when text is selected; persisted as
// draft.styles[pageId][selector] = { color: '#hex' }. Kept short on
// purpose so Helen can't drift into a 50-shade rainbow page.
// Mirror this list in scripts/apply-draft.py ALLOWED_TEXT_COLOURS.
// ──────────────────────────────────────────────────────────────────
const TEXT_COLOURS = [
  { id: 'default',   label: 'Default',   value: null },        // remove override
  { id: 'rose',      label: 'Blush',     value: '#d89396' },
  { id: 'rose-dark', label: 'Deep rose', value: '#b8676a' },
  { id: 'sage',      label: 'Sage',      value: '#9bb098' },
  { id: 'ink-soft',  label: 'Soft ink',  value: '#4a423a' },
  { id: 'muted',     label: 'Muted',     value: '#7a7068' },
];

// Per-element font-size palette. Values should match the sizes used in
// styles.css. Mirror in apply-draft.py ALLOWED_FONT_SIZES.
const TEXT_SIZES = [
  { id: 'default', label: 'Default', value: null,    preview: 16 },
  { id: 'sm',      label: 'Small',   value: '14px',  preview: 12 },
  { id: 'md',      label: 'Body',    value: '17px',  preview: 15 },
  { id: 'lg',      label: 'Subhead', value: '28px',  preview: 18 },
  { id: 'xl',      label: 'Heading', value: '48px',  preview: 22 },
  { id: 'xxl',     label: 'Display', value: '80px',  preview: 26 },
];

// Per-element text alignment. Mirror in apply-draft.py ALLOWED_TEXT_ALIGNS.
const TEXT_ALIGNS = [
  { id: 'default', label: 'Default', value: null,     icon: '↺' },
  { id: 'left',    label: 'Left',    value: 'left',   icon: '⬅' },
  { id: 'center',  label: 'Center',  value: 'center', icon: '↔' },
  { id: 'right',   label: 'Right',   value: 'right',  icon: '➡' },
];

// CSS injected into the iframe so editing UI is unambiguous.
// The live site's chrome is already well-proportioned — leave it alone.
const IFRAME_CSS = `
  /* Soften any hover transitions that fight the editor's outline */
  *:focus-within { outline: none !important; }
  /* Make sure long content can scroll without clipping inside the editor stage */
  html, body { overflow-x: hidden; }
  /* Reveal "Tap to add photo" placeholder slots — production CSS hides
     these so the public never sees them, but inside the editor Helen
     needs to see and click them. Once she swaps a placeholder for a
     real photo, the src changes and this rule no longer applies.
     Covers both gallery placeholders and in-prose ones. */
  img[src*="_add-photo.svg"] { display: block !important; }
`;

// ──────────────────────────────────────────────────────────────────
// Draft store — localStorage persistence
// ──────────────────────────────────────────────────────────────────
function loadDraft() {
  const blank = { edits: {}, images: {}, imageDeletes: [], pageStatus: {}, site: {}, newPages: [], styles: {} };
  try { return { ...blank, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) }; }
  catch { return blank; }
}
function saveDraft(d) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
  catch (e) {
    // Quota exceeded (e.g. accumulated photo data URLs). Don't let it
    // propagate into the render loop and blank the editor.
    console.warn('[Blossom] draft save failed:', e?.message || e);
  }
}

// ──────────────────────────────────────────────────────────────────
// Inject editor logic into the iframe
// ──────────────────────────────────────────────────────────────────
const IFRAME_INJECT = `
(function(){
  // Compute a stable selector for an element
  function pathFor(el) {
    if (!el || el === document.body) return 'body';
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  const SELECTORS = 'h1, h2, h3, h4, p, li, span:not(:has(*)), a:not(:has(img)), small, em, strong, button, blockquote, div:not(:has(*))';

  function isEditable(el) {
    if (!el || el.closest('[data-edit-skip]')) return false;
    // Don't allow editing structural chrome — header, footer, nav, dropdowns, lightboxes
    if (el.closest('header.site-header, footer.site-footer, .site-dropdown, .mega, .lb, nav, [data-mega], [data-mega-panel]')) return false;
    // Refuse compound elements (with child elements). apply-draft replaces
    // their entire inner content with plain text — wiping any inner <br>,
    // <em>, <span class="..."> formatting. e.g. an h1 like
    //   "Beautiful bakes,<br><em>baked at home</em>"
    // would collapse to one line, single colour. Helen edits the inner
    // <em> directly instead; the wrapping h1 stays as-is.
    // Exception: <br> children are fine — they're how multi-line edits land
    // in the DOM, and the live-update path can losslessly rewrite them.
    // Exception 2: EMPTY inner elements are fine too — e.g. <em></em>
    // residue left after Helen deleted the styled second line. There's
    // nothing to lose, and the next save will quietly drop the empty tag.
    const kids = Array.from(el.children);
    if (kids.some(c => c.tagName !== 'BR' && c.textContent.trim() !== '')) return false;
    return el.matches(SELECTORS);
  }

  // Render a string with \\n line breaks into an element as text nodes
  // interleaved with <br> elements. Safe (no HTML parsing).
  function renderText(el, text) {
    el.textContent = '';
    const parts = String(text).split('\\n');
    parts.forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
  }
  // Read the element's text with \\n where <br> elements appear. Inverse
  // of renderText. Plain textContent strips <br> entirely (would lose
  // multi-line edits on round-trip), so we walk children manually.
  function textWithBreaks(el) {
    let out = '';
    el.childNodes.forEach(node => {
      if (node.nodeType === 3) out += node.textContent;
      else if (node.tagName === 'BR') out += '\\n';
      else if (node.tagName === 'DIV') {
        // Safari's contentEditable wraps Enter in <div>. Treat as line break.
        if (out && !out.endsWith('\\n')) out += '\\n';
        out += textWithBreaks(node);
      } else out += node.textContent;
    });
    return out;
  }

  function applyEdits(edits) {
    Object.entries(edits || {}).forEach(([sel, val]) => {
      try {
        const el = document.querySelector(sel);
        if (el && textWithBreaks(el) !== val) renderText(el, val);
      } catch(e) {}
    });
  }

  function applyImages(images, deletes) {
    Object.entries(images || {}).forEach(([oldSrc, newSrc]) => {
      document.querySelectorAll('img').forEach(img => {
        const cur = img.getAttribute('src');
        if (cur && (cur === oldSrc || cur.endsWith('/' + oldSrc))) {
          img.setAttribute('src', newSrc);
        }
      });
    });
    (deletes || []).forEach(delSrc => {
      document.querySelectorAll('img').forEach(img => {
        const cur = img.getAttribute('src');
        if (cur && (cur === delSrc || cur.endsWith('/' + delSrc))) {
          if (img.parentNode) img.parentNode.removeChild(img);
        }
      });
    });
  }

  function applyStyles(styles) {
    // styles: { selector: { color?, fontSize?, textAlign? } }
    // Missing/null props clear that override.
    var KNOWN = { color: 'color', fontSize: 'font-size', textAlign: 'text-align' };
    Object.entries(styles || {}).forEach(([sel, decls]) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return;
        Object.keys(KNOWN).forEach(function(key) {
          if (decls && decls[key]) el.style.setProperty(KNOWN[key], decls[key]);
          else                     el.style.removeProperty(KNOWN[key]);
        });
      } catch(e) {}
    });
  }

  let highlighted = null;

  document.addEventListener('mouseover', (e) => {
    if (!isEditable(e.target)) return;
    if (highlighted) highlighted.style.outline = '';
    highlighted = e.target;
    highlighted.style.outline = '2px solid #b56a78';
    highlighted.style.outlineOffset = '2px';
    highlighted.style.cursor = 'text';
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (highlighted) {
      highlighted.style.outline = '';
      highlighted.style.cursor = '';
      highlighted = null;
    }
  }, true);

  document.addEventListener('click', (e) => {
    // Image click → swap
    if (e.target.tagName === 'IMG' && !e.target.closest('header, footer, .lb, nav, .site-dropdown')) {
      e.preventDefault(); e.stopPropagation();
      const src = e.target.getAttribute('src');
      window.parent.postMessage({ type: 'edit-image', src, alt: e.target.alt }, '*');
      return;
    }
    // Block link navigation inside the editor iframe — Helen is editing,
    // not browsing. Without this, clicking text inside a card link (or any
    // header/footer link) navigates away before the edit handler fires.
    // The sidebar is the navigator; the iframe stays on the active page.
    const linkAncestor = e.target.closest('a[href]');
    if (linkAncestor) {
      e.preventDefault();
    }
    if (!isEditable(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const sel = pathFor(el);
    const original = textWithBreaks(el);
    el.contentEditable = 'true';
    el.style.outline = '2px solid #b56a78';
    el.style.outlineOffset = '2px';
    el.style.background = 'rgba(245,219,217,.6)';
    el.focus();
    // Place caret at the click position so Helen can insert text where
    // she clicked. Falls back to end-of-text on browsers without
    // caretRangeFromPoint (uncommon).
    try {
      const range = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : null;
      if (range) {
        const ssel = window.getSelection();
        ssel.removeAllRanges();
        ssel.addRange(range);
      }
    } catch (_e) {}
    window.parent.postMessage({ type: 'edit-start', selector: sel, original }, '*');

    function commit() {
      const next = textWithBreaks(el);
      el.contentEditable = 'false';
      el.style.outline = '';
      el.style.background = '';
      if (next !== original) {
        window.parent.postMessage({ type: 'edit-commit', selector: sel, original, next }, '*');
      }
      el.removeEventListener('blur', commit);
      el.removeEventListener('keydown', onKey);
    }
    function onKey(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); }
      if (ev.key === 'Escape') { renderText(el, original); el.blur(); }
    }
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', onKey);
  }, true);

  window.__applyDraft = function(draft) {
    applyEdits(draft.edits);
    applyImages(draft.images, draft.imageDeletes);
    applyStyles(draft.styles);
  };

  window.parent.postMessage({ type: 'iframe-ready' }, '*');
})();
`;

// ──────────────────────────────────────────────────────────────────
// Main app
// ──────────────────────────────────────────────────────────────────
function App() {
  const [draft, setDraft] = useState(loadDraft);
  const [activePageId, setActivePageId] = useState('index');
  const [selection, setSelection] = useState(null); // { type, selector, value, image }
  const [toasts, setToasts] = useState([]);
  const [showExport, setShowExport] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [publishStatus, setPublishStatus] = useState(null); // null | { phase, runUrl?, runId?, error? }
  const [showRecent, setShowRecent] = useState(false);
  const [editingNavFor, setEditingNavFor] = useState(null);
  const [recentPublishes, setRecentPublishes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PUBLISHES_KEY) || '[]'); }
    catch { return []; }
  });
  const [showNewPage, setShowNewPage] = useState(false);
  const [imageEdit, setImageEdit] = useState(null);
  const iframeRef = useRef(null);
  const deviceRef = useRef(null);
  const scalerRef = useRef(null);

  // Keep the iframe (rendered at fixed 1280px desktop width) scaled to fit
  // the available stage area. This guarantees the live nav stays desktop, no hamburger.
  useEffect(() => {
    const device = deviceRef.current;
    const scaler = scalerRef.current;
    if (!device || !scaler) return;
    const FRAME_W = 1280;
    function fit() {
      const w = device.clientWidth;
      const h = device.clientHeight;
      // Scale freely (no cap at 1) so the iframe always fills the stage width.
      // Iframe stays at 1280px internally so the live nav renders desktop, not
      // hamburger; CSS transform handles the visual fit.
      const scale = w / FRAME_W;
      scaler.style.transform = `scale(${scale})`;
      scaler.style.height = `${h / scale}px`;
      scaler.style.width = `${FRAME_W}px`;
      // Also update iframe height so it fills the (now-scaled) device
      const f = scaler.querySelector('iframe');
      if (f) {
        f.style.width = `${FRAME_W}px`;
        f.style.height = `${h / scale}px`;
      }
    }
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(device);
    return () => ro.disconnect();
  }, []);

  // Combine canonical PAGES with draft-only "new" pages so they appear in the sidebar.
  const draftNewPages = (draft.newPages || []);
  const ALL_PAGES = [...PAGES, ...draftNewPages];
  const activePage = ALL_PAGES.find(p => p.id === activePageId);
  // For draft new pages, load the TEMPLATE page in the iframe (the new file
  // doesn't exist on disk yet — it materialises when Paul applies the draft).
  const activeIframeFile = activePage?.draftNew
    ? (PAGES.find(p => p.id === activePage.template)?.file || 'index.html')
    : (activePage?.file || 'index.html');
  const pageEdits = draft.edits[activePageId] || {};
  const pageImages = draft.images || {};
  const totalEditsCount = Object.values(draft.edits).reduce((s, e) => s + Object.keys(e).length, 0)
    + Object.keys(draft.images || {}).length
    + Object.values(draft.styles || {}).reduce((s, e) => s + Object.keys(e).length, 0);
  const pageStyles = (draft.styles || {})[activePageId] || {};

  // Generic style setter — Helen picks colour/size/etc. → write to
  // draft.styles[pageId][selector] and live-update the iframe element.
  function setSelectionStyle(prop, value) {
    if (!selection || selection.type !== 'text') return;
    const sel = selection.selector;
    // camelCase → kebab-case for CSS (fontSize → font-size, textAlign → text-align)
    const cssProp = prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    setDraft(d => {
      const pageMap = { ...((d.styles || {})[activePageId] || {}) };
      const current = { ...(pageMap[sel] || {}) };
      if (value == null) delete current[prop]; else current[prop] = value;
      if (Object.keys(current).length === 0) delete pageMap[sel];
      else pageMap[sel] = current;
      const nextStyles = { ...(d.styles || {}) };
      if (Object.keys(pageMap).length === 0) delete nextStyles[activePageId];
      else nextStyles[activePageId] = pageMap;
      return { ...d, styles: nextStyles };
    });
    setSelection(s => s ? { ...s, [prop]: value } : s);
    try {
      const el = iframeRef.current.contentDocument.querySelector(sel);
      if (el) {
        if (value == null) el.style.removeProperty(cssProp);
        else el.style.setProperty(cssProp, value);
      }
    } catch {}
    toast(value == null ? 'Reset to default' : 'Saved to draft', 'success');
  }

  // Persist draft on change
  useEffect(() => { saveDraft(draft); }, [draft]);

  function toast(msg, kind = '') {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2400);
  }

  // Iframe message handler
  useEffect(() => {
    function onMessage(e) {
      const m = e.data || {};
      if (m.type === 'iframe-ready') {
        // Push current draft into iframe
        const win = iframeRef.current?.contentWindow;
        if (win && win.__applyDraft) win.__applyDraft({ edits: pageEdits, images: pageImages, imageDeletes: draft.imageDeletes || [], styles: pageStyles });
      }
      if (m.type === 'edit-start') {
        const existing = (draft.styles?.[activePageId] || {})[m.selector] || {};
        setSelection({
          type: 'text',
          selector: m.selector,
          value: m.original,
          color: existing.color || null,
          fontSize: existing.fontSize || null,
          textAlign: existing.textAlign || null,
        });
      }
      if (m.type === 'edit-commit') {
        setDraft(d => ({
          ...d,
          edits: { ...d.edits, [activePageId]: { ...(d.edits[activePageId] || {}), [m.selector]: m.next } },
        }));
        setSelection(s => s && s.selector === m.selector ? { ...s, value: m.next } : s);
        toast('Saved to draft', 'success');
      }
      if (m.type === 'edit-image') {
        setImageEdit({ src: m.src, alt: m.alt });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activePageId, pageEdits, pageImages]);

  // Inject editor script when iframe loads
  function onIframeLoad() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      const doc = win.document;
      const style = doc.createElement('style');
      style.textContent = IFRAME_CSS;
      doc.head.appendChild(style);
      const s = doc.createElement('script');
      s.textContent = IFRAME_INJECT;
      doc.body.appendChild(s);
    } catch (err) {
      console.error('Inject failed', err);
    }
  }

  // Page status
  function togglePagePublished(id) {
    setDraft(d => ({
      ...d,
      pageStatus: { ...d.pageStatus, [id]: !((d.pageStatus[id] !== undefined ? d.pageStatus[id] : true)) },
    }));
    toast('Page status updated', 'success');
  }

  // Image swap
  async function applyImageSwap(file) {
    if (!file || !imageEdit) return;
    // Hard guard: > 25MB will OOM-crash an iPad Safari tab even with
    // optimised decode. Refuse politely instead.
    if (file.size > 25 * 1024 * 1024) {
      toast("That photo's huge — try one under 25MB", 'error');
      setImageEdit(null);
      return;
    }
    const MAX = 1600;
    const targetSrc = imageEdit.src;
    setImageEdit(null); // close the inspector immediately so Helen sees progress
    toast('Resizing photo…', 'info');
    try {
      // Use a blob URL rather than FileReader → base64. A FileReader
      // pushes a copy into JS memory AS bytes AND as a base64 string
      // simultaneously, which on iPad Safari is enough to OOM the tab
      // and white-screen the WebView. Blob URLs let the browser
      // decode lazily without copying.
      const blobUrl = URL.createObjectURL(file);
      let dataUrl;
      try {
        // createImageBitmap with resizeWidth/Height does the resize
        // *during decode* — it never holds a full-resolution bitmap in
        // memory. Best path on Safari 14+.
        let bitmap;
        try {
          // Probe the image dims first so we resize the longest edge
          const probeImg = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('image decode failed'));
            i.src = blobUrl;
          });
          const w0 = probeImg.naturalWidth, h0 = probeImg.naturalHeight;
          if (!w0 || !h0) throw new Error('zero-dimension image');
          const scale = Math.min(1, MAX / Math.max(w0, h0));
          const w = Math.max(1, Math.round(w0 * scale));
          const h = Math.max(1, Math.round(h0 * scale));
          if (typeof createImageBitmap === 'function') {
            try {
              bitmap = await createImageBitmap(file, {
                resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
              });
            } catch (_e) { /* fall through to manual canvas draw */ }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (bitmap) {
            ctx.drawImage(bitmap, 0, 0);
            if (bitmap.close) bitmap.close();
          } else {
            ctx.drawImage(probeImg, 0, 0, w, h);
          }
          dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } catch (innerErr) {
        URL.revokeObjectURL(blobUrl);
        throw innerErr;
      }
      setDraft(d => ({ ...d, images: { ...d.images, [targetSrc]: dataUrl } }));
      toast('Photo swapped (draft)', 'success');
      const win = iframeRef.current?.contentWindow;
      if (win && win.__applyDraft) {
        win.__applyDraft({ edits: pageEdits, images: { ...pageImages, [targetSrc]: dataUrl }, imageDeletes: draft.imageDeletes || [], styles: pageStyles });
      }
    } catch (err) {
      console.error('[Blossom] image swap failed:', err);
      toast("Couldn't process that photo — try a smaller or different one", 'error');
    }
  }

  function clearAllDrafts() {
    if (!confirm('Discard all draft edits? This cannot be undone.')) return;
    setDraft({ edits: {}, images: {}, imageDeletes: [], pageStatus: {}, site: {}, newPages: [], styles: {} });
    const win = iframeRef.current?.contentWindow;
    if (win) win.location.reload();
    toast('Drafts cleared', 'success');
  }

  // Remove the photo currently selected in the inspector. Adds its src
  // to draft.imageDeletes; the iframe applyImages call removes the
  // <img> from the live preview, and apply-draft.py strips the tag
  // from the source HTML on publish (and unlinks the file if no
  // other page still references it).
  function removeCurrentPhoto() {
    if (!imageEdit) return;
    if (!confirm('Remove this photo from the page? On publish it will be deleted from the site.')) return;
    const targetSrc = imageEdit.src;
    const nextDeletes = Array.from(new Set([...(draft.imageDeletes || []), targetSrc]));
    // If there was a pending swap on this src, drop it — delete supersedes.
    const nextImages = Object.fromEntries(
      Object.entries(draft.images || {}).filter(([k]) => k !== targetSrc)
    );
    setImageEdit(null);
    setDraft(d => ({ ...d, imageDeletes: nextDeletes, images: nextImages }));
    toast('Photo removed (draft)', 'success');
    const win = iframeRef.current?.contentWindow;
    if (win && win.__applyDraft) {
      win.__applyDraft({ edits: pageEdits, images: nextImages, imageDeletes: nextDeletes, styles: pageStyles });
    }
  }

  function createNewPage({ label, slug, templateId, section, note }) {
    const tpl = PAGES.find(p => p.id === templateId);
    if (!tpl) { toast('Pick a template', 'error'); return; }
    const id = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) { toast('Need a URL slug', 'error'); return; }
    if (ALL_PAGES.some(p => p.id === id)) { toast('A page with that URL already exists', 'error'); return; }
    const newPage = {
      id, file: id + '.html', label: label.trim() || id, template: templateId,
      published: false, draftNew: true,
      // section is one of "cakes" | "weddings" | "bakes" | "" (none).
      // apply-draft.py reads this and writes nav metadata into pages.json,
      // then rewrites every hand-crafted page's nav block from there so
      // the new page appears in the correct dropdown sitewide. note is the
      // small grey subtitle that shows under the page label in the dropdown.
      section: section || '',
      note: (note || '').trim(),
    };
    setDraft(d => ({ ...d, newPages: [...(d.newPages || []), newPage] }));
    setActivePageId(id);
    setShowNewPage(false);
    toast('New page added to draft — edit away', 'success');
  }

  // Edit the menu placement (section + subtitle) on an existing draft new
  // page. Used to retrofit pages created before NewPageModal grew the
  // section field — Helen doesn't have to discard the draft and recreate.
  function setDraftNavPlacement(id, section, note) {
    setDraft(d => ({
      ...d,
      newPages: (d.newPages || []).map(p =>
        p.id === id ? { ...p, section: section || '', note: (note || '').trim() } : p
      ),
    }));
    toast('Menu placement saved', 'success');
    setEditingNavFor(null);
  }

  function removeDraftNewPage(id) {
    if (!confirm('Remove this draft page? Any edits to it will be discarded.')) return;
    setDraft(d => {
      const { [id]: _, ...restEdits } = d.edits || {};
      return {
        ...d,
        newPages: (d.newPages || []).filter(p => p.id !== id),
        edits: restEdits,
      };
    });
    if (activePageId === id) setActivePageId('index');
    toast('Draft page removed', 'success');
  }

  function exportDraft() {
    const payload = {
      _meta: { exportedAt: new Date().toISOString(), version: 1 },
      edits: draft.edits,
      pageStatus: draft.pageStatus,
      site: draft.site,
      newPages: draft.newPages || [],
      styles: draft.styles || {},
      // Images: include ref + base64 — Paul/Claude Code will save these to disk
      images: Object.fromEntries(
        Object.entries(draft.images || {}).map(([oldSrc, dataUrl]) => {
          const filename = (oldSrc.split('/').pop() || 'image') + '.replace.' + Date.now();
          return [oldSrc, { filename, dataUrl }];
        })
      ),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'blossom-draft-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Draft exported — send to Paul', 'success');
    setShowExport(false);
  }

  // ──────────────────────────────────────────────────────────────────
  // Publish flow — POST text edits + page status to publish-draft edge
  // function, which dispatches the GitHub Actions workflow. Image swaps
  // still go via Save draft for review (Paul-in-the-loop).
  // ──────────────────────────────────────────────────────────────────
  const totalImagesCount = Object.keys(draft.images || {}).length;
  const editPages = Object.entries(draft.edits || {}).filter(([, e]) => Object.keys(e).length > 0);
  const newPagesCount = (draft.newPages || []).length;

  function pushRecentPublish(entry) {
    setRecentPublishes(prev => {
      const next = [entry, ...prev].slice(0, 10);
      localStorage.setItem(PUBLISHES_KEY, JSON.stringify(next));
      return next;
    });
  }

  // Find the commit a publish workflow run actually pushed. The run's
  // `head_sha` is the PRE-run state of main, NOT the new commit — using it
  // for revert would target some earlier random commit. Walk the commits
  // API and find the one whose parent is head_sha; that's the commit our
  // workflow added.
  async function findPushedSha(runId) {
    if (!runId) return null;
    try {
      const runResp = await fetch(`https://api.github.com/repos/pauldesmond/blossom-bakery/actions/runs/${runId}`);
      if (!runResp.ok) return null;
      const runData = await runResp.json();
      const headSha = runData.head_sha;
      if (!headSha) return null;
      const cResp = await fetch(`https://api.github.com/repos/pauldesmond/blossom-bakery/commits?per_page=30`);
      if (!cResp.ok) return null;
      const commits = await cResp.json();
      const target = commits.find(c => c.parents?.[0]?.sha === headSha);
      return target?.sha || null;
    } catch {
      return null;
    }
  }

  async function pollRunStatus(runId, runUrl) {
    if (!runId) return;
    const start = Date.now();
    const poll = async () => {
      if (Date.now() - start > 90_000) {
        setPublishStatus({ phase: 'unknown', runUrl });
        return;
      }
      try {
        const r = await fetch(`https://api.github.com/repos/pauldesmond/blossom-bakery/actions/runs/${runId}`);
        if (r.ok) {
          const data = await r.json();
          if (data.status === 'completed') {
            if (data.conclusion === 'success') {
              const pushedSha = await findPushedSha(runId);
              setPublishStatus({ phase: 'done', runUrl, sha: pushedSha });
              // Backfill the SHA into the matching recent-publish entry.
              setRecentPublishes(prev => {
                const next = prev.map(p => p.runId === runId ? { ...p, sha: pushedSha } : p);
                localStorage.setItem(PUBLISHES_KEY, JSON.stringify(next));
                return next;
              });
              return;
            }
            setPublishStatus({ phase: 'failed', runUrl, error: data.conclusion });
            return;
          }
        }
      } catch {}
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 4000);
  }

  async function publishNow({ password, message }) {
    setPublishStatus({ phase: 'sending' });
    const slimDraft = {
      _meta: { publishedAt: new Date().toISOString(), version: 1 },
      edits: draft.edits,
      pageStatus: draft.pageStatus,
      newPages: draft.newPages || [],
      styles: draft.styles || {},
      images: {}, // images stripped server-side too; explicit here for clarity
    };
    try {
      const resp = await fetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, message, draft: slimDraft }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        if (resp.status === 401) localStorage.removeItem(PASSWORD_KEY);
        setPublishStatus({ phase: 'failed', error: data.error || `HTTP ${resp.status}` });
        return;
      }
      localStorage.setItem(PASSWORD_KEY, password);
      setPublishStatus({ phase: 'queued', runUrl: data.runUrl, runId: data.runId });
      pushRecentPublish({
        at: new Date().toISOString(),
        message: message || 'helen edits',
        runUrl: data.runUrl,
        runId: data.runId,
        edits: editPages.length,
        newPages: newPagesCount,
      });
      // Optimistically clear text edits + page status from draft. If the
      // workflow fails, Helen still has the JSON in localStorage (no, we
      // just cleared it — keep around for now until polling confirms).
      pollRunStatus(data.runId, data.runUrl);
    } catch (err) {
      setPublishStatus({ phase: 'failed', error: String(err) });
    }
  }

  // When the run reports success, clear the published portion of the draft
  // and refresh the iframe so Helen sees the live result.
  useEffect(() => {
    if (publishStatus?.phase === 'done') {
      setDraft(d => ({
        ...d,
        edits: {},
        pageStatus: {},
        newPages: [],
        // images preserved — they didn't go in this publish
      }));
      // Reload iframe after a short delay (Pages needs to rebuild)
      setTimeout(() => {
        if (iframeRef.current) {
          // Cache-bust by toggling key; React remounts the iframe on key change
          iframeRef.current.src = iframeRef.current.src;
        }
      }, 60_000);
    }
  }, [publishStatus?.phase]);

  async function revertPublish(entry) {
    if (!entry?.runId) {
      alert("Couldn't find that publish in GitHub. Open the link to revert manually.");
      if (entry?.runUrl) window.open(entry.runUrl, '_blank');
      return;
    }
    // Always look up the actual pushed commit for safety — older entries
    // were saved with run.head_sha which is the WRONG sha (pre-run state).
    let sha = await findPushedSha(entry.runId);
    if (!sha) sha = entry.sha;  // fallback to whatever was cached, even if probably wrong
    if (!sha) {
      alert("Couldn't find the commit for that publish. Open the GitHub link to revert manually.");
      window.open(entry.runUrl, '_blank');
      return;
    }
    if (!confirm(`Undo publish "${entry.message}"? This will revert the live site to the previous state.`)) return;
    const password = localStorage.getItem(PASSWORD_KEY) || prompt('Publish password:');
    if (!password) return;
    // Close Recent, open Publish modal so the user can see the progress.
    setShowRecent(false);
    setShowPublish(true);
    setPublishStatus({ phase: 'sending' });
    try {
      const resp = await fetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, revertSha: sha }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        setPublishStatus({ phase: 'failed', error: (data && data.error) || `HTTP ${resp.status}` });
        return;
      }
      setPublishStatus({ phase: 'queued', runUrl: data.runUrl, runId: data.runId });
      pollRunStatus(data.runId, data.runUrl);
    } catch (err) {
      setPublishStatus({ phase: 'failed', error: String(err) });
    }
  }

  return (
    <div className="app">
      {/* Top bar */}
      <div className="topbar">
        <div className="brand">
          <img src="../images/blossom_logo_transparent.png" alt="" />
          <span>Blossom <em>Editor</em></span>
        </div>
        <div className="topbar__sep"></div>
        <div className="topbar__crumb">
          Editing <strong>{activePage?.label || '—'}</strong>
        </div>
        <div className="topbar__spacer"></div>
        <div className={'topbar__status ' + (totalEditsCount ? 'dirty' : '')}>
          {totalEditsCount ? `${totalEditsCount} change${totalEditsCount === 1 ? '' : 's'} in draft` : 'No changes'}
        </div>
        <a className="btn btn--ghost" href="helen-guide.html" target="_blank" rel="noopener" title="How to update your website" style={{ textDecoration: 'none' }}>Help</a>
        {recentPublishes.length > 0 && (
          <button className="btn btn--ghost" onClick={() => setShowRecent(true)} title="Recent publishes — undo if needed">Recent</button>
        )}
        <button className="btn btn--ghost" onClick={clearAllDrafts}>Discard drafts</button>
        <button className="btn btn--ghost" onClick={() => setShowExport(true)} disabled={!totalEditsCount} title="Send the draft to Paul">
          Save draft
        </button>
        <button className="btn btn--primary" onClick={() => setShowPublish(true)} disabled={!totalEditsCount} title="Publish edits straight to the live site">
          Publish to live
        </button>
      </div>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar__section">
          <div className="sidebar__title">Pages</div>
          <ul className="page-list">
            {ALL_PAGES.map(p => {
              const published = draft.pageStatus[p.id] !== undefined ? draft.pageStatus[p.id] : p.published;
              return (
                <li
                  key={p.id}
                  className={'page-item' + (p.id === activePageId ? ' active' : '') + (!published ? ' unpublished' : '')}
                  onClick={() => setActivePageId(p.id)}
                >
                  <span className="page-item__icon"></span>
                  <span className="page-item__name">
                    {p.label}
                    {p.draftNew && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', background: 'var(--rose-soft)', color: 'var(--rose-deep)', borderRadius: 999, letterSpacing: '.05em', textTransform: 'uppercase' }}>NEW</span>}
                  </span>
                  {p.draftNew ? (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        className="page-item__toggle"
                        title="Where this page appears in the menu"
                        onClick={(e) => { e.stopPropagation(); setEditingNavFor(p.id); }}
                      >Menu</button>
                      <button
                        className="page-item__toggle"
                        title="Remove this draft page"
                        onClick={(e) => { e.stopPropagation(); removeDraftNewPage(p.id); }}
                      >Remove</button>
                    </span>
                  ) : (
                    <button
                      className="page-item__toggle"
                      title={published ? 'Hide page' : 'Show page'}
                      onClick={(e) => { e.stopPropagation(); togglePagePublished(p.id); }}
                    >{published ? 'Hide' : 'Show'}</button>
                  )}
                </li>
              );
            })}
          </ul>
          <button className="new-page-btn" style={{ marginTop: 12 }} onClick={() => setShowNewPage(true)}>
            + New page (duplicate &amp; fill)
          </button>
        </div>
      </div>

      {/* Stage */}
      <div className="stage editing">
        <div className="stage__device" ref={deviceRef}>
          <div className="stage__scaler" ref={scalerRef}>
            <iframe
              ref={iframeRef}
              className="stage__frame"
              src={BASE_PATH + activeIframeFile}
              onLoad={onIframeLoad}
              key={activePageId}
            ></iframe>
          </div>
        </div>
        <div className="stage__hint">Click any text or image on the page to edit</div>
      </div>

      {/* Inspector */}
      <div className="inspector">
        {selection ? (
          <div className="inspector__section">
            <h2 className="inspector__title">Editing text</h2>
            <p className="inspector__sub">Type into the page directly. Press <strong>Enter</strong> to save, <strong>Esc</strong> to cancel.</p>
            <div className="field">
              <label className="field__label">Current value</label>
              <textarea
                value={selection.value || ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelection(s => ({ ...s, value: v }));
                  // Live update iframe + draft
                  setDraft(d => ({
                    ...d,
                    edits: { ...d.edits, [activePageId]: { ...(d.edits[activePageId] || {}), [selection.selector]: v } },
                  }));
                  try {
                    const el = iframeRef.current.contentDocument.querySelector(selection.selector);
                    if (el) {
                      // Render with <br> for each \n so the iframe preview
                      // reflects line breaks (matches what apply-draft.py
                      // will write). Plain textContent collapses newlines
                      // to whitespace.
                      el.textContent = '';
                      v.split('\n').forEach((line, i) => {
                        if (i > 0) el.appendChild(el.ownerDocument.createElement('br'));
                        el.appendChild(el.ownerDocument.createTextNode(line));
                      });
                    }
                  } catch {}
                }}
              />
              <div className="field__hint">Saves to draft as you type</div>
            </div>

            <div className="field" style={{ marginTop: 6 }}>
              <label className="field__label">Colour</label>
              <div className="colour-row">
                {TEXT_COLOURS.map(c => {
                  const isActive = (selection.color || null) === c.value;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={'colour-swatch' + (isActive ? ' active' : '')}
                      onClick={() => setSelectionStyle('color', c.value)}
                      title={c.label}
                    >
                      <span
                        className="colour-swatch__dot"
                        style={c.value
                          ? { background: c.value }
                          : { background: 'transparent', backgroundImage: 'linear-gradient(45deg, transparent 45%, var(--ink-soft) 45%, var(--ink-soft) 55%, transparent 55%)' }}
                      ></span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <label className="field__label">Size</label>
              <div className="size-row">
                {TEXT_SIZES.map(s => {
                  const isActive = (selection.fontSize || null) === s.value;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={'size-btn' + (isActive ? ' active' : '')}
                      onClick={() => setSelectionStyle('fontSize', s.value)}
                      title={s.label + (s.value ? ` (${s.value})` : '')}
                    >
                      <span className="size-btn__sample" style={{ fontSize: s.preview + 'px' }}>Aa</span>
                      <span className="size-btn__label">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <label className="field__label">Alignment</label>
              <div className="align-row">
                {TEXT_ALIGNS.map(a => {
                  const isActive = (selection.textAlign || null) === a.value;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={'align-btn' + (isActive ? ' active' : '')}
                      onClick={() => setSelectionStyle('textAlign', a.value)}
                      title={a.label}
                      aria-label={a.label}
                    >
                      <span className="align-btn__icon">{a.icon}</span>
                      <span className="align-btn__label">{a.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button className="btn" onClick={() => setSelection(null)}>Done</button>
          </div>
        ) : imageEdit ? (
          <div className="inspector__section">
            <h2 className="inspector__title">Edit photo</h2>
            <p className="inspector__sub">Upload a new photo to replace this one, or remove it from the page.</p>
            <img src={pageImages[imageEdit.src] || imageEdit.src} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 12 }} />
            <input type="file" accept="image/*" onChange={(e) => applyImageSwap(e.target.files[0])} />
            <div className="field__hint" style={{ marginTop: 12 }}>Tip: use a square or 4:3 photo for galleries.</div>
            <button
              className="btn"
              style={{ marginTop: 18, color: '#b03030', borderColor: '#b03030', background: 'transparent' }}
              onClick={removeCurrentPhoto}
            >
              Remove this photo
            </button>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setImageEdit(null)}>Cancel</button>
          </div>
        ) : (
          <div className="inspector__empty">
            <h3>Click to edit.</h3>
            <p>Hover any text or photo on the page. When it lights pink, click it.</p>
            <div className="tip">
              <strong>Saved as a draft.</strong><br/>
              Nothing goes live until you click <em>"Save draft for review"</em> and Paul approves it.
            </div>
            {totalEditsCount > 0 && (
              <div style={{ marginTop: 20, textAlign: 'left', fontSize: 12 }}>
                <div className="field__label">Changes in this draft</div>
                {PAGES.map(p => {
                  const n = Object.keys(draft.edits[p.id] || {}).length;
                  if (n === 0) return null;
                  return <div key={p.id} style={{ padding: '4px 0', color: 'var(--ink)' }}>· {p.label}: <strong>{n}</strong></div>;
                })}
                {Object.keys(draft.images || {}).length > 0 && (
                  <div style={{ padding: '4px 0', color: 'var(--ink)' }}>· Photos: <strong>{Object.keys(draft.images).length}</strong></div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New page modal */}
      {showNewPage && <NewPageModal pages={PAGES} onCancel={() => setShowNewPage(false)} onCreate={createNewPage} />}

      {/* Menu placement modal for existing draft new pages */}
      {editingNavFor && (
        <EditNavPlacementModal
          page={(draft.newPages || []).find(p => p.id === editingNavFor)}
          onCancel={() => setEditingNavFor(null)}
          onSave={setDraftNavPlacement}
        />
      )}

      {/* Export modal */}
      {showExport && (
        <div className="drawer-bg" onClick={() => setShowExport(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <h2>Save draft for review</h2>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6 }}>
              This downloads a small file with all your edits. Send it to Paul (or paste in chat) and he'll review and push them live.
            </p>
            <div style={{ background: 'var(--bg-soft)', padding: 14, borderRadius: 6, fontSize: 12, marginTop: 14 }}>
              <strong>{totalEditsCount} change{totalEditsCount === 1 ? '' : 's'}</strong> across {Object.keys(draft.edits).filter(k => Object.keys(draft.edits[k]).length).length} page{Object.keys(draft.edits).filter(k => Object.keys(draft.edits[k]).length).length === 1 ? '' : 's'}
              {Object.keys(draft.images || {}).length > 0 && <> · {Object.keys(draft.images).length} photo swap{Object.keys(draft.images).length === 1 ? '' : 's'}</>}
              {(draft.imageDeletes || []).length > 0 && <> · {(draft.imageDeletes || []).length} photo remove{(draft.imageDeletes || []).length === 1 ? '' : 's'}</>}
            </div>
            <div className="drawer__actions">
              <button className="btn btn--ghost" onClick={() => setShowExport(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={exportDraft}>Download draft</button>
            </div>
          </div>
        </div>
      )}

      {/* Publish modal */}
      {showPublish && (
        <PublishModal
          editsCount={totalEditsCount}
          editPages={editPages.map(([id]) => ALL_PAGES.find(p => p.id === id)?.label || id)}
          imagesCount={totalImagesCount}
          newPagesCount={newPagesCount}
          status={publishStatus}
          onCancel={() => { setShowPublish(false); setPublishStatus(null); }}
          onConfirm={publishNow}
        />
      )}

      {/* Recent publishes modal */}
      {showRecent && (
        <RecentPublishesModal
          publishes={recentPublishes}
          onClose={() => setShowRecent(false)}
          onRevert={revertPublish}
        />
      )}

      {/* Toasts */}
      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

function NewPageModal({ pages, onCancel, onCreate }) {
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [templateId, setTemplateId] = useState(pages[0]?.id || '');
  const [section, setSection] = useState('cakes');
  const [note, setNote] = useState('');
  const slugFromLabel = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const effectiveSlug = slug || slugFromLabel;
  return (
    <div className="drawer-bg" onClick={onCancel}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h2>Add a new page</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' }}>
          Pick an existing page to use as a starting point. The new page will copy its layout — you can then change the text and photos in it like any other page.
        </p>
        <div className="field">
          <label className="field__label">Page name</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Christmas Cookies" />
          <div className="field__hint">Shows in the menu and at the top of the page.</div>
        </div>
        <div className="field">
          <label className="field__label">Web address</label>
          <input type="text" value={effectiveSlug} onChange={(e) => setSlug(e.target.value)} placeholder="christmas-cookies" />
          <div className="field__hint">myblossombakery.co.uk/<strong>{effectiveSlug || 'your-page'}</strong>.html · lowercase, hyphens only.</div>
        </div>
        <div className="field">
          <label className="field__label">Copy layout from</label>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {pages.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <div className="field__hint">Tip: pick a page whose shape matches what you have in mind.</div>
        </div>
        <div className="field">
          <label className="field__label">Add to menu under</label>
          <select value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="cakes">Cakes</option>
            <option value="weddings">Weddings</option>
            <option value="bakes">Bakes</option>
            <option value="">— Don't add to menu —</option>
          </select>
          <div className="field__hint">Where the new page lives in the top nav. Also adds a card to the homepage.</div>
        </div>
        <div className="field">
          <label className="field__label">Subtitle in menu (optional)</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Two-tier · celebration" />
          <div className="field__hint">The small grey line under the page name in the dropdown. Leave blank for a clean entry.</div>
        </div>
        <div className="drawer__actions">
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" disabled={!label.trim() || !effectiveSlug} onClick={() => onCreate({ label, slug: effectiveSlug, templateId, section, note })}>Create draft page</button>
        </div>
      </div>
    </div>
  );
}

function PublishModal({ editsCount, editPages, imagesCount, newPagesCount, status, onCancel, onConfirm }) {
  const [password, setPassword] = useState(() => localStorage.getItem(PASSWORD_KEY) || '');
  const [message, setMessage] = useState('');

  // Phases: null/undefined → form; sending/queued → working; done → success; failed → error
  const phase = status?.phase;
  const working = phase === 'sending' || phase === 'queued';
  const done = phase === 'done';
  const failed = phase === 'failed' || phase === 'unknown';

  return (
    <div className="drawer-bg" onClick={working ? undefined : onCancel}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h2>Publish to live site</h2>

        {!phase && (
          <>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6 }}>
              This will push your text edits straight to <strong>myblossombakery.co.uk</strong>. Live within about a minute.
            </p>
            <div style={{ background: 'var(--bg-soft)', padding: 14, borderRadius: 6, fontSize: 13, marginTop: 14 }}>
              About to publish: <strong>{editsCount} text edit{editsCount === 1 ? '' : 's'}</strong>{editPages.length ? <> across <strong>{editPages.length} page{editPages.length === 1 ? '' : 's'}</strong></> : null}
              {newPagesCount > 0 && <><br/>Plus <strong>{newPagesCount} new page{newPagesCount === 1 ? '' : 's'}</strong> to add to the site.</>}
              {imagesCount > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--line)', color: 'var(--rose-deep)' }}>
                  <strong>Note:</strong> {imagesCount} photo swap{imagesCount === 1 ? '' : 's'} won't go through this — they need Paul. Use <em>Save draft</em> for those.
                </div>
              )}
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <label className="field__label">Description (optional)</label>
              <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. updated wedding cake prices" />
              <div className="field__hint">Shows in the publish history so you can find it later.</div>
            </div>
            <div className="field">
              <label className="field__label">Publish password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="ask Paul" autoFocus />
              <div className="field__hint">You only need to type this the first time on each device.</div>
            </div>
            <div className="drawer__actions">
              <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
              <button className="btn btn--primary" disabled={!password.trim() || !editsCount} onClick={() => onConfirm({ password: password.trim(), message: message.trim() })}>
                Yes, publish now
              </button>
            </div>
          </>
        )}

        {working && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontStyle: 'italic', margin: '0 0 8px', color: 'var(--ink)' }}>
              {phase === 'sending' ? 'Sending edits…' : 'Building the site…'}
            </h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
              This usually takes about a minute. You can close this dialog and keep working.
            </p>
            {status?.runUrl && (
              <p style={{ marginTop: 14 }}>
                <a href={status.runUrl} target="_blank" rel="noopener" style={{ color: 'var(--rose-deep)', fontSize: 12 }}>Watch progress on GitHub →</a>
              </p>
            )}
            <div className="drawer__actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn--ghost" onClick={onCancel}>Close</button>
            </div>
          </div>
        )}

        {done && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>✨</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontStyle: 'italic', margin: '0 0 8px', color: 'var(--ink)' }}>Published.</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
              Your changes are on the live site now. The preview will refresh in a moment.
            </p>
            <div className="drawer__actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={onCancel}>Done</button>
            </div>
          </div>
        )}

        {failed && (
          <div style={{ padding: '8px 0' }}>
            <div style={{ fontSize: 28, textAlign: 'center', marginBottom: 10 }}>⚠️</div>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 20, margin: '0 0 8px', color: 'var(--ink)', textAlign: 'center' }}>
              {phase === 'unknown' ? "Couldn't confirm" : 'Publish failed'}
            </h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, textAlign: 'center' }}>
              {phase === 'unknown'
                ? 'The publish was sent but we lost track of it. Check the link below to see if it went through.'
                : (status?.error || 'Something went wrong.') + ' Try again, or send the draft to Paul instead.'}
            </p>
            {status?.runUrl && (
              <p style={{ textAlign: 'center', marginTop: 10 }}>
                <a href={status.runUrl} target="_blank" rel="noopener" style={{ color: 'var(--rose-deep)', fontSize: 12 }}>See details on GitHub →</a>
              </p>
            )}
            <div className="drawer__actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn--ghost" onClick={onCancel}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RecentPublishesModal({ publishes, onClose, onRevert }) {
  return (
    <div className="drawer-bg" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h2>Recent publishes</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
          Last 10 things you've published. Hit <strong>Undo</strong> to revert one back to how it was.
        </p>
        {publishes.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13, fontStyle: 'italic' }}>Nothing yet.</p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {publishes.map((p, i) => (
            <li key={i} style={{ padding: '12px 0', borderTop: i ? '1px solid var(--line)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{p.message || 'helen edits'}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>
                  {new Date(p.at).toLocaleString()} · {p.edits || 0} edit{p.edits === 1 ? '' : 's'}
                  {p.newPages > 0 && <> · {p.newPages} new page{p.newPages === 1 ? '' : 's'}</>}
                </div>
              </div>
              <button className="btn btn--ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => onRevert(p)} title="Revert this publish">
                Undo
              </button>
            </li>
          ))}
        </ul>
        <div className="drawer__actions">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Tiny modal that edits ONLY menu placement (section + subtitle) on an
// existing draft new page. Used to retrofit pages that were created
// before NewPageModal grew the section dropdown — Helen sets where the
// page goes in the menu without losing any text or photo edits she's
// already made on it.
function EditNavPlacementModal({ page, onCancel, onSave }) {
  const [section, setSection] = useState(page?.section || 'cakes');
  const [note, setNote] = useState(page?.note || '');
  if (!page) return null;
  return (
    <div className="drawer-bg" onClick={onCancel}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h2>Menu placement</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' }}>
          Where should <strong>{page.label}</strong> appear in the site menu? You can change this any time before publishing.
        </p>
        <div className="field">
          <label className="field__label">Add to menu under</label>
          <select value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="cakes">Cakes</option>
            <option value="weddings">Weddings</option>
            <option value="bakes">Bakes</option>
            <option value="">— Don't add to menu —</option>
          </select>
          <div className="field__hint">Also adds a card to the homepage when you publish.</div>
        </div>
        <div className="field">
          <label className="field__label">Subtitle in menu (optional)</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Two-tier · celebration" />
          <div className="field__hint">The small grey line under the page name in the dropdown. Leave blank for a clean entry.</div>
        </div>
        <div className="drawer__actions">
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={() => onSave(page.id, section, note)}>Save</button>
        </div>
      </div>
    </div>
  );
}
