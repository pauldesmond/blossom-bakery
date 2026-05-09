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
// Editor lives at /edit-blossom/editor.html; the live site is one level up
// so iframe srcs need '../' to escape the editor folder.
const BASE_PATH = '../';

// CSS injected into the iframe so editing UI is unambiguous.
// The live site's chrome is already well-proportioned — leave it alone.
const IFRAME_CSS = `
  /* Soften any hover transitions that fight the editor's outline */
  *:focus-within { outline: none !important; }
  /* Make sure long content can scroll without clipping inside the editor stage */
  html, body { overflow-x: hidden; }
`;

// ──────────────────────────────────────────────────────────────────
// Draft store — localStorage persistence
// ──────────────────────────────────────────────────────────────────
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { edits: {}, images: {}, pageStatus: {}, site: {} }; }
  catch { return { edits: {}, images: {}, pageStatus: {}, site: {} }; }
}
function saveDraft(d) { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }

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

  const SELECTORS = 'h1, h2, h3, h4, p, li, span:not(:has(*)), a:not(:has(img)), small, em, strong, button, blockquote';

  function isEditable(el) {
    if (!el || el.closest('[data-edit-skip]')) return false;
    // Don't allow editing structural chrome — header, footer, nav, dropdowns, lightboxes
    if (el.closest('header.site-header, footer.site-footer, .site-dropdown, .mega, .lb, nav, [data-mega], [data-mega-panel]')) return false;
    return el.matches(SELECTORS);
  }

  function applyEdits(edits) {
    Object.entries(edits || {}).forEach(([sel, val]) => {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent !== val) el.textContent = val;
      } catch(e) {}
    });
  }

  function applyImages(images) {
    Object.entries(images || {}).forEach(([oldSrc, newSrc]) => {
      document.querySelectorAll('img').forEach(img => {
        const cur = img.getAttribute('src');
        if (cur && (cur === oldSrc || cur.endsWith('/' + oldSrc))) {
          img.setAttribute('src', newSrc);
        }
      });
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
    if (!isEditable(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const sel = pathFor(el);
    const original = el.textContent;
    el.contentEditable = 'true';
    el.style.outline = '2px solid #b56a78';
    el.style.outlineOffset = '2px';
    el.style.background = 'rgba(245,219,217,.6)';
    el.focus();
    // Select all
    const range = document.createRange();
    range.selectNodeContents(el);
    const ssel = window.getSelection();
    ssel.removeAllRanges();
    ssel.addRange(range);
    window.parent.postMessage({ type: 'edit-start', selector: sel, original }, '*');

    function commit() {
      const next = el.textContent;
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
      if (ev.key === 'Escape') { el.textContent = original; el.blur(); }
    }
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', onKey);
  }, true);

  window.__applyDraft = function(draft) {
    applyEdits(draft.edits);
    applyImages(draft.images);
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

  const activePage = PAGES.find(p => p.id === activePageId);
  const pageEdits = draft.edits[activePageId] || {};
  const pageImages = draft.images || {};
  const totalEditsCount = Object.values(draft.edits).reduce((s, e) => s + Object.keys(e).length, 0)
    + Object.keys(draft.images || {}).length;

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
        if (win && win.__applyDraft) win.__applyDraft({ edits: pageEdits, images: pageImages });
      }
      if (m.type === 'edit-start') {
        setSelection({ type: 'text', selector: m.selector, value: m.original });
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
  function applyImageSwap(file) {
    if (!file || !imageEdit) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDraft(d => ({ ...d, images: { ...d.images, [imageEdit.src]: reader.result } }));
      toast('Image swapped (draft)', 'success');
      setImageEdit(null);
      // Force iframe reload to apply
      const win = iframeRef.current?.contentWindow;
      if (win && win.__applyDraft) win.__applyDraft({ edits: pageEdits, images: { ...pageImages, [imageEdit.src]: reader.result } });
    };
    reader.readAsDataURL(file);
  }

  function clearAllDrafts() {
    if (!confirm('Discard all draft edits? This cannot be undone.')) return;
    setDraft({ edits: {}, images: {}, pageStatus: {}, site: {} });
    const win = iframeRef.current?.contentWindow;
    if (win) win.location.reload();
    toast('Drafts cleared', 'success');
  }

  function exportDraft() {
    const payload = {
      _meta: { exportedAt: new Date().toISOString(), version: 1 },
      edits: draft.edits,
      pageStatus: draft.pageStatus,
      site: draft.site,
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
        <button className="btn btn--ghost" onClick={clearAllDrafts}>Discard drafts</button>
        <button className="btn btn--primary" onClick={() => setShowExport(true)} disabled={!totalEditsCount}>
          Save draft for review
        </button>
      </div>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar__section">
          <div className="sidebar__title">Pages</div>
          <ul className="page-list">
            {PAGES.map(p => {
              const published = draft.pageStatus[p.id] !== undefined ? draft.pageStatus[p.id] : p.published;
              return (
                <li
                  key={p.id}
                  className={'page-item' + (p.id === activePageId ? ' active' : '') + (!published ? ' unpublished' : '')}
                  onClick={() => setActivePageId(p.id)}
                >
                  <span className="page-item__icon"></span>
                  <span className="page-item__name">{p.label}</span>
                  <button
                    className="page-item__toggle"
                    title={published ? 'Hide page' : 'Show page'}
                    onClick={(e) => { e.stopPropagation(); togglePagePublished(p.id); }}
                  >
                    {published ? 'Hide' : 'Show'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Stage */}
      <div className="stage editing">
        <div className="stage__device" ref={deviceRef}>
          <div className="stage__scaler" ref={scalerRef}>
            <iframe
              ref={iframeRef}
              className="stage__frame"
              src={BASE_PATH + (activePage?.file || 'index.html')}
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
                    if (el) el.textContent = v;
                  } catch {}
                }}
              />
              <div className="field__hint">Saves to draft as you type</div>
            </div>
            <button className="btn" onClick={() => setSelection(null)}>Done</button>
          </div>
        ) : imageEdit ? (
          <div className="inspector__section">
            <h2 className="inspector__title">Swap photo</h2>
            <p className="inspector__sub">Upload a new photo to replace this one in the draft.</p>
            <img src={pageImages[imageEdit.src] || imageEdit.src} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 12 }} />
            <input type="file" accept="image/*" onChange={(e) => applyImageSwap(e.target.files[0])} />
            <div className="field__hint" style={{ marginTop: 12 }}>Tip: use a square or 4:3 photo for galleries.</div>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setImageEdit(null)}>Cancel</button>
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
            </div>
            <div className="drawer__actions">
              <button className="btn btn--ghost" onClick={() => setShowExport(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={exportDraft}>Download draft</button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
