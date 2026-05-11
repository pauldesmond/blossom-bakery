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

// Per-element background colour palette. Brand-locked rose accents +
// neutrals. Mirror this list in apply-draft.py ALLOWED_BG_COLOURS so
// the publish side accepts the same set.
const BG_COLOURS = [
  { id: 'default',   label: 'Clear',     value: null },
  { id: 'paper',     label: 'Paper',     value: '#fffdfb' },
  { id: 'cream',     label: 'Cream',     value: '#f3ece2' },
  { id: 'sand',      label: 'Sand',      value: '#e6dccf' },
  { id: 'rose-soft', label: 'Blush',     value: '#f5dbd9' },
  { id: 'rose',      label: 'Rose',      value: '#e7b6b6' },
  { id: 'rose-deep', label: 'Deep rose', value: '#b56a78' },
  { id: 'sage',      label: 'Sage',      value: '#cdd9c2' },
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
  const blank = { edits: {}, images: {}, imageDeletes: [], pageStatus: {}, site: {}, newPages: [], styles: {}, deletedPages: [] };
  try { return { ...blank, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) }; }
  catch { return blank; }
}
function saveDraft(d) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
  catch (e) {
    // Quota exceeded (e.g. accumulated photo data URLs). Drop the old
    // entry first — without this the SAME stale payload stays in storage
    // so on reopen loadDraft restores entries the user thought were
    // discarded. Then retry, and surface to the user if it still fails.
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
    } catch (e2) {
      console.warn('[Blossom] draft save failed even after clear:', e2?.message || e2);
      // Surface so the editor can show a banner — the user is editing
      // against a draft that won't survive the next page reload.
      try { window.dispatchEvent(new CustomEvent('blossom:save-failed', { detail: e2?.message || String(e2) })); } catch (_) {}
    }
  }
}

