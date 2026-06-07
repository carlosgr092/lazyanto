// Lazyanto — Meta Business Suite post tagger
// Reads HTML rows, injects checkbox + label dropdown, shows right panel

const LABELS = ['Kamikaze', 'Tiradera', 'XD'];
const ATTR   = 'data-lzy';
let state    = {};  // { [id]: { id, title, img, checked, label } }
let debounce = null;

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
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('lzy-toggle').addEventListener('click', () => {
    panel.classList.toggle('lzy-mini');
    document.getElementById('lzy-toggle').textContent =
      panel.classList.contains('lzy-mini') ? '▶' : '◀';
  });

  document.getElementById('lzy-clear').addEventListener('click', clearAll);
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

// ─── Render panel list ────────────────────────────────────────────────────────
function renderPanel() {
  const list  = document.getElementById('lzy-list');
  const empty = document.getElementById('lzy-empty');
  const cnt   = document.getElementById('lzy-cnt');
  if (!list) return;

  const selected = Object.values(state).filter(p => p.checked);

  cnt.textContent    = selected.length || '';
  cnt.style.display  = selected.length ? 'inline' : 'none';
  empty.style.display = selected.length ? 'none' : 'block';

  list.innerHTML = selected.map(p => {
    const tagHtml = p.label
      ? `<span class="lzy-tag lzy-tag-${p.label.toLowerCase()}">${escHtml(p.label)}</span>`
      : `<span class="lzy-no-tag">Sin marcar</span>`;
    const bgStyle = p.img ? `background-image:url('${escHtml(p.img)}')` : '';
    return `
      <div class="lzy-item">
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

  // Primary: role="row" que tenga imagen Y botón "Promocionar"
  // Los rows vacíos/expansibles NO tienen Promocionar → quedan excluidos
  document.querySelectorAll(`[role="row"]:not([${ATTR}])`).forEach(el => {
    if (!el.querySelector('img')) return;
    const hasPromo = [...el.querySelectorAll('span')].some(
      s => s.textContent.trim() === 'Promocionar'
    );
    if (!hasPromo) return;
    rows.add(el);
  });

  // Fallback: anclar en el span "Promocionar" y subir al primer ancestor con img
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
  // Extract title: longest span text that looks like a post title
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

  const title = (titleSpan?.textContent.trim() || row.textContent.trim().slice(0, 60)) || 'Post';
  const img   = row.querySelector('img')?.src || '';
  const id    = hashId(title.slice(0, 50));

  row.setAttribute(ATTR, id);

  // Init or restore state
  if (!state[id]) {
    state[id] = { id, title, img, checked: false, label: '' };
  } else {
    if (img) state[id].img    = img;
    if (title) state[id].title = title;
  }

  const s = state[id];

  // Build controls
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

  // Stop clicks from bubbling to row handlers
  ctrl.addEventListener('click', e => e.stopPropagation());

  // Append last — position:absolute saca el ctrl del flow del row,
  // así no rompe el flex/grid interno de Business Suite
  row.appendChild(ctrl);
  injectTableSpacing(row);

  // Checkbox event
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

  // Dropdown event
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
// Agrega padding-left al contenedor de la tabla para crear espacio
// donde flotan nuestros controles (position:absolute)
let tableSpaced = false;
function injectTableSpacing(row) {
  if (tableSpaced) return;

  // Subir desde el row hasta encontrar el contenedor de filas (rowgroup / grid / list)
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

  // Fallback: padding en el padre directo del row
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
  findRows().forEach(processRow);
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
