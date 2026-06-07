// Lazyanto — Meta Business Suite post tagger + CSV exporter

const LABELS = ['Kamikaze', 'Tiradera', 'XD'];
const ATTR   = 'data-lzy';
let state    = {};  // { [id]: { id, title, img, contentId, checked, label } }
let debounce = null;
let cachedParams = null; // { businessId, assetId }
let scraping = false;

// ─── Stable hash ID ──────────────────────────────────────────────────────────
function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return 'lzy' + Math.abs(h).toString(36);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Extract content_id from row's DOM / React fiber ──────────────────────────
function extractContentIdFromString(value) {
  const s = String(value);
  const patterns = [
    /TofuUnifiedTableRow:(\d{5,}):fields/,
    /[?&]content_id=(\d{5,})/,
    /[?&]post_id=(\d{5,})/,
    /[?&]video_id=(\d{5,})/,
    /[?&]photo_id=(\d{5,})/,
    /[?&]story_fbid=(\d{5,})/,
    /content_id["'\\:=\s]+(\d{5,})/i,
    /contentId["'\\:=\s]+(\d{5,})/i,
    /contentID["'\\:=\s]+(\d{5,})/i,
    /post_id["'\\:=\s]+(\d{5,})/i,
    /video_id["'\\:=\s]+(\d{5,})/i,
    /photo_id["'\\:=\s]+(\d{5,})/i,
    /story_fbid["'\\:=\s]+(\d{5,})/i,
    /content_id%22%3A%22?(\d{5,})/i,
    /post_id%22%3A%22?(\d{5,})/i,
    /video_id%22%3A%22?(\d{5,})/i,
    /photo_id%22%3A%22?(\d{5,})/i,
    /story_fbid%22%3A%22?(\d{5,})/i
  ];

  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function getContentIdFromDom(row) {
  const nodes = [row, ...row.querySelectorAll('a[href], [href], [data-store], [data-ft], [data-hovercard], [aria-label], [id]')];

  for (const node of nodes) {
    const names = node.getAttributeNames?.() || [];
    for (const name of names) {
      const found = extractContentIdFromString(node.getAttribute(name) || '');
      if (found) return found;
    }
  }

  return null;
}

function getContentIdFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.pathname.includes('/object_insights/')) return null;
    return url.searchParams.get('content_id');
  } catch (e) {
    return null;
  }
}

function getReactPayloads(row) {
  const elements = [
    row,
    ...row.querySelectorAll('*'),
    row.parentElement,
    row.parentElement?.parentElement
  ].filter(Boolean);

  const payloads = [];
  elements.forEach(el => {
    Object.keys(el).forEach(k => {
      if (
        k.startsWith('__reactFiber') ||
        k.startsWith('__reactInternals') ||
        k.startsWith('__reactInternalInstance') ||
        k.startsWith('__reactProps')
      ) {
        payloads.push(el[k]);
      }
    });
  });
  return payloads;
}

function getContentId(row) {
  const domId = getContentIdFromDom(row);
  if (domId) return domId;

  const urlId = getContentIdFromUrl();
  if (urlId) return urlId;

  const payloads = getReactPayloads(row);
  if (!payloads.length) return null;

  let found = null;
  const isDomObject = (value) =>
    value === window ||
    value === document ||
    (typeof Node !== 'undefined' && value instanceof Node);

  const scanPayload = (payload) => {
    const seen = new WeakSet();
    let steps = 0;

    const walk = (value, depth) => {
      if (found || value == null || depth > 45 || steps > 12000) return;
      steps += 1;

      if (typeof value === 'string') {
        found = extractContentIdFromString(value);
        return;
      }

      if (typeof value !== 'object' || isDomObject(value) || seen.has(value)) return;
      seen.add(value);

      let keys;
      try { keys = Object.keys(value); } catch (e) { return; }

      for (const k of keys) {
        if (found) return;
        let v;
        try { v = value[k]; } catch (e) { continue; }

        if (/^content[_-]?id$/i.test(k) && typeof v !== 'object') {
          const id = String(v).match(/\d{5,}/)?.[0];
          if (id) { found = id; return; }
        }

        if (typeof v === 'string') {
          found = extractContentIdFromString(v);
          if (found) return;
        }
      }

      const priority = [
        'memoizedProps', 'pendingProps', 'return', 'child', 'sibling',
        'alternate', 'memoizedState', 'stateNode'
      ];

      for (const k of priority) {
        if (found || !(k in value)) continue;
        try { walk(value[k], depth + 1); } catch (e) {}
      }

      for (const k of keys) {
        if (found) return;
        let v;
        try { v = value[k]; } catch (e) { continue; }
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };

    try { walk(payload, 0); } catch (e) {}
  };

  for (const payload of payloads) {
    scanPayload(payload);
    if (found) break;
  }
  return found;
}

function refreshMissingContentIds(posts) {
  posts.forEach(post => {
    if (post.contentId) return;
    const row = document.querySelector(`[${ATTR}="${post.id}"]`);
    const contentId = row ? getContentId(row) : null;
    if (contentId) post.contentId = contentId;
  });
}

function retryMissingContentIds() {
  Object.values(state).forEach(post => {
    if (!post.checked && post.contentId) return;
    if (post.contentId) return;

    const row = document.querySelector(`[${ATTR}="${post.id}"]`);
    const contentId = row ? getContentId(row) : null;
    if (contentId) post.contentId = contentId;
  });
}

// ─── Read businessId / assetId from current URL ───────────────────────────────
function readUrlParams() {
  try {
    const url = new URL(window.location.href);
    const b = url.searchParams.get('business_id');
    const a = url.searchParams.get('asset_id');
    if (b && a) cachedParams = { businessId: b, assetId: a };
  } catch (e) {}
  return cachedParams;
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function injectPanel() {
  if (document.getElementById('lzy-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'lzy-panel';
  panel.innerHTML = `
    <div id="lzy-hdr">
      <button id="lzy-toggle" title="Colapsar / Expandir">◀</button>
      <span id="lzy-ttl">🎯 Lazyanto</span>
      <span id="lzy-cnt" class="lzy-badge" style="display:none"></span>
      <button id="lzy-clear" title="Quitar selección de todos">✕</button>
    </div>
    <div id="lzy-body">
      <p id="lzy-empty">Selecciona publicaciones<br>con los checkboxes</p>
      <div id="lzy-list"></div>
      <div id="lzy-footer" style="display:none">
        <div id="lzy-progress" style="display:none">
          <div id="lzy-progress-bar"><div id="lzy-progress-fill"></div></div>
          <span id="lzy-progress-txt">Extrayendo datos…</span>
        </div>
        <button id="lzy-export">⬇ Exportar CSV</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('lzy-toggle').addEventListener('click', () => {
    panel.classList.toggle('lzy-mini');
    document.getElementById('lzy-toggle').textContent =
      panel.classList.contains('lzy-mini') ? '▶' : '◀';
  });

  document.getElementById('lzy-clear').addEventListener('click', clearAll);
  document.getElementById('lzy-export').addEventListener('click', startExport);
}

function clearAll() {
  Object.keys(state).forEach(id => {
    state[id].checked = false;
    state[id].label   = '';
    const row = document.querySelector(`[${ATTR}="${id}"]`);
    if (!row) return;
    const chk = row.querySelector('.lzy-chk');
    const sel = row.querySelector('.lzy-sel');
    if (chk) chk.checked = false;
    if (sel) sel.value   = '';
    updateRowTag(row, id);
  });
  renderPanel();
  saveState();
}

// ─── Export flow ──────────────────────────────────────────────────────────────
async function startExport() {
  if (scraping) return;

  const selected = Object.values(state).filter(p => p.checked);
  if (!selected.length) return;

  refreshMissingContentIds(selected);
  await saveState();

  const missing = selected.filter(p => !p.contentId);
  if (missing.length) {
    alert(`${missing.length} publicación(es) no tienen ID detectado (recarga la página y vuelve a seleccionarlas).`);
    return;
  }

  const params = readUrlParams();
  if (!params) {
    alert('No se pudo detectar business_id / asset_id. Asegúrate de estar en la página de contenido de Meta Business Suite.');
    return;
  }

  scraping = true;
  setExportUI('loading', 0, selected.length);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'lzy:scrape',
      posts: selected.map(p => ({ id: p.id, title: p.title, img: p.img, contentId: p.contentId, label: p.label })),
      businessId: params.businessId,
      assetId: params.assetId
    });

    if (!response?.ok) throw new Error(response?.error || 'Error desconocido');
    downloadCSV(response.results);
  } catch (e) {
    alert('Error al exportar: ' + e.message);
  } finally {
    scraping = false;
    setExportUI('idle');
  }
}

function setExportUI(state, current, total) {
  const btn      = document.getElementById('lzy-export');
  const progress = document.getElementById('lzy-progress');
  const fill     = document.getElementById('lzy-progress-fill');
  const txt      = document.getElementById('lzy-progress-txt');
  if (!btn) return;

  if (state === 'loading') {
    btn.disabled = true;
    btn.textContent = '⏳ Extrayendo…';
    if (progress) progress.style.display = 'block';
    if (fill) fill.style.width = (current / total * 100) + '%';
    if (txt) txt.textContent = `Extrayendo datos… (${current}/${total})`;
  } else {
    btn.disabled = false;
    btn.textContent = '⬇ Exportar CSV';
    if (progress) progress.style.display = 'none';
    if (fill) fill.style.width = '0%';
  }
}

// ─── CSV generation & download ────────────────────────────────────────────────
function downloadCSV(results) {
  const headers = [
    'content_id', 'Fecha', 'Tipo', 'Texto', 'URL imagen',
    'Visualizaciones', 'Espectadores', 'Interacciones',
    'Clics enlace', 'Seguidores', 'Marcador'
  ];

  const rows = results.map(r => [
    r.contentId || '',
    r.createdAt ? new Date(r.createdAt * 1000).toISOString().slice(0, 10) : '',
    r.mediaType || '',
    r.content || r.title || '',
    r.imageUrl || r.img || '',
    r.views ?? '',
    r.viewers ?? '',
    r.interactions ?? '',
    r.linkClicks ?? '',
    r.followers ?? '',
    r.label || ''
  ]);

  const csvLines = [headers, ...rows].map(row =>
    row.map(cell => {
      const s = String(cell ?? '').replace(/"/g, '""');
      return /[,"\n\r]/.test(s) ? `"${s}"` : s;
    }).join(',')
  ).join('\n');

  const blob = new Blob(['﻿' + csvLines], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `lazyanto-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Listen for progress updates from background ──────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'lzy:progress') return;
  setExportUI('loading', msg.current, msg.total);
  const txt = document.getElementById('lzy-progress-txt');
  if (txt) txt.textContent = `(${msg.current}/${msg.total}) ${msg.title?.slice(0, 40) || ''}…`;
  const fill = document.getElementById('lzy-progress-fill');
  if (fill) fill.style.width = (msg.current / msg.total * 100) + '%';
});

// ─── Render panel list ────────────────────────────────────────────────────────
function renderPanel() {
  const list   = document.getElementById('lzy-list');
  const empty  = document.getElementById('lzy-empty');
  const cnt    = document.getElementById('lzy-cnt');
  const footer = document.getElementById('lzy-footer');
  if (!list) return;

  const selected = Object.values(state).filter(p => p.checked);

  cnt.textContent     = selected.length || '';
  cnt.style.display   = selected.length ? 'inline' : 'none';
  empty.style.display = selected.length ? 'none' : 'block';
  if (footer) footer.style.display = selected.length ? 'block' : 'none';

  list.innerHTML = selected.map(p => {
    const tagHtml = p.label
      ? `<span class="lzy-tag lzy-tag-${p.label.toLowerCase()}">${escHtml(p.label)}</span>`
      : `<span class="lzy-no-tag">Sin marcar</span>`;
    const bgStyle = p.img ? `background-image:url('${escHtml(p.img)}')` : '';
    const noId    = !p.contentId ? ' lzy-no-id' : '';
    return `
      <div class="lzy-item${noId}">
        <div class="lzy-thumb" style="${bgStyle}"></div>
        <div class="lzy-meta">
          <div class="lzy-ititle">${escHtml(p.title.slice(0, 65))}${p.title.length > 65 ? '…' : ''}</div>
          ${tagHtml}
        </div>
        <button class="lzy-rm" data-id="${escHtml(p.id)}" title="Quitar">×</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.lzy-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!state[id]) return;
      state[id].checked = false;
      state[id].label   = '';
      const row = document.querySelector(`[${ATTR}="${id}"]`);
      if (row) {
        const chk = row.querySelector('.lzy-chk');
        const sel = row.querySelector('.lzy-sel');
        if (chk) chk.checked = false;
        if (sel) sel.value   = '';
        updateRowTag(row, id);
      }
      renderPanel();
      saveState();
    });
  });
}

// ─── Row tag indicator ────────────────────────────────────────────────────────
function updateRowTag(row, id) {
  const existing = row.querySelector('.lzy-row-tag');
  if (existing) existing.remove();
  const s = state[id];
  if (!s || !s.label) return;
  const tag = document.createElement('span');
  tag.className = `lzy-row-tag lzy-tag-${s.label.toLowerCase()}`;
  tag.textContent = s.label;
  const ctrl = row.querySelector('.lzy-ctrl');
  if (ctrl) ctrl.appendChild(tag);
}

// ─── Find unprocessed rows ────────────────────────────────────────────────────
function findRows() {
  const rows = new Set();

  document.querySelectorAll(`[role="row"]:not([${ATTR}])`).forEach(el => {
    if (!el.querySelector('img')) return;
    const hasPromo = [...el.querySelectorAll('span')].some(
      s => s.textContent.trim() === 'Promocionar'
    );
    if (!hasPromo) return;
    rows.add(el);
  });

  if (rows.size === 0) {
    document.querySelectorAll('span').forEach(span => {
      if (span.textContent.trim() !== 'Promocionar') return;
      if (span.closest(`[${ATTR}]`)) return;
      let el = span.parentElement;
      for (let i = 0; i < 15; i++) {
        if (!el || el === document.body) break;
        if (el.hasAttribute(ATTR)) return;
        if (el.querySelector('img')) { rows.add(el); return; }
        el = el.parentElement;
      }
    });
  }

  return [...rows];
}

// ─── Process a row ────────────────────────────────────────────────────────────
function processRow(row) {
  const allSpans  = [...row.querySelectorAll('span')];
  const titleSpan = allSpans.find(s => {
    const t = s.textContent.trim();
    return (
      t.length > 20 &&
      !s.children.length &&
      t !== 'Promocionar' &&
      !t.includes('•') &&
      !/^\d+$/.test(t)
    );
  });

  const title     = (titleSpan?.textContent.trim() || row.textContent.trim().slice(0, 60)) || 'Post';
  const img       = row.querySelector('img')?.src || '';
  const contentId = getContentId(row);
  const fallbackId = hashId(title.slice(0, 50));
  const id        = contentId ? `lzy-content-${contentId}` : fallbackId;

  row.setAttribute(ATTR, id);

  if (id !== fallbackId && state[fallbackId]) {
    state[id] = {
      ...state[fallbackId],
      id,
      title: title || state[fallbackId].title,
      img: img || state[fallbackId].img,
      contentId
    };
    delete state[fallbackId];
  }

  if (!state[id]) {
    state[id] = { id, title, img, contentId: contentId || '', checked: false, label: '' };
  } else {
    if (img) state[id].img = img;
    if (title) state[id].title = title;
    if (contentId && !state[id].contentId) state[id].contentId = contentId;
  }

  const s = state[id];

  const ctrl = document.createElement('div');
  ctrl.className = 'lzy-ctrl';
  ctrl.innerHTML = `
    <input type="checkbox" class="lzy-chk" ${s.checked ? 'checked' : ''} title="Seleccionar publicación">
    <select class="lzy-sel" title="Asignar marcador">
      <option value="">Marcar…</option>
      ${LABELS.map(l =>
        `<option value="${l}"${s.label === l ? ' selected' : ''}>${l}</option>`
      ).join('')}
    </select>
    ${s.label ? `<span class="lzy-row-tag lzy-tag-${s.label.toLowerCase()}">${escHtml(s.label)}</span>` : ''}
  `;

  ctrl.addEventListener('click', e => e.stopPropagation());
  row.appendChild(ctrl);
  injectTableSpacing(row);

  ctrl.querySelector('.lzy-chk').addEventListener('change', e => {
    state[id].checked = e.target.checked;
    if (!e.target.checked) {
      state[id].label = '';
      ctrl.querySelector('.lzy-sel').value = '';
    }
    updateRowTag(row, id);
    renderPanel();
    saveState();
  });

  ctrl.querySelector('.lzy-sel').addEventListener('change', e => {
    state[id].label = e.target.value;
    if (e.target.value) {
      state[id].checked = true;
      ctrl.querySelector('.lzy-chk').checked = true;
    }
    updateRowTag(row, id);
    renderPanel();
    saveState();
  });
}

// ─── Espaciado de tabla ───────────────────────────────────────────────────────
let tableSpaced = false;
function injectTableSpacing(row) {
  if (tableSpaced) return;
  let el = row.parentElement;
  for (let i = 0; i < 8; i++) {
    if (!el || el === document.body) break;
    const role = el.getAttribute('role');
    if (role === 'rowgroup' || role === 'grid' || role === 'table' || role === 'list') {
      el.style.paddingLeft = '112px';
      tableSpaced = true;
      return;
    }
    el = el.parentElement;
  }
  if (row.parentElement && row.parentElement !== document.body) {
    row.parentElement.style.paddingLeft = '112px';
    tableSpaced = true;
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function saveState() {
  await chrome.storage.local.set({ lzy: state });
}

async function loadState() {
  const { lzy } = await chrome.storage.local.get('lzy');
  state = lzy || {};
}

// ─── Scan & observe ───────────────────────────────────────────────────────────
function scan() {
  readUrlParams();
  findRows().forEach(processRow);
  retryMissingContentIds();
  renderPanel();
}

const observer = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(scan, 350);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadState();
  injectPanel();
  scan();
  observer.observe(document.body, { childList: true, subtree: true });
}

init();