// When Helen swaps the same image twice before publishing, the second
// swap's targetSrc is the FIRST swap's preview value (a data: URL or an
// uploaded newSrc string) — not the original image src that's actually
// in the live HTML. Recording the second swap keyed by the preview src
// produces an entry the publish pipeline can't apply: apply-draft.py
// skips data:URL keys outright, and newSrc-keyed entries don't match
// anything in the rendered HTML. Result: the second swap silently
// drops on publish and Helen's "latest" photo never lands.
//
// resolveImageDraftRoot walks back up the chain — whichever current
// draft.images value matches `src`, follow its key, then check if that
// key is itself the value of another entry, and so on — to find the
// ORIGINAL source path that's in the live HTML. The visited-set guard
// keeps cyclic data safe; in practice the chain is one or two hops.
function resolveImageDraftRoot(src, images) {
  let cur = src;
  const seen = new Set();
  while (typeof cur === 'string' && cur && !seen.has(cur)) {
    seen.add(cur);
    const parent = Object.entries(images || {}).find(([, val]) => {
      if (typeof val === 'string') return val === cur;
      return val && typeof val === 'object' && val.dataUrl === cur;
    })?.[0];
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

// Rebuild draft.images so every key is the chain-root (original src).
// Idempotent: keys that are already roots pass through unchanged.
function normaliseImageDrafts(images) {
  const next = {};
  for (const [src, val] of Object.entries(images || {})) {
    const root = resolveImageDraftRoot(src, images);
    next[root] = val;
  }
  return next;
}

// Page-scoped swap/delete keying.
//
// Background: previously draft.images was {rawSrc → val} and imageDeletes
// was [rawSrc, …]. When Helen duplicates a page (template + new ID) the
// two pages share the same image srcs, so a delete keyed by rawSrc on
// the duplicate also stripped the photo from the template. Fix: prefix
// the storage key with the page id so each page has its own swap/delete
// namespace.
//
// New shape:
//   draft.images        = { "<pageId>:<rawSrc>" → val }
//   draft.imageDeletes  = [ "<pageId>:<rawSrc>", … ]
//
// Backward compat: entries written by older builds had no prefix (the
// key began with "images/" or "data:"). parseImageKey returns pageId
// = null for those; apply-draft.py applies them globally just like
// today. Helen's in-flight iPad draft survives without surgery.
function parseImageKey(key) {
  if (typeof key !== 'string') return [null, key];
  if (key.startsWith('images/') || key.startsWith('data:')) return [null, key];
  const idx = key.indexOf(':');
  if (idx === -1) return [null, key];
  const head = key.slice(0, idx);
  if (!/^[a-z0-9-]+$/i.test(head)) return [null, key];
  return [head, key.slice(idx + 1)];
}
function imageKey(pageId, rawSrc) {
  return pageId + ':' + rawSrc;
}
function getPageImages(allImages, pageId) {
  const out = {};
  for (const [k, v] of Object.entries(allImages || {})) {
    const [pid, src] = parseImageKey(k);
    if (pid === pageId || pid === null) out[src] = v;
  }
  return out;
}
function getPageDeletes(allDeletes, pageId) {
  const out = [];
  for (const k of (allDeletes || [])) {
    const [pid, src] = parseImageKey(k);
    if (pid === pageId || pid === null) out.push(src);
  }
  return out;
}
// Merge a page-scoped {rawSrc → val} map back into the global draft.images.
// Drops any prior entry for this page (prefixed) plus any legacy unprefixed
// entry whose rawSrc is being re-written, then re-prefixes the new entries.
function setPageImages(allImages, pageId, pageImages) {
  const pageSrcs = new Set(Object.keys(pageImages));
  const others = Object.fromEntries(
    Object.entries(allImages || {}).filter(([k]) => {
      const [pid, src] = parseImageKey(k);
      if (pid === pageId) return false;
      if (pid === null && pageSrcs.has(src)) return false;
      return true;
    })
  );
  return {
    ...others,
    ...Object.fromEntries(
      Object.entries(pageImages).map(([src, val]) => [imageKey(pageId, src), val])
    ),
  };
}
function setPageDeletes(allDeletes, pageId, pageDeletes) {
  const pageSrcs = new Set(pageDeletes);
  const others = (allDeletes || []).filter(k => {
    const [pid, src] = parseImageKey(k);
    if (pid === pageId) return false;
    if (pid === null && pageSrcs.has(src)) return false;
    return true;
  });
  return [...others, ...pageDeletes.map(src => imageKey(pageId, src))];
}
// Like normaliseImageDrafts but page-scoped — chain walks don't cross page
// boundaries. Called from publishNow + exportDraft so chained re-swaps on
// one page can't accidentally consolidate into another page's entry.
function normaliseImageDraftsByPage(allImages) {
  const groups = new Map();
  for (const [k, v] of Object.entries(allImages || {})) {
    const [pid, src] = parseImageKey(k);
    if (!groups.has(pid)) groups.set(pid, {});
    groups.get(pid)[src] = v;
  }
  const out = {};
  for (const [pid, pageMap] of groups.entries()) {
    const normalised = normaliseImageDrafts(pageMap);
    for (const [src, val] of Object.entries(normalised)) {
      out[pid === null ? src : imageKey(pid, src)] = val;
    }
  }
  return out;
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

  // Whitelist of inline / list / table tags Helen can produce via the
  // inspector format row (B/I/U/list/table). Anything else gets stripped
  // before commit or apply — keeps the wire format safe to hand to
  // apply-draft.py whose own sanitiser mirrors this allow-list.
  const ALLOWED_TAGS = new Set(['B','STRONG','I','EM','U','BR','UL','OL','LI','TABLE','THEAD','TBODY','TR','TH','TD','SPAN']);
  function sanitiseHTML(html) {
    const tpl = document.createElement('div');
    tpl.innerHTML = html;
    (function clean(node){
      Array.from(node.childNodes).forEach(c => {
        if (c.nodeType === 1) {
          if (!ALLOWED_TAGS.has(c.tagName)) {
            while (c.firstChild) node.insertBefore(c.firstChild, c);
            node.removeChild(c);
          } else {
            Array.from(c.attributes).forEach(a => {
              if (!((c.tagName === 'TD' || c.tagName === 'TH') && a.name === 'colspan')) {
                c.removeAttribute(a.name);
              }
            });
            clean(c);
          }
        } else if (c.nodeType === 8) {
          node.removeChild(c);
        }
      });
    })(tpl);
    return tpl.innerHTML;
  }
  function looksLikeHTML(v) {
    return typeof v === 'string' && /<\\/?[a-z][\\s\\S]*?>/i.test(v);
  }

  function applyEdits(edits) {
    Object.entries(edits || {}).forEach(([sel, val]) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return;
        if (looksLikeHTML(val)) {
          const clean = sanitiseHTML(val);
          if (el.innerHTML !== clean) el.innerHTML = clean;
        } else if (textWithBreaks(el) !== val) {
          renderText(el, val);
        }
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
    var KNOWN = { color: 'color', fontSize: 'font-size', textAlign: 'text-align', backgroundColor: 'background-color' };
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

  // Active-edit registry — shared with the parent so inspector buttons
  // (B/I/U/list/table on iPad — no Cmd shortcuts available) can re-enter
  // the same element after the iframe loses focus. selectionchange keeps
  // savedRange warm so the caret survives a tap into the inspector panel.
  let activeEdit = null; // { el, sel, originalHTML, originalText, savedRange }

  document.addEventListener('selectionchange', () => {
    if (!activeEdit) return;
    const s = document.getSelection();
    if (s && s.rangeCount && activeEdit.el.contains(s.anchorNode)) {
      activeEdit.savedRange = s.getRangeAt(0).cloneRange();
      window.parent.postMessage({
        type: 'edit-format-state',
        bold:      document.queryCommandState('bold'),
        italic:    document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        inList:    !!(s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest('ul,ol')),
      }, '*');
    }
  });

  function restoreCaret() {
    if (!activeEdit) return;
    activeEdit.el.contentEditable = 'true';
    activeEdit.el.focus();
    if (activeEdit.savedRange) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(activeEdit.savedRange);
    }
  }

  function wrapAsList(el) {
    if (!el || el.tagName === 'LI') return;
    if (el.querySelector('ul')) {
      const ul = el.querySelector('ul');
      const lines = Array.from(ul.querySelectorAll('li')).map(li => li.innerHTML).join('<br>');
      ul.outerHTML = lines;
    } else {
      const html = el.innerHTML.trim();
      const parts = html.split(/<br\\s*\\/?>(?![^<]*<\\/)/i).map(s => s.trim()).filter(Boolean);
      const lis = (parts.length ? parts : [html || '&nbsp;']).map(p => '<li>' + p + '</li>').join('');
      el.innerHTML = '<ul>' + lis + '</ul>';
    }
  }
  function insertTableCols(cols) {
    cols = Math.max(1, Math.min(3, cols | 0));
    const head = '<tr>' + Array(cols).fill(0).map((_,i)=>'<th>Heading '+(i+1)+'</th>').join('') + '</tr>';
    const body = Array(2).fill(0).map(() =>
      '<tr>' + Array(cols).fill(0).map(()=>'<td>Cell</td>').join('') + '</tr>'
    ).join('');
    document.execCommand('insertHTML', false, '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>');
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'editor-format' && activeEdit) {
      restoreCaret();
      if (m.cmd === 'bulletList')       wrapAsList(activeEdit.el);
      else if (m.cmd === 'insertTable') insertTableCols(m.value | 0);
      else                              document.execCommand(m.cmd, false, m.value || null);
      const s2 = window.getSelection();
      if (s2.rangeCount) activeEdit.savedRange = s2.getRangeAt(0).cloneRange();
    }
    if (m.type === 'editor-commit' && activeEdit) {
      const el = activeEdit.el;
      const sanitised = sanitiseHTML(el.innerHTML);
      const hasTags = /<[a-z]/i.test(sanitised);
      const payload = hasTags ? sanitised : textWithBreaks(el);
      if (payload !== activeEdit.originalText && payload !== activeEdit.originalHTML) {
        window.parent.postMessage({
          type: 'edit-commit', selector: activeEdit.sel,
          original: activeEdit.originalText, next: payload,
        }, '*');
      }
      el.contentEditable = 'false';
      el.style.outline = '';
      el.style.background = '';
      activeEdit = null;
      window.parent.postMessage({ type: 'edit-end' }, '*');
    }
    if (m.type === 'editor-cancel' && activeEdit) {
      activeEdit.el.innerHTML = activeEdit.originalHTML;
      activeEdit.el.contentEditable = 'false';
      activeEdit.el.style.outline = '';
      activeEdit.el.style.background = '';
      activeEdit = null;
      window.parent.postMessage({ type: 'edit-end' }, '*');
    }
  });

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
    const originalHTML = el.innerHTML;
    const originalText = textWithBreaks(el);
    el.contentEditable = 'true';
    el.style.outline = '2px solid #b56a78';
    el.style.outlineOffset = '2px';
    el.style.background = 'rgba(245,219,217,.6)';
    el.focus();
    // Place caret at the click position so Helen can insert text where
    // she clicked. Falls back to end-of-text on browsers without
    // caretRangeFromPoint (uncommon).
    let savedRange = null;
    try {
      const range = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : null;
      if (range) {
        const ssel = window.getSelection();
        ssel.removeAllRanges();
        ssel.addRange(range);
        savedRange = range.cloneRange();
      }
    } catch (_e) {}
    // Register the live edit so the inspector's B/I/U/Done/Cancel buttons
    // can target it. Auto-commit on blur is gone — Helen now commits via
    // an explicit Done button. This is the right pattern for iPad where
    // tapping the inspector blurs the iframe; we'd otherwise commit on
    // every inspector tap.
    activeEdit = { el, sel, originalHTML, originalText, savedRange };
    // Send the tag name so the parent inspector can decide whether
    // block-level format buttons (List, Table) make sense for this
    // element. <ul> inside <h1> or <table> inside <a> is invalid HTML
    // — the browser reparses it unpredictably. We restrict block
    // commands to elements that can legally hold flow content.
    window.parent.postMessage({
      type: 'edit-start',
      selector: sel,
      original: originalText,
      tagName: el.tagName,
    }, '*');

    function onKey(ev) {
      if (ev.key === 'Escape') {
        el.innerHTML = originalHTML;
        el.contentEditable = 'false';
        el.style.outline = '';
        el.style.background = '';
        activeEdit = null;
        window.parent.postMessage({ type: 'edit-end' }, '*');
        el.removeEventListener('keydown', onKey);
      }
    }
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
  // Cache-bust suffix for the iframe src. Initialised at app mount so
  // every editor session loads pages fresh from the CDN (rather than
  // serving Safari's cached version of the page from earlier in the day,
  // which made the preview lag behind reality after publishes). Bumped
  // again on publish-done so the post-publish reload refetches.
  const [iframeBust, setIframeBust] = useState(() => Date.now());
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
  const pageImages = getPageImages(draft.images || {}, activePageId);
  const pageImageDeletes = getPageDeletes(draft.imageDeletes || [], activePageId);
  const totalEditsCount = Object.values(draft.edits).reduce((s, e) => s + Object.keys(e).length, 0)
    + Object.keys(draft.images || {}).length
    + Object.values(draft.styles || {}).reduce((s, e) => s + Object.keys(e).length, 0)
    + (draft.deletedPages || []).length
    + (draft.newPages || []).length;
  const pageStyles = (draft.styles || {})[activePageId] || {};

  // Fine-tune font size in 1px steps. Reads the live computed size from
  // the iframe so the first press nudges from wherever the element
  // actually sits (preset, inherited, whatever) rather than snapping to
  // a preset bucket. Clamped to 8–160px so a stuck-on button can't push
  // the element to absurd extremes; matches the publish-side allow-list
  // in apply-draft.py.
  function stepFontSize(direction) {
    if (!selection || selection.type !== 'text') return;
    const cur = selection.fontSize || null;
    let basePx = null;
    if (cur && /^\d+(\.\d+)?px$/.test(cur)) {
      basePx = parseFloat(cur);
    } else {
      try {
        const el = iframeRef.current.contentDocument.querySelector(selection.selector);
        if (el) {
          const cs = iframeRef.current.contentWindow.getComputedStyle(el);
          basePx = parseFloat(cs.fontSize);
        }
      } catch {}
    }
    if (!basePx || Number.isNaN(basePx)) basePx = 16;
    const next = Math.max(8, Math.min(160, Math.round(basePx + direction)));
    setSelectionStyle('fontSize', next + 'px');
  }

  // Send a format command to the active edit inside the iframe. Used by
  // the inspector B/I/U/list/table buttons — Helen on iPad has no Cmd
  // keyboard shortcut, so all formatting routes through here. The iframe
  // restores the saved caret range before running execCommand so the
  // tap-into-inspector → tap-back-to-iframe round-trip doesn't lose the
  // selection.
  function sendFormat(cmd, value) {
    iframeRef.current?.contentWindow?.postMessage({ type: 'editor-format', cmd, value }, '*');
  }
  function commitActiveEdit() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'editor-commit' }, '*');
  }
  function cancelActiveEdit() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'editor-cancel' }, '*');
  }

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
        if (win && win.__applyDraft) win.__applyDraft({ edits: pageEdits, images: pageImages, imageDeletes: pageImageDeletes, styles: pageStyles });
      }
      if (m.type === 'edit-start') {
        const existing = (draft.styles?.[activePageId] || {})[m.selector] || {};
        // Tags that legally accept flow content (lists, tables) as
        // children. The inspector hides List/Table buttons on
        // inline-only and heading elements to avoid Helen producing
        // <h1><ul>…</ul></h1> or <a><table>…</table></a>.
        const BLOCK_CAPABLE = new Set(['DIV', 'BLOCKQUOTE', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN']);
        setSelection({
          type: 'text',
          selector: m.selector,
          value: m.original,
          tagName: m.tagName || null,
          allowBlockFormat: m.tagName ? BLOCK_CAPABLE.has(m.tagName) : false,
          color: existing.color || null,
          backgroundColor: existing.backgroundColor || null,
          fontSize: existing.fontSize || null,
          textAlign: existing.textAlign || null,
          fmt: { bold: false, italic: false, underline: false, inList: false },
        });
      }
      if (m.type === 'edit-format-state') {
        setSelection(s => s && s.type === 'text'
          ? { ...s, fmt: { bold: !!m.bold, italic: !!m.italic, underline: !!m.underline, inList: !!m.inList } }
          : s);
      }
      if (m.type === 'edit-end') {
        setSelection(null);
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

  // Hard-delete a page. Distinct from Hide (pageStatus=false) which only
  // takes a page off the nav. Delete moves the HTML into _archive/ on
  // publish and removes the page from pages.json, so the live URL 404s
  // properly. Reversible by hand (mv back out of _archive/) — no git
  // surgery needed. Index is permanently exempt; never deletable.
  function deletePage(id) {
    const page = ALL_PAGES.find(p => p.id === id);
    if (!page) return;
    const ok = confirm(
      `Delete "${page.label}"?\n\n` +
      `The page will be archived (recoverable) and removed from the menu. ` +
      `Visitors going to /${page.file} will see "page not found".\n\n` +
      `Use Hide instead if you only want to take it off the menu.`
    );
    if (!ok) return;
    setDraft(d => {
      // Brand-new page that hasn't been applied yet → just drop from newPages
      if ((d.newPages || []).some(np => np.id === id)) {
        return { ...d, newPages: d.newPages.filter(np => np.id !== id) };
      }
      const deletedPages = Array.from(new Set([...(d.deletedPages || []), id]));
      // Clear any pending edits/styles for this page so they don't get
      // applied to a file that's about to be archived.
      const { [id]: _e, ...edits } = d.edits || {};
      const { [id]: _s, ...styles } = d.styles || {};
      const images = Object.fromEntries(
        Object.entries(d.images || {}).filter(([k]) => parseImageKey(k)[0] !== id)
      );
      const imageDeletes = (d.imageDeletes || []).filter(k => parseImageKey(k)[0] !== id);
      const pageStatus = { ...(d.pageStatus || {}) };
      delete pageStatus[id];
      return { ...d, deletedPages, edits, styles, images, imageDeletes, pageStatus };
    });
    if (activePageId === id) {
      const next = ALL_PAGES.find(p => p.id !== id && p.id !== 'index');
      if (next) setActivePageId(next.id);
      else setActivePageId('index');
    }
    toast(`"${page.label}" queued for deletion`, 'warn');
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
    // 1200px instead of 1600 — gallery imgs render at ~400-600px in the
    // browser, the bigger source was overkill. Cuts dataUrl size by 40-50%
    // so the publish POST fits inside iPad Safari's fetch-body tolerance
    // (which seems to give up around 1-1.5MB on cellular/weak WiFi).
    const MAX = 1200;
    // Re-key the swap by the chain ROOT, not the current preview src.
    // Without this, swapping the same image twice (Helen edits cake A,
    // sees the preview, then re-swaps that preview to B) records the
    // second swap under the preview's data:URL — apply-draft drops
    // those silently. See resolveImageDraftRoot's commentary.
    // Resolve against THIS PAGE's swap chain — keeps duplicate pages
    // independent from their template (otherwise both pages share src
    // namespace and a swap on the duplicate also rewrites the template).
    const currentPageImages = getPageImages(draft.images || {}, activePageId);
    const targetSrc = resolveImageDraftRoot(imageEdit.src, currentPageImages);
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
          dataUrl = canvas.toDataURL('image/jpeg', 0.78);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } catch (innerErr) {
        URL.revokeObjectURL(blobUrl);
        throw innerErr;
      }
      // Normalise THIS PAGE's existing entries by their chain root BEFORE
      // merging the new swap. Catches any stale chained-preview keys from
      // older drafts so the new entry replaces the right one, and drops
      // orphaned chain links the publish couldn't apply anyway.
      const nextPageImages = {
        ...Object.fromEntries(
          Object.entries(normaliseImageDrafts(currentPageImages)).filter(([k]) => k !== targetSrc)
        ),
        [targetSrc]: dataUrl,
      };
      const nextImages = setPageImages(draft.images || {}, activePageId, nextPageImages);
      setDraft(d => ({ ...d, images: nextImages }));
      toast('Photo swapped (draft)', 'success');
      const win = iframeRef.current?.contentWindow;
      if (win && win.__applyDraft) {
        win.__applyDraft({ edits: pageEdits, images: nextPageImages, imageDeletes: pageImageDeletes, styles: pageStyles });
      }
    } catch (err) {
      console.error('[Blossom] image swap failed:', err);
      toast("Couldn't process that photo — try a smaller or different one", 'error');
    }
  }

  function clearAllDrafts() {
    if (!confirm('Discard all draft edits? This cannot be undone.')) return;
    // Wipe localStorage FIRST, then update React state. Belt-and-braces:
    // setDraft normally triggers saveDraft via useEffect, but if the OLD
    // payload was over the quota, the save can silently fail and leave
    // stale entries behind — so on next reload loadDraft reads them back
    // and the user thinks Discard didn't work. Explicit removeItem
    // guarantees the storage slot is empty before any retries.
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    setDraft({ edits: {}, images: {}, imageDeletes: [], pageStatus: {}, site: {}, newPages: [], styles: {}, deletedPages: [] });
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
    // Re-key the delete by the chain root within THIS page only —
    // duplicate pages share src namespace with their template, so a
    // global delete would also strip the photo from the template page.
    const currentPageImages = getPageImages(draft.images || {}, activePageId);
    const targetSrc = resolveImageDraftRoot(imageEdit.src, currentPageImages);
    const currentPageDeletes = getPageDeletes(draft.imageDeletes || [], activePageId);
    const nextPageDeletes = Array.from(new Set([...currentPageDeletes, targetSrc]));
    const nextDeletes = setPageDeletes(draft.imageDeletes || [], activePageId, nextPageDeletes);
    // If there was a pending swap on this src, drop it — delete supersedes.
    const nextPageImages = Object.fromEntries(
      Object.entries(normaliseImageDrafts(currentPageImages)).filter(([k]) => k !== targetSrc)
    );
    const nextImages = setPageImages(draft.images || {}, activePageId, nextPageImages);
    setImageEdit(null);
    setDraft(d => ({ ...d, imageDeletes: nextDeletes, images: nextImages }));
    toast('Photo removed (draft)', 'success');
    const win = iframeRef.current?.contentWindow;
    if (win && win.__applyDraft) {
      win.__applyDraft({ edits: pageEdits, images: nextPageImages, imageDeletes: nextPageDeletes, styles: pageStyles });
    }
  }

  // The deleted-photo list shows full storage keys ("<pageId>:<src>" for
  // new entries, plain "<src>" for legacy unprefixed ones); we filter the
  // global imageDeletes by exact key match so only the chosen entry is
  // restored, never another page's same-src delete.
  function restoreDeletedPhoto(entryKey) {
    setDraft(d => ({
      ...d,
      imageDeletes: (d.imageDeletes || []).filter(k => k !== entryKey),
    }));
    const win = iframeRef.current?.contentWindow;
    if (win) win.location.reload();
    toast('Photo restored — click it to swap a new one', 'success');
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
    // Per-page chain normalisation so chained re-swaps on page A don't
    // collapse into page B's entry.
    const exportImages = normaliseImageDraftsByPage(draft.images || {});
    const payload = {
      _meta: { exportedAt: new Date().toISOString(), version: 1 },
      edits: draft.edits,
      pageStatus: draft.pageStatus,
      site: draft.site,
      newPages: draft.newPages || [],
      deletedPages: draft.deletedPages || [],
      styles: draft.styles || {},
      // Images: include ref + base64 for local-only swaps, but preserve
      // already-uploaded repo paths (string values) so a failed publish
      // can still be exported and retried without losing track of the
      // replacement file that's already on disk.
      images: Object.fromEntries(
        Object.entries(exportImages).map(([oldSrc, dataUrl]) => {
          if (typeof dataUrl === 'string' && !dataUrl.startsWith('data:')) {
            return [oldSrc, dataUrl];
          }
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
  const totalImagesCount = Object.keys(normaliseImageDraftsByPage(draft.images || {})).length;
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
      // CI typically finishes 60-120s but can spike on cold-start. 5 min
      // window covers all observed runs; was 90s, which left publishes
      // hanging in 'unknown' so the draft never cleared even on success.
      if (Date.now() - start > 300_000) {
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
    let stage = 'building draft';
    try {
      // Pre-upload any photo swaps as separate small POSTs. Putting full
      // photo dataUrls (1MB+) inside the publish payload made iPad Safari
      // throw "Load failed" reliably; per-photo uploads to /publish-draft
      // mode=upload return the new src as a tiny JSON ref. The publish
      // call itself ends up text-only and well under any size limit.
      // Normalise per-page first — collapses any chained preview-URL keys
      // back to the original src within each page, so the per-photo upload
      // loop never tries to POST a data:URL-keyed orphan that apply-draft.py
      // would skip. Per-page so the chain walk can't bleed across pages.
      const rawImages = normaliseImageDraftsByPage(draft.images || {});
      const resolvedImages = {};
      const imageEntries = Object.entries(rawImages);
      for (let i = 0; i < imageEntries.length; i++) {
        const [entryKey, val] = imageEntries[i];
        // entryKey is "<pageId>:<rawSrc>" for new entries or "<rawSrc>" for
        // legacy unprefixed ones. The upload endpoint names the new file
        // from the rawSrc only, so split here.
        const [, rawSrc] = parseImageKey(entryKey);
        // Skip chained re-swap entries (raw src is itself a data URL —
        // these can't be applied server-side, see apply-draft.py).
        if (rawSrc.startsWith('data:')) continue;
        // Already a string newSrc from a previous publish attempt? Pass through.
        if (typeof val === 'string' && !val.startsWith('data:')) {
          resolvedImages[entryKey] = val;
          continue;
        }
        // Extract the dataUrl: legacy dict format {filename, dataUrl} OR
        // plain dataUrl string (current format).
        const dataUrl = (val && typeof val === 'object') ? val.dataUrl : val;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
        stage = `uploading photo ${i + 1}/${imageEntries.length}`;
        setPublishStatus({ phase: 'sending', detail: stage });
        const upResp = await fetch(PUBLISH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, mode: 'upload', oldSrc: rawSrc, dataUrl }),
        });
        if (!upResp.ok) {
          const upData = await upResp.json().catch(() => ({}));
          throw new Error(`upload ${i + 1} failed: ${upData.error || `HTTP ${upResp.status}`}`);
        }
        const upData = await upResp.json();
        if (!upData.ok || !upData.newSrc) throw new Error(`upload ${i + 1}: no newSrc returned`);
        resolvedImages[entryKey] = upData.newSrc;
        // Persist the upload result into the draft immediately. The image
        // file has already been committed to the repo (orphan if the
        // publish call below fails); without persisting we'd re-upload it
        // under a new filename on retry, leaving stale orphans behind.
        // Now: a retry sees a string newSrc, skips the upload, and the
        // existing file is reused. Use per-page normalisation on the
        // previous value so chains stay contained within their page.
        setDraft(d => ({
          ...d,
          images: { ...normaliseImageDraftsByPage(d.images || {}), [entryKey]: upData.newSrc },
        }));
      }
      stage = 'building draft';
      const slimDraft = {
        _meta: { publishedAt: new Date().toISOString(), version: 1 },
        edits: draft.edits,
        pageStatus: draft.pageStatus,
        newPages: draft.newPages || [],
        deletedPages: draft.deletedPages || [],
        styles: draft.styles || {},
        imageDeletes: draft.imageDeletes || [],
        // Image swaps now point at already-uploaded files (string newSrc)
        // rather than inline data URLs. apply-draft.py special-cases string
        // values to skip save_image() and just rewrite refs.
        images: resolvedImages,
      };
      stage = 'serialising';
      const body = JSON.stringify({ password, message, draft: slimDraft });
      stage = 'sending request';
      const resp = await fetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      stage = 'reading response';
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
      // Surface where in the flow we blew up so on iPad (no devtools) the
      // user can read enough context to send Paul a useful message.
      const detail = err && (err.message || err.toString && err.toString()) || String(err);
      setPublishStatus({ phase: 'failed', error: `[${stage}] ${detail}` });
      try { console.error('[publishNow]', stage, err); } catch (_) {}
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
        deletedPages: [],
        styles: {},
        imageDeletes: [],
        images: {}, // image swaps now go through publish via _drafts/ staging
      }));
      // Reload iframe after a short delay so Helen sees the live result.
      // Bumping iframeBust changes both the src query string AND the React
      // key, which forces a full remount + fresh CDN fetch (no shared cache
      // key with the pre-publish view). Pages typically rebuilds in ~30-45s
      // after the publish commit lands, so 60s is the conservative window.
      setTimeout(() => setIframeBust(Date.now()), 60_000);
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
            {ALL_PAGES.filter(p => !(draft.deletedPages || []).includes(p.id)).map(p => {
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
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        className="page-item__toggle"
                        title={published ? 'Hide page' : 'Show page'}
                        onClick={(e) => { e.stopPropagation(); togglePagePublished(p.id); }}
                      >{published ? 'Hide' : 'Show'}</button>
                      {p.id !== 'index' && (
                        <button
                          className="page-item__delete"
                          title="Delete page (archives the file, removes from menu)"
                          onClick={(e) => { e.stopPropagation(); deletePage(p.id); }}
                        >Delete</button>
                      )}
                    </span>
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
              src={BASE_PATH + activeIframeFile + '?_v=' + iframeBust}
              onLoad={onIframeLoad}
              key={activePageId + '/' + iframeBust}
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
            <p className="inspector__sub">Type into the page, select text and tap a format button. Tap <strong>Done</strong> when finished.</p>
            <div className="field">
              <label className="field__label">Format</label>
              <div className="fmt-row" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.preventDefault()}>
                <button type="button" className={'fmt-btn' + (selection.fmt?.bold ? ' active' : '')} onClick={() => sendFormat('bold')} title="Bold"><b>B</b></button>
                <button type="button" className={'fmt-btn' + (selection.fmt?.italic ? ' active' : '')} onClick={() => sendFormat('italic')} title="Italic"><i>I</i></button>
                <button type="button" className={'fmt-btn' + (selection.fmt?.underline ? ' active' : '')} onClick={() => sendFormat('underline')} title="Underline"><u>U</u></button>
                <span className="fmt-sep"></span>
                <button type="button" className="fmt-btn fmt-btn--mini" onClick={() => stepFontSize(-1)} title="Smaller">A−</button>
                <button type="button" className="fmt-btn fmt-btn--mini" onClick={() => stepFontSize(1)} title="Larger">A+</button>
                {selection.allowBlockFormat && (<>
                  <span className="fmt-sep"></span>
                  <button type="button" className={'fmt-btn' + (selection.fmt?.inList ? ' active' : '')} onClick={() => sendFormat('bulletList')} title="Bullet list">• List</button>
                  <span className="fmt-sep"></span>
                  <span className="fmt-label">Table:</span>
                  <button type="button" className="fmt-btn fmt-btn--mini" onClick={() => sendFormat('insertTable', 1)} title="Insert 1-column table">1</button>
                  <button type="button" className="fmt-btn fmt-btn--mini" onClick={() => sendFormat('insertTable', 2)} title="Insert 2-column table">2</button>
                  <button type="button" className="fmt-btn fmt-btn--mini" onClick={() => sendFormat('insertTable', 3)} title="Insert 3-column table">3</button>
                </>)}
              </div>
              <div className="field__hint">Highlight text first for bold / italic / underline. {selection.allowBlockFormat ? 'Tables and lists act on the whole element.' : 'Tables and lists are only available on body text (not on headings or links).'}</div>
            </div>
            <div className="field">
              <label className="field__label">Current value</label>
              {/<\/?[a-z][\s\S]*?>/i.test(selection.value || '') ? (
                <div className="formatted-note">
                  <strong>Formatted text.</strong> Edit directly on the page — the format buttons above apply <b>bold</b>, <i>italic</i>, lists and tables to your selection.
                </div>
              ) : (
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
                        el.textContent = '';
                        v.split('\n').forEach((line, i) => {
                          if (i > 0) el.appendChild(el.ownerDocument.createElement('br'));
                          el.appendChild(el.ownerDocument.createTextNode(line));
                        });
                      }
                    } catch {}
                  }}
                />
              )}
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
              <label className="field__label">Background</label>
              <div className="colour-row">
                {BG_COLOURS.map(c => {
                  const isActive = (selection.backgroundColor || null) === c.value;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={'colour-swatch' + (isActive ? ' active' : '')}
                      onClick={() => setSelectionStyle('backgroundColor', c.value)}
                      title={c.label}
                    >
                      <span
                        className="colour-swatch__dot"
                        style={c.value
                          ? { background: c.value, border: '1px solid var(--line)' }
                          : { background: 'transparent', backgroundImage: 'linear-gradient(45deg, transparent 45%, var(--ink-soft) 45%, var(--ink-soft) 55%, transparent 55%)' }}
                      ></span>
                    </button>
                  );
                })}
              </div>
              <div className="field__hint">"Clear" removes the override.</div>
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

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--ghost" onClick={cancelActiveEdit}>Cancel</button>
              <button className="btn btn--primary" onClick={commitActiveEdit}>Done</button>
            </div>
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
              Nothing goes live until you click <em>"Publish to live"</em> in the top bar.
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
            {(draft.imageDeletes || []).length > 0 && (
              <div style={{ marginTop: 20, textAlign: 'left' }}>
                <div className="field__label">Deleted photos</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '4px 0 10px' }}>
                  These will be removed on publish. Restore one to put it back — then click it on the page to swap in a new photo.
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {(draft.imageDeletes || []).map(entryKey => {
                    const [pid, rawSrc] = parseImageKey(entryKey);
                    const pageLabel = pid
                      ? (ALL_PAGES.find(p => p.id === pid)?.label || pid)
                      : null;
                    return (
                      <li key={entryKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                        <img
                          src={'../' + rawSrc.replace(/^\.\.?\//, '')}
                          alt=""
                          style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4, background: 'var(--bg-soft)' }}
                          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                        />
                        <span style={{ flex: 1, fontSize: 11, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {rawSrc.split('/').pop()}
                          {pageLabel && <span style={{ marginLeft: 6, opacity: 0.7 }}>· {pageLabel}</span>}
                        </span>
                        <button
                          className="btn btn--ghost"
                          style={{ fontSize: 11, padding: '4px 10px' }}
                          onClick={() => restoreDeletedPhoto(entryKey)}
                        >
                          Restore
                        </button>
                      </li>
                    );
                  })}
                </ul>
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
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--line)' }}>
                  Plus <strong>{imagesCount} photo swap{imagesCount === 1 ? '' : 's'}</strong>.
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
