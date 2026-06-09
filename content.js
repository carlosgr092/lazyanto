// Lazyanto — Meta Business Suite post tagger + CSV exporter

const LABELS = ['Petición Positiva', 'Petición Kamikaze', 'Mención negativa', 'Afectación'];
const MENTION_LABEL = 'Mención negativa'; // requiere capturar el nombre de la persona mencionada
const ATTR   = 'data-lzy';

// Convierte un marcador en un sufijo de clase CSS estable (sin acentos ni espacios)
function labelClass(label) {
  return (label || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
let state    = {};  // { [id]: { id, title, img, contentId, checked, label } }
let debounce = null;
let cachedParams = null; // { businessId, assetId }
let cachedPageName = '';
let scraping = false;
let lastUrl = location.href;
let panelCollapsed = false;

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

function isBadPageName(name) {
  return /^Martin Rodriguez$/i.test(name || '');
}

function sanitizeStoredPageNames() {
  let changed = false;
  Object.values(state).forEach(post => {
    if (isBadPageName(post.pageName)) {
      post.pageName = '';
      changed = true;
    }
  });
  return changed;
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

function readPageName() {
  const fromFeedPreview = extractPageNameFromFeedPreview();
  if (fromFeedPreview) cachedPageName = fromFeedPreview;

  if (!cachedPageName) {
    const fromJson = extractPageNameFromJson();
    if (fromJson) cachedPageName = fromJson;
  }

  if (!cachedPageName) {
    const fromDom = extractPageNameFromDom();
    if (fromDom) cachedPageName = fromDom;
  }

  if (/^Martin Rodriguez$/i.test(cachedPageName)) {
    cachedPageName = '';
  }

  return cachedPageName;
}

function extractPageNameFromFeedPreview(root = document) {
  const labelRe = /^(Vista previa del feed|Feed preview)$/i;
  const bad = /^(Lazyanto|Vista previa del feed|Feed preview|Meta Business Suite|Insights|Estad[ií]sticas|Contenido|Publicaciones|Posts|Facebook|Instagram|Martin Rodriguez|Me gusta|Comentar|Compartir|Like|Comment|Share|Ver m[aá]s|See more)$/i;
  const labels = [...root.querySelectorAll('h1, h2, h3, [role="heading"], span, div')]
    .filter(el => labelRe.test((el.textContent || '').replace(/\s+/g, ' ').trim()));

  const isCandidate = (text) => {
    const name = text.replace(/\s+/g, ' ').trim();
    return (
      name.length >= 2 &&
      name.length <= 90 &&
      !bad.test(name) &&
      !/^\d/.test(name) &&
      !/[•·]/.test(name) &&
      !/^(Crear|Exportar|Agregar|Promocionar|Impulsar|Buscar|Filtrar|Ordenar|Publicado|Published|Patrocinado|Sponsored)/i.test(name)
    );
  };

  const textPartsFrom = (el) => {
    if (!document.createTreeWalker) {
      return (el.textContent || '')
        .split(/\n+/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }

    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
    return parts;
  };

  for (const label of labels) {
    let container = label.parentElement;
    for (let depth = 0; container && container !== document.body && depth < 10; depth++) {
      const lines = textPartsFrom(container);
      const labelIndex = lines.findIndex(line => labelRe.test(line));

      if (labelIndex !== -1) {
        const afterLabel = lines.slice(labelIndex + 1);
        const direct = afterLabel.find(isCandidate);
        if (direct) return direct;
      }

      container = container.parentElement;
    }
  }

  return '';
}

function extractPageNameFromJson() {
  const params = readUrlParams();
  const assetId = params?.assetId;
  const pageId = new URL(window.location.href).searchParams.get('page_id') || '';
  const scripts = [...document.querySelectorAll('script[type="application/json"]')];
  const preferredKeys = /^(page_name|asset_name|owning_page_name|business_name|page_title)$/i;
  const badNames = /^(Meta Business Suite|Insights|Estad[ií]sticas|Contenido|Publicaciones|Posts|Business portfolio|Portfolios comerciales)$/i;

  for (const script of scripts) {
    let data;
    try { data = JSON.parse(script.textContent); } catch (e) { continue; }

    let found = '';
    const seen = new WeakSet();
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj) || found) return;
      seen.add(obj);

      const idValues = ['id', 'asset_id', 'page_id', 'profile_id']
        .map(k => obj[k])
        .filter(v => v != null)
        .map(String);
      const matchesAsset = assetId && idValues.includes(String(assetId));
      const matchesPage = pageId && idValues.includes(String(pageId));

      if (obj.profile_name || obj.actor_name || obj.first_name || obj.last_name || obj.user_name || obj.display_name) {
        return;
      }

      for (const [key, value] of Object.entries(obj)) {
        if (!preferredKeys.test(key) || typeof value !== 'string') continue;
        const name = value.trim();
        if (name.length < 2 || name.length > 90 || badNames.test(name)) continue;
        if (matchesAsset || matchesPage || key !== 'name') {
          found = name;
          return;
        }
      }

      for (const value of Object.values(obj)) {
        try { walk(value); } catch (e) {}
        if (found) return;
      }
    };

    try { walk(data); } catch (e) {}
    if (found) return found;
  }

  return '';
}

function extractPageNameFromDom() {
  const bad = /^(Lazyanto|Meta Business Suite|Insights|Estad[ií]sticas|Contenido|Publicaciones|Posts|Todas las herramientas|Configuraci[oó]n|Martin Rodriguez)$/i;
  const params = readUrlParams();
  const pageId = new URL(window.location.href).searchParams.get('page_id') || '';
  const hrefHints = [
    pageId ? `[href*="page_id=${pageId}"]` : '',
    params?.assetId ? `[href*="asset_id=${params.assetId}"]` : '',
    params?.businessId ? `[href*="business_id=${params.businessId}"]` : ''
  ].filter(Boolean).join(', ');

  if (hrefHints) {
    const candidates = [...document.querySelectorAll(`main ${hrefHints}, [role="main"] ${hrefHints}`)]
      .filter(el => !el.closest('#lzy-panel, header, nav, aside'))
      .map(el => {
        const text = (el.textContent || el.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
        return text;
      })
      .filter(text =>
        text.length >= 2 &&
        text.length <= 90 &&
        !bad.test(text) &&
        !/^\d/.test(text) &&
        !/^(Crear|Exportar|Agregar|Promocionar|Impulsar|Buscar|Filtrar|Ordenar)/i.test(text)
      );

    if (candidates.length) return candidates[0];
  }

  const candidates = [...document.querySelectorAll('main h1, main h2, main [role="heading"], [role="main"] h1, [role="main"] h2, [role="main"] [role="heading"]')]
    .filter(el => !el.closest('#lzy-panel, header, nav, aside'))
    .map(el => {
      const aria = el.getAttribute?.('aria-label') || '';
      const text = el.textContent?.trim() || '';
      return (aria || text).replace(/\s+/g, ' ').trim();
    })
    .filter(text =>
      text.length >= 2 &&
      text.length <= 90 &&
      !bad.test(text) &&
      !/^\d/.test(text) &&
      !/^(Crear|Exportar|Agregar|Promocionar|Impulsar|Buscar|Filtrar|Ordenar)/i.test(text)
    );

  return candidates[0] || '';
}

function isObjectInsightsPage() {
  return !!getContentIdFromUrl();
}

function isContentListingPage() {
  try {
    const url = new URL(window.location.href);
    return url.pathname.includes('/latest/insights/content');
  } catch (e) {
    return false;
  }
}

function isSupportedPage() {
  return isObjectInsightsPage() || isContentListingPage();
}

function extractPageTitle(root = document) {
  const fromJson = getDetailEntityInfo()?.title;
  if (fromJson) return fromJson;

  const candidates = [...root.querySelectorAll('h1, h2, [role="heading"], span, div')]
    .map(el => el.textContent?.trim() || '')
    .filter(t =>
      t.length > 12 &&
      t.length < 500 &&
      !/^(Meta Business Suite|Insights|Estad[ií]sticas|Contenido)$/i.test(t)
    );

  return candidates[0] || document.title || 'Post';
}

function extractPageImage(root = document) {
  const imgs = [...root.querySelectorAll('img')]
    .filter(i =>
      i.src &&
      !i.src.includes('rsrc.php') &&
      !i.src.includes('emoji.php') &&
      (i.naturalWidth || i.width) >= 80 &&
      (i.naturalHeight || i.height) >= 80
    )
    .sort((a, b) =>
      ((b.naturalWidth || b.width) * (b.naturalHeight || b.height)) -
      ((a.naturalWidth || a.width) * (a.naturalHeight || a.height))
    );
  return imgs[0]?.src || getDetailEntityInfo()?.imageUri || '';
}

function getDetailEntityInfo() {
  const scripts = [...document.querySelectorAll('script[type="application/json"]')];

  for (const script of scripts) {
    let data;
    try { data = JSON.parse(script.textContent); } catch (e) { continue; }

    let entityInfo = null;
    const seen = new WeakSet();

    const walk = (obj) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj) || entityInfo) return;
      seen.add(obj);

      if (obj.title && (obj.image_source || obj.created_at || obj.media_type)) {
        entityInfo = {
          title: obj.title,
          imageUri: obj.image_source?.uri || '',
          createdAt: obj.created_at || null,
          mediaType: obj.media_type || ''
        };
        return;
      }

      for (const k of Object.keys(obj)) {
        try { walk(obj[k]); } catch (e) {}
        if (entityInfo) return;
      }
    };

    try { walk(data); } catch (e) {}
    if (entityInfo) return entityInfo;
  }

  return null;
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function injectPanel() {
  if (document.getElementById('lzy-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'lzy-panel';
  panel.innerHTML = `
    <div id="lzy-hdr">
      <button id="lzy-toggle" title="Ocultar panel">▶</button>
      <div id="lzy-headtext">
        <span id="lzy-ttl">🎯 Lazyanto</span>
        <span id="lzy-page" title=""></span>
      </div>
      <span id="lzy-cnt" class="lzy-badge" style="display:none"></span>
      <button id="lzy-clear" title="Quitar selección de todos">✕</button>
    </div>
    <div id="lzy-body">
      <p id="lzy-empty">Abre una publicación<br>para agregarla aquí</p>
      <button id="lzy-add-current" style="display:none">+ Agregar este contenido</button>
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

  // Pestaña flotante para reabrir el panel cuando está colapsado
  const fab = document.createElement('button');
  fab.id = 'lzy-fab';
  fab.title = 'Abrir Lazyanto';
  fab.innerHTML = `<span class="lzy-fab-cnt" style="display:none"></span><span>🎯 Lazyanto</span>`;
  document.body.appendChild(fab);

  document.getElementById('lzy-toggle').addEventListener('click', () => setCollapsed(true));
  fab.addEventListener('click', () => setCollapsed(false));

  document.getElementById('lzy-clear').addEventListener('click', clearAll);
  document.getElementById('lzy-export').addEventListener('click', startExport);
  document.getElementById('lzy-add-current').addEventListener('click', addCurrentDetailPost);

  applyCollapsed();
}

// ─── Colapsar / expandir la barra lateral ──────────────────────────────────────
function setCollapsed(collapsed) {
  panelCollapsed = collapsed;
  applyCollapsed();
  saveCollapsed();
}

function applyCollapsed() {
  const panel = document.getElementById('lzy-panel');
  const fab   = document.getElementById('lzy-fab');
  if (!panel || !fab) return;
  panel.classList.toggle('lzy-mini', panelCollapsed);
  fab.classList.toggle('lzy-fab-show', panelCollapsed);
}

function addCurrentDetailPost() {
  const contentId = getContentIdFromUrl();
  if (!contentId) return;

  const id = `lzy-content-${contentId}`;
  const title = extractPageTitle();
  const img = extractPageImage();
  const pageName = readPageName();
  const previous = state[id] || {};

  state[id] = {
    ...previous,
    id,
    title: title || previous.title || 'Post',
    img: img || previous.img || '',
    pageName: pageName || previous.pageName || '',
    contentId,
    checked: true,
    addedAt: Date.now(),
    label: previous.label || ''
  };

  renderPanel();
  saveState();
}

function updateCurrentDetailControl() {
  const btn = document.getElementById('lzy-add-current');
  if (!btn) return;

  const contentId = getContentIdFromUrl();
  btn.style.display = contentId ? 'block' : 'none';
  if (!contentId) return;

  const id = `lzy-content-${contentId}`;
  btn.textContent = state[id]?.checked ? '✓ Contenido agregado' : '+ Agregar este contenido';
}

function clearAll() {
  Object.keys(state).forEach(id => {
    state[id].checked = false;
    state[id].label   = '';
    state[id].person  = '';
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
      posts: selected.map(p => ({
        id: p.id,
        title: p.title,
        img: p.img,
        pageName: p.pageName || '',
        contentId: p.contentId,
        label: p.label,
        person: p.person || ''
      })),
      businessId: params.businessId,
      assetId: params.assetId
    });

    if (!response?.ok) throw new Error(response?.error || 'Error desconocido');
    response.results.forEach(result => {
      if (!result.id || !state[result.id] || !result.pageName) return;
      state[result.id].pageName = result.pageName;
    });
    await saveState();
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
    'Página', 'Mención', 'content_id', 'Fecha', 'Tipo', 'Texto', 'URL imagen',
    'Visualizaciones', 'Espectadores', 'Interacciones', 'Marcador'
  ];

  const rows = results.map(r => [
    r.pageName || '',
    r.person || '',
    r.contentId || '',
    r.createdAt ? new Date(r.createdAt * 1000).toISOString().slice(0, 10) : '',
    r.mediaType || '',
    r.content || r.title || '',
    r.imageUrl || r.img || '',
    r.views ?? '',
    r.viewers ?? '',
    r.interactions ?? '',
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
  const pageEl = document.getElementById('lzy-page');
  if (!list) return;

  const selected = Object.values(state)
    .filter(p => p.checked)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // último agregado arriba
  const pageName = readPageName();

  cnt.textContent     = selected.length || '';
  cnt.style.display   = selected.length ? 'inline' : 'none';
  const fabCnt = document.querySelector('#lzy-fab .lzy-fab-cnt');
  if (fabCnt) {
    fabCnt.textContent   = selected.length || '';
    fabCnt.style.display = selected.length ? 'inline-block' : 'none';
  }
  if (pageEl) {
    pageEl.textContent = pageName || 'Página no detectada';
    pageEl.title = pageName || '';
  }
  empty.style.display = selected.length ? 'none' : 'block';
  if (footer) footer.style.display = selected.length ? 'block' : 'none';
  updateCurrentDetailControl();

  list.innerHTML = selected.map(p => {
    const bgStyle = p.img ? `background-image:url('${escHtml(p.img)}')` : '';
    const noId    = !p.contentId ? ' lzy-no-id' : '';
    const itemPageName = p.pageName || 'Página no detectada';
    return `
      <div class="lzy-item${noId}">
        <div class="lzy-thumb" style="${bgStyle}"></div>
        <div class="lzy-meta">
          <div class="lzy-ititle">${escHtml(p.title.slice(0, 65))}${p.title.length > 65 ? '…' : ''}</div>
          <div class="lzy-ipage" title="${escHtml(itemPageName)}">${escHtml(itemPageName)}</div>
          <select class="lzy-panel-sel" data-id="${escHtml(p.id)}" title="Asignar marcador">
            <option value="">Sin marcador</option>
            ${LABELS.map(l =>
              `<option value="${l}"${p.label === l ? ' selected' : ''}>${l}</option>`
            ).join('')}
          </select>
          ${p.label === MENTION_LABEL ? `
          <input class="lzy-person" data-id="${escHtml(p.id)}" type="text"
                 placeholder="Persona mencionada"
                 value="${escHtml(p.person || '')}" title="Nombre de la persona mencionada">
          ` : ''}
        </div>
        <button class="lzy-rm" data-id="${escHtml(p.id)}" title="Quitar">×</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.lzy-panel-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.id;
      if (!state[id]) return;
      state[id].label = sel.value;
      if (sel.value !== MENTION_LABEL) state[id].person = '';
      if (!state[id].checked) state[id].addedAt = Date.now();
      state[id].checked = true;
      syncRowControls(id);
      renderPanel();
      saveState();
    });
  });

  list.querySelectorAll('.lzy-person').forEach(inp => {
    inp.addEventListener('input', () => {
      const id = inp.dataset.id;
      if (!state[id]) return;
      state[id].person = inp.value;
      saveState();
    });
  });

  list.querySelectorAll('.lzy-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!state[id]) return;
      state[id].checked = false;
      state[id].label   = '';
      state[id].person  = '';
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

function syncRowControls(id) {
  const row = document.querySelector(`[${ATTR}="${id}"]`);
  if (!row || !state[id]) return;
  attachRowControls(row, id);
  const ctrl = getOwnRowControl(row);
  const chk = ctrl?.querySelector('.lzy-chk');
  const sel = ctrl?.querySelector('.lzy-sel');
  if (chk) chk.checked = !!state[id].checked;
  if (sel) sel.value = state[id].label || '';
  updateRowTag(row, id);
}

// ─── Row tag indicator ────────────────────────────────────────────────────────
function updateRowTag(row, id) {
  const ctrl = getOwnRowControl(row);
  const existing = ctrl?.querySelector('.lzy-row-tag');
  if (existing) existing.remove();
  const s = state[id];
  if (!s || !s.label) return;
  const tag = document.createElement('span');
  tag.className = `lzy-row-tag lzy-tag-${labelClass(s.label)}`;
  tag.textContent = s.label;
  if (ctrl) ctrl.appendChild(tag);
}

// ─── Find unprocessed rows ────────────────────────────────────────────────────
function findRows() {
  const rows = new Set();

  const addCandidate = (el) => {
    if (!el || el === document.body || el.closest(`[${ATTR}]`) || isBlockedUiArea(el)) return;
    if (isRowCandidate(el)) rows.add(el);
  };

  document.querySelectorAll(`[role="row"]:not([${ATTR}]), [role="listitem"]:not([${ATTR}]), article:not([${ATTR}])`)
    .forEach(addCandidate);

  document.querySelectorAll('img').forEach(img => {
    if (img.closest('#lzy-panel') || img.closest(`[${ATTR}]`) || isBlockedUiArea(img)) return;
    let el = img.parentElement;
    for (let i = 0; i < 16; i++) {
      if (!el || el === document.body) break;
      if (el.closest(`[${ATTR}]`)) return;
      if (isBlockedUiArea(el)) return;
      if (isRowCandidate(el)) { rows.add(el); return; }
      el = el.parentElement;
    }
  });

  document.querySelectorAll('a[href*="content_id="], a[href*="post_id="], a[href*="video_id="], a[href*="photo_id="], a[href*="story_fbid="]')
    .forEach(link => {
      let el = link;
      for (let i = 0; i < 15; i++) {
        if (!el || el === document.body) break;
        if (el.closest(`[${ATTR}]`)) return;
        if (isBlockedUiArea(el)) return;
        if (isRowCandidate(el)) { rows.add(el); return; }
        el = el.parentElement;
      }
    });

  if (rows.size === 0) {
    const actionLabels = new Set([
      'Promocionar',
      'Impulsar',
      'Boost',
      'Boost post',
      'Ver insights',
      'Ver estadísticas',
      'View insights'
    ]);

    document.querySelectorAll('span').forEach(span => {
      if (!actionLabels.has(span.textContent.trim())) return;
      if (span.closest(`[${ATTR}]`)) return;
      let el = span.parentElement;
      for (let i = 0; i < 15; i++) {
        if (!el || el === document.body) break;
        if (el.closest(`[${ATTR}]`)) return;
        if (isBlockedUiArea(el)) return;
        if (isRowCandidate(el)) { rows.add(el); return; }
        el = el.parentElement;
      }
    });
  }

  return dedupeRows([...rows]);
}

function isRowCandidate(el) {
  if (!el || el.closest(`[${ATTR}]`)) return false;
  if (!el.querySelector('img')) return false;
  if (el.closest('#lzy-panel')) return false;
  if (isBlockedUiArea(el)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 260 || rect.height < 45 || rect.height > 900) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight + 1000) return false;

  const text = el.textContent.replace(/\s+/g, ' ').trim();
  if (text.length < 20) return false;
  if (getContentId(el)) return true;

  const isContentList = location.pathname.includes('/latest/insights/content');
  if (!isContentList) return false;

  const hasAction = /Promocionar|Impulsar|Boost|Ver (insights|estad[ií]sticas)|View insights/i.test(text);
  const hasMetric = /\b\d[\d.,KMBkmb]*\b/.test(text);
  const hasDate = /\b(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}\b/i.test(text);
  return hasAction || hasMetric || hasDate;
}

