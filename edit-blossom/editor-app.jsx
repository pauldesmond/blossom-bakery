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
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { edits: {}, images: {}, pageStatus: {}, site: {}, newPages: [] }; }
  catch { return { edits: {}, images: {}, pageStatus: {}, site: {}, newPages: [] }; }
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

  function createNewPage({ label, slug, templateId }) {
    const tpl = PAGES.find(p => p.id === templateId);
    if (!tpl) { toast('Pick a template', 'error'); return; }
    const id = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) { toast('Need a URL slug', 'error'); return; }
    if (ALL_PAGES.some(p => p.id === id)) { toast('A page with that URL already exists', 'error'); return; }
    const newPage = {
      id, file: id + '.html', label: label.trim() || id, template: templateId,
      published: false, draftNew: true,
    };
    setDraft(d => ({ ...d, newPages: [...(d.newPages || []), newPage] }));
    setActivePageId(id);
    setShowNewPage(false);
    toast('New page added to draft — edit away', 'success');
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
                    <button
                      className="page-item__toggle"
                      title="Remove this draft page"
                      onClick={(e) => { e.stopPropagation(); removeDraftNewPage(p.id); }}
                    >Remove</button>
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

      {/* New page modal */}
      {showNewPage && <NewPageModal pages={PAGES} onCancel={() => setShowNewPage(false)} onCreate={createNewPage} />}

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

function NewPageModal({ pages, onCancel, onCreate }) {
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [templateId, setTemplateId] = useState(pages[0]?.id || '');
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
        <div className="drawer__actions">
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" disabled={!label.trim() || !effectiveSlug} onClick={() => onCreate({ label, slug: effectiveSlug, templateId })}>Create draft page</button>
        </div>
      </div>
    </div>
  );
}