function isBlockedUiArea(el) {
  if (!el || el === document.body) return false;
  if (el.closest('#lzy-panel')) return true;

  const overlay = el.closest([
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[role="tooltip"]',
    '[aria-modal="true"]',
    '[data-visualcompletion="ignore"]'
  ].join(','));
  if (!overlay) return false;

  const text = overlay.textContent.replace(/\s+/g, ' ').trim();
  if (/Portfolios comerciales|Portfolio comercial|Business portfolios|Business portfolio|Activos comerciales|Seleccionar activo/i.test(text)) {
    return true;
  }

  const hasContentLink = overlay.querySelector?.('a[href*="content_id="], a[href*="post_id="], a[href*="video_id="], a[href*="photo_id="], a[href*="story_fbid="]');
  const hasInsightsAction = /Promocionar|Impulsar|Boost|Ver (insights|estad[ií]sticas)|View insights/i.test(text);
  return !hasContentLink && !hasInsightsAction;
}

function dedupeRows(rows) {
  return rows.filter(row =>
    !rows.some(other => other !== row && row.contains(other))
  );
}

// ─── Process a row ────────────────────────────────────────────────────────────
function processRow(row) {
  if (!row || row.closest(`[${ATTR}]`) !== null || isBlockedUiArea(row)) return;

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
      pageName: readPageName() || state[fallbackId].pageName || '',
      contentId
    };
    delete state[fallbackId];
  }

  if (!state[id]) {
    state[id] = { id, title, img, pageName: readPageName(), contentId: contentId || '', checked: false, label: '' };
  } else {
    if (img) state[id].img = img;
    if (title) state[id].title = title;
    if (!state[id].pageName) state[id].pageName = readPageName();
    if (contentId && !state[id].contentId) state[id].contentId = contentId;
  }

  const s = state[id];

  attachRowControls(row, id);
}

function attachRowControls(row, id) {
  if (!row || !state[id] || isBlockedUiArea(row)) return;
  cleanupExtraControls(row);

  const existing = getOwnRowControl(row);
  if (existing) {
    const chk = existing.querySelector('.lzy-chk');
    const sel = existing.querySelector('.lzy-sel');
    if (chk) chk.checked = !!state[id].checked;
    if (sel) sel.value = state[id].label || '';
    updateRowTag(row, id);
    return;
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
    ${s.label ? `<span class="lzy-row-tag lzy-tag-${labelClass(s.label)}">${escHtml(s.label)}</span>` : ''}
  `;

  ctrl.addEventListener('click', e => e.stopPropagation());
  ctrl.addEventListener('mousedown', e => e.stopPropagation());
  row.appendChild(ctrl);
  injectTableSpacing(row);

  ctrl.querySelector('.lzy-chk').addEventListener('change', e => {
    state[id].checked = e.target.checked;
    if (e.target.checked) {
      state[id].addedAt = Date.now();
    } else {
      state[id].label = '';
      state[id].person = '';
      ctrl.querySelector('.lzy-sel').value = '';
    }
    updateRowTag(row, id);
    renderPanel();
    saveState();
  });

  ctrl.querySelector('.lzy-sel').addEventListener('change', e => {
    state[id].label = e.target.value;
    if (e.target.value !== MENTION_LABEL) state[id].person = '';
    if (e.target.value) {
      if (!state[id].checked) state[id].addedAt = Date.now();
      state[id].checked = true;
      ctrl.querySelector('.lzy-chk').checked = true;
    }
    updateRowTag(row, id);
    renderPanel();
    saveState();
  });
}

function getOwnRowControl(row) {
  return [...row.children].find(child => child.classList?.contains('lzy-ctrl')) || null;
}

function cleanupExtraControls(row) {
  const ownControls = [...row.children].filter(child => child.classList?.contains('lzy-ctrl'));
  ownControls.slice(1).forEach(ctrl => ctrl.remove());
}

function cleanupNestedProcessedRows() {
  document.querySelectorAll(`[${ATTR}]`).forEach(row => {
    if (isBlockedUiArea(row)) {
      row.querySelectorAll('.lzy-ctrl').forEach(ctrl => ctrl.remove());
      row.removeAttribute(ATTR);
      return;
    }

    const parentRow = row.parentElement?.closest?.(`[${ATTR}]`);
    if (!parentRow) return;
    row.querySelectorAll('.lzy-ctrl').forEach(ctrl => ctrl.remove());
    row.removeAttribute(ATTR);
  });
}

function repairProcessedRows() {
  cleanupNestedProcessedRows();
  document.querySelectorAll(`[${ATTR}]`).forEach(row => {
    const id = row.getAttribute(ATTR);
    if (!id || !state[id]) return;
    attachRowControls(row, id);
  });
}

function removeListingControls() {
  document.querySelectorAll('.lzy-ctrl').forEach(ctrl => ctrl.remove());
  document.querySelectorAll(`[${ATTR}]`).forEach(row => row.removeAttribute(ATTR));
  document.querySelectorAll('.lzy-spaced').forEach(el => {
    el.style.paddingLeft = '';
    el.style.boxSizing = '';
    el.classList.remove('lzy-spaced');
  });
}

function removePanel() {
  document.getElementById('lzy-panel')?.remove();
  document.getElementById('lzy-fab')?.remove();
}

function cleanupUnsupportedPage() {
  removeListingControls();
  removePanel();
}

// ─── Espaciado de tabla ───────────────────────────────────────────────────────
const spacedContainers = new WeakSet();
function injectTableSpacing(row) {
  let el = row.parentElement;
  for (let i = 0; i < 8; i++) {
    if (!el || el === document.body) break;
    const role = el.getAttribute('role');
    if (role === 'rowgroup' || role === 'grid' || role === 'table' || role === 'list') {
      if (!spacedContainers.has(el)) {
        el.style.paddingLeft = '112px';
        el.style.boxSizing = 'border-box';
        el.classList.add('lzy-spaced');
        spacedContainers.add(el);
      }
      return;
    }
    el = el.parentElement;
  }
  if (row.parentElement && row.parentElement !== document.body) {
    if (!spacedContainers.has(row.parentElement)) {
      row.parentElement.style.paddingLeft = '112px';
      row.parentElement.style.boxSizing = 'border-box';
      row.parentElement.classList.add('lzy-spaced');
      spacedContainers.add(row.parentElement);
    }
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function saveState() {
  try {
    await chrome.storage.local.set({ lzy: state });
    return true;
  } catch (e) {
    return false;
  }
}

async function loadState() {
  try {
    const { lzy } = await chrome.storage.local.get('lzy');
    state = lzy || {};
    const changed = sanitizeStoredPageNames();
    if (changed) await saveState();
  } catch (e) {
    state = {};
  }
}

async function saveCollapsed() {
  try {
    await chrome.storage.local.set({ lzyCollapsed: panelCollapsed });
  } catch (e) {}
}

async function loadCollapsed() {
  try {
    const { lzyCollapsed } = await chrome.storage.local.get('lzyCollapsed');
    panelCollapsed = !!lzyCollapsed;
  } catch (e) {
    panelCollapsed = false;
  }
}

// ─── Scan & observe ───────────────────────────────────────────────────────────
function scan() {
  if (lastUrl !== location.href) {
    lastUrl = location.href;
    cachedParams = null;
    cachedPageName = '';
  }

  if (!isSupportedPage()) {
    cleanupUnsupportedPage();
    return;
  }

  injectPanel();
  readUrlParams();
  readPageName();
  removeListingControls();
  updateCurrentDetailControl();
  retryMissingContentIds();
  const active = document.activeElement;
  if (!active?.closest?.('#lzy-panel')) renderPanel();
}

const observer = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(scan, 350);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadState();
  await loadCollapsed();
  scan();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(scan, 1500);
}

init();
