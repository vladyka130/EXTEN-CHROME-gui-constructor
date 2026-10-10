// Усе в IIFE: ім'я gui вже зайняте глобалом із contextBridge.
(() => {
// Інтерфейс конструктора.
const gui = window.gui;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  project: null,
  skin: null,
  surface: null,
  picked: null,
  editing: null,
  picker: false,
  mode: 'off',
  missing: new Set(),
  file: null,
  width: 0,
  logLines: [],
};

const STYLE_FIELDS = [
  { group: 'Розмір панелі/елемента', props: [['width', 'width'], ['min-width', 'min-width'], ['max-width', 'max-width'], ['height', 'height']] },
  { group: 'Відступи', props: [['padding', 'padding'], ['margin', 'margin'], ['gap', 'gap']] },
  {
    group: 'Текст і шрифт',
    props: [
      ['font-size', 'font-size'],
      ['font-weight', 'font-weight'],
      ['font-family', 'font-family'],
      ['line-height', 'line-height'],
      ['letter-spacing', 'letter-spacing'],
      ['text-align', 'text-align'],
      ['text-transform', 'text-transform'],
    ],
  },
  {
    group: 'Кольори та рамка',
    props: [
      ['color', 'колір тексту'],
      ['background-color', 'колір фону'],
      ['border', 'рамка'],
      ['border-radius', 'заокруглення'],
      ['box-shadow', 'тінь'],
      ['opacity', 'прозорість'],
    ],
  },
  {
    group: 'Позиція',
    props: [
      ['position', 'position'],
      ['top', 'top'],
      ['right', 'right'],
      ['bottom', 'bottom'],
      ['left', 'left'],
      ['z-index', 'z-index'],
    ],
  },
];

const COLOR_PROPS = new Set(['color', 'background-color', 'border-color']);

function log(text, level = '') {
  const el = $('#log');
  state.logLines.push({ text, level });
  if (state.logLines.length > 200) state.logLines.shift();
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  el.appendChild(line);
  while (el.childElementCount > 200) el.removeChild(el.firstElementChild);
  el.scrollTop = el.scrollHeight;
}

function uid() {
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scopeKey(id) {
  const key = String(id || 'any').startsWith('content:') ? 'content' : String(id || 'any');
  return key.replace(/[^A-Za-z0-9._]/g, '_');
}

// ---------- проєкт ----------

async function refreshProject() {
  state.project = await gui.current();
  if (!state.project) return renderEmpty();
  $('#project-chip').textContent = `${state.project.name} ${state.project.version} · MV${state.project.manifestVersion}`;
  renderSurfaces();
  renderLabels();
  renderFiles();
  renderWarnings();
  return state.project;
}

function renderEmpty() {
  $('#project-chip').textContent = 'проєкт не відкрито';
  $('#surfaces-list').innerHTML = '<div class="hint">Натисни «Імпортувати» й вкажи теку розширення (з manifest.json), або «Мої проєкти» → імпорт .zip/.crx.</div>';
}

function renderSurfaces() {
  const box = $('#surfaces-list');
  box.innerHTML = state.project.surfaces.map((s) => `
    <div class="surface${state.surface && state.surface.id === s.id ? ' active' : ''}" data-sid="${esc(s.id)}">
      <h4>${esc(s.label)}</h4>
      <div class="meta">${esc(s.kind === 'content' ? (s.matches.join(', ') || 'без matches') : s.page || '')}</div>
      ${s.note ? `<div class="meta">${esc(s.note)}</div>` : ''}
      <div class="row">
        <button class="btn tiny" data-view="${esc(s.id)}">👁 Дивитись</button>
        <span class="hint" style="margin:0">${s.css && s.css.length ? 'css: ' + s.css.length : ''}</span>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => openSurface(btn.dataset.view)));
}

function renderWarnings() {
  const box = $('#scan-warnings');
  const items = [...(state.project.warnings || [])];
  if (state.project.scripts.length > 12) items.push('Скриптів: ' + state.project.scripts.length);
  box.innerHTML = items.map((w) => `⚠ ${esc(w)}`).join('<br>');
}

async function openSurface(surfaceId) {
  const surface = state.project.surfaces.find((s) => s.id === surfaceId);
  if (!surface) return;
  state.surface = surface;
  showStage(true);
  renderSurfaces();
  const result = await gui.previewOpen(surfaceId);
  if (result && result.error) log(result.error, 'e');
  else log(`Відкрито перегляд: ${surface.label}. Увімкни «Вибір елемента» і клікай по панелі.`, 'i');
}

// ----------.stage ----------

let holder = null;
function showStage(on) {
  const stage = $('#preview-stage');
  $('#stage-empty').style.display = on ? 'none' : 'grid';
  if (on && !holder) {
    holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0;background:#fff';
    stage.appendChild(holder);
    syncBounds();
  }
  if (!on && holder) {
    holder.remove();
    holder = null;
  }
  applyWidth();
}

function applyWidth() {
  if (!holder) return;
  const w = state.width;
  holder.style.left = w ? 'center' : '0';
  holder.style.right = 'auto';
  if (w) {
    holder.style.width = w + 'px';
    holder.style.margin = '0 auto';
    holder.style.left = Math.max(0, ($('#preview-stage').clientWidth - w) / 2) + 'px';
  } else {
    holder.style.width = '100%';
    holder.style.left = '0';
  }
  syncBounds();
}

function syncBounds() {
  const target = holder || $('#preview-stage');
  const r = target.getBoundingClientRect();
  gui.previewBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
window.addEventListener('resize', syncBounds);
new ResizeObserver(syncBounds).observe($('#preview-stage'));

// ---------- режими превʼю ----------

function syncModeButtons(mode) {
  state.mode = mode;
  state.picker = mode === 'pick';
  $('#btn-pick').classList.toggle('on', mode === 'pick');
  $('#btn-geom').classList.toggle('on', mode === 'geom');
}

async function setMode(next) {
  if (!state.surface) return log('Спочатку відкрий поверхню — кнопка «Дивитись».', 'w');
  const result = await gui.mode(next);
  syncModeButtons(result.mode);
  if (result.mode === 'pick') log('Вибір елемента: клік по панелі додає правку в інспектор (Esc — вийти).', 'i');
  else if (result.mode === 'geom') log('Рухою мишкою: тягни елемент, щоб переставити; тягни за квадратні ручки — змінити розмір. Стрілки — крок 1 px, Shift+стрілки — 10 px. Tab — батьківський елемент, Shift — по вісі/пропорції, Esc — вийти.', 'i');
  else log('Режим миші вимкнено.', 'i');
}

// ---------- скін ----------

async function loadSkin() {
  state.skin = await gui.getSkin();
  $('#chk-enabled').checked = state.skin.enabled !== false;
  $('#extra-css').value = Object.entries(state.skin.css || {}).map(([k, v]) => `/* ${k} */\n${v}`).join('\n\n');
  renderOps();
}

let saveTimer = null;
function queueSaveSkin() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    state.skin = await gui.saveSkin(state.skin);
    renderOps();
  }, 220);
}

function findOp(id) {
  return state.skin.ops.find((o) => o.id === id);
}

function upsertOp(id, mutate) {
  let op = findOp(id);
  if (!op) {
    op = { id, surface: state.picked ? state.picked.surface : (state.surface ? state.surface.id : 'any'), anchor: { selector: state.picked ? state.picked.selector : '' }, enabled: true, style: {}, text: null, note: '' };
    state.skin.ops.push(op);
  }
  mutate(op);
  queueSaveSkin();
  return op;
}

function opSummary(op) {
  const bits = [];
  if (op.text && op.text.mode !== 'keep') bits.push('текст');
  if (op.style && Object.keys(op.style).length) bits.push(Object.keys(op.style).length + ' стилів');
  if (op.classes) bits.push('класи');
  if (op.attrs) bits.push('атрибути');
  if (op.layout) bits.push('розташування');
  return bits.join(' · ') || '—';
}

function renderOps() {
  const box = $('#ops-list');
  const ops = state.skin.ops;
  $('#ops-count').textContent = String(ops.length);
  box.innerHTML = ops.length
    ? ops
        .map(
          (op) => `
      <div class="op${op.enabled ? '' : ' off'}${state.missing.has(op.anchor.selector || op.anchor.text) ? ' miss' : ''}" data-op="${esc(op.id)}">
        <input type="checkbox" ${op.enabled ? 'checked' : ''} data-toggle title="увімкнути/вимкнути">
        <div class="sel" title="${esc(op.anchor.selector || '')}">${esc(op.note || op.anchor.selector || ('за текстом: ' + (op.anchor.text || '—')))}</div>
        <span class="what">${esc(opSummary(op))}</span>
        <button class="btn tiny" data-edit>✎</button>
        <button class="btn tiny danger" data-del>✕</button>
      </div>`,
        )
        .join('')
    : '<div class="hint">Правок ще немає.</div>';

  box.querySelectorAll('.op').forEach((row) => {
    const id = row.dataset.op;
    row.querySelector('[data-toggle]').addEventListener('change', (e) => {
      findOp(id).enabled = e.target.checked;
      queueSaveSkin();
    });
    row.querySelector('[data-edit]').addEventListener('click', () => {
      state.editing = id;
      const op = findOp(id);
      state.picked = { selector: op.anchor.selector, surface: op.surface, ownText: (op.text && op.text.value) || '', tag: 'елемент', styles: op.style || {}, chain: [], attrs: {} };
      renderInspector();
    });
    row.querySelector('[data-del]').addEventListener('click', () => {
      state.skin.ops = state.skin.ops.filter((o) => o.id !== id);
      queueSaveSkin();
    });
  });
}

// ---------- інспектор ----------

function renderInspector() {
  const body = $('#insp-body');
  const picked = state.picked;
  if (!picked) {
    body.innerHTML = '<div class="hint">Спочатку вибери елемент у попередньому перегляді, або додай правку за підписом із вкладки «Мітки».</div>';
    $('#picked-desc').textContent = 'елемент не вибрано';
    return;
  }
  const op = state.editing ? findOp(state.editing) : null;
  const existing = op || state.skin.ops.find((o) => o.anchor.selector && o.anchor.selector === picked.selector) || null;
  const style = (existing && existing.style) || {};
  const textSpec = existing && existing.text;

  $('#picked-desc').textContent = picked.tag + ' ' + (picked.rect ? `${picked.rect.w}×${picked.rect.h}` : '');

  const groups = STYLE_FIELDS.map(({ group, props }) => `
    <div class="field">
      <label>${esc(group)}</label>
      ${props
        .map(
          ([prop, label]) => `
        <div class="two" style="margin-bottom:4px">
          <input class="input" data-prop="${esc(prop)}" value="${esc(style[prop] || '')}" placeholder="${esc(label)}" spellcheck="false">
          ${COLOR_PROPS.has(prop) ? `<input type="color" class="swatch" data-swatch="${esc(prop)}" value="${toHex(style[prop] || '#ffffff')}">` : ''}
        </div>`,
        )
        .join('')}
    </div>`).join('');

  body.innerHTML = `
    <div class="field">
      <label>Селектор елемента</label>
      <input class="input" id="f-selector" value="${esc(picked.selector || '')}" spellcheck="false">
      <div class="hint" style="margin-top:3px">${esc((picked.chain || []).slice(0, 3).join(' › ') || '—')}</div>
    </div>
    <div class="field">
      <label>Підпис елемента (зараз)</label>
      <div class="hint" style="margin:0 0 4px">${esc((picked.ownText || picked.text || '').slice(0, 90)) || '—'}</div>
      <div class="row">
        <select class="select tiny" id="f-text-mode">
          <option value="">не змінювати</option>
          <option value="replace">замінити на</option>
          <option value="append">дописати після</option>
          <option value="prepend">дописати перед</option>
          <option value="remove">прибрати текст</option>
        </select>
        <input class="input" id="f-text" placeholder="новий текст…" style="flex:2">
      </div>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" id="f-hide"> приховати елемент</label>
      <input class="input" id="f-note" placeholder="короткий опис правки" value="${esc((existing && existing.note) || '')}" style="flex:1">
    </div>
    ${groups}
    <div class="row">
      <button class="btn btn-primary tiny" id="f-apply">Застосувати</button>
      <button class="btn tiny" id="f-new">Нова правка для цього елемента</button>
    </div>
    <div class="hint">Усе застосовується миттєво в превʼю й зберігається у «чернетку» (skin.json). Файли розширення змінюються лише після «Застосувати до розширення».</div>
  `;

  if (textSpec) {
    $('#f-text-mode').value = textSpec.mode || 'replace';
    $('#f-text').value = textSpec.value || '';
  }
  if (style.display === 'none') $('#f-hide').checked = true;

  const commit = () => {
    const selector = $('#f-selector').value.trim();
    const id = (existing && existing.id) || state.editing || uid();
    upsertOp(id, (op) => {
      op.surface = picked.surface || (state.surface ? state.surface.id : 'any');
      op.anchor.selector = selector;
      if (!op.anchor.text && !selector) op.anchor.text = (picked.ownText || '').trim();
      const mode = $('#f-text-mode').value;
      op.text = mode ? { mode, value: $('#f-text').value } : null;
      op.note = $('#f-note').value.trim() || op.note || (picked.ownText || selector || '').slice(0, 60);
      op.style = op.style || {};
      for (const input of $$('#insp-body [data-prop]')) {
        const prop = input.dataset.prop;
        const value = input.value.trim();
        if (value) op.style[prop] = value;
        else delete op.style[prop];
      }
      if ($('#f-hide').checked) op.style.display = 'none';
      else if (op.style.display === 'none') delete op.style.display;
      if (!Object.keys(op.style).length) op.style = {};
    });
    state.editing = id;
  };

  body.addEventListener('input', (event) => {
    if (event.target.matches('#f-selector, #f-note, #f-text')) return;
    if (event.target.matches('[data-swatch]')) {
      const input = $(`[data-prop="${event.target.dataset.swatch}"]`);
      if (input) input.value = event.target.value;
    }
    commit();
  });
  body.addEventListener('change', commit);
  $('#f-apply').addEventListener('click', commit);
  $('#f-new').addEventListener('click', () => {
    state.editing = null;
    const pickedSnapshot = state.picked;
    state.picked = { ...pickedSnapshot, selector: pickedSnapshot.selector };
    state.skin.ops.push({ id: uid(), surface: pickedSnapshot.surface, anchor: { selector: pickedSnapshot.selector, text: (pickedSnapshot.ownText || '').trim() }, enabled: true, style: {}, text: null, note: (pickedSnapshot.ownText || '').slice(0, 60) });
    queueSaveSkin();
    renderInspector();
  });
}

function toHex(value) {
  const v = String(value || '');
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (!m) return '#ffffff';
  return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
}

// ---------- мітки ----------

function renderLabels() {
  const needle = ($('#labels-search').value || '').toLowerCase();
  const labels = (state.project.labels || []).filter((l) => !needle || l.value.toLowerCase().includes(needle));
  $('#labels-count').textContent = `знайдено підписів: ${labels.length} (усього ${state.project.labels.length})`;
  $('#labels-list').innerHTML = labels
    .slice(0, 400)
    .map(
      (l) => `
    <div class="label-item" data-id="${esc(l.id)}">
      <div class="val">${esc(l.value)}</div>
      <div class="src">${esc(l.file)}:${l.line}:${l.col} · ${esc(l.kind === 'attr' ? 'атрибут ' + l.attr : l.kind === 'text' ? 'текст вузла' : 'присвоєння ' + (l.attr || ''))}${l.hint ? ' · ' + esc(l.hint) : ''}</div>
      <div class="row"><button class="btn tiny" data-text>Правити текст</button><button class="btn tiny" data-jump>До файлу</button></div>
    </div>`,
    )
    .join('');
  $$('#labels-list [data-text]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const item = btn.closest('.label-item');
      const label = state.project.labels.find((l) => l.id === item.dataset.id);
      const idMatch = /#([\w-]+)/.exec(label.hint || '');
      const id = uid();
      state.skin.ops.push({
        id,
        surface: state.surface ? state.surface.id : 'any',
        anchor: { selector: idMatch ? '#' + idMatch[1] : '', text: label.value, match: 'exact' },
        enabled: true,
        text: { mode: 'replace', value: label.value },
        style: {},
        note: label.value.slice(0, 60),
      });
      queueSaveSkin();
      log('Додано правку тексту «' + label.value + '». Впиши нове значення в інспекторі праворуч.', 'i');
      state.picked = {
        selector: idMatch ? '#' + idMatch[1] : '',
        surface: state.skin.ops[state.skin.ops.length - 1].surface,
        ownText: label.value,
        tag: 'за текстом',
        styles: {},
        chain: [],
        attrs: {},
      };
      state.editing = id;
      renderInspector();
      $('#f-text').focus();
      $('#f-text').select();
    }),
  );
  $$('#labels-list [data-jump]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const item = btn.closest('.label-item');
      const label = state.project.labels.find((l) => l.id === item.dataset.id);
      switchTab('files');
      $('#file-picker').value = label.file;
      openFile(label.file);
      log(`Файл ${label.file}, рядок ${label.line}: ${label.value}`, 'i');
    }),
  );
}

// ---------- файли ----------

function renderFiles() {
  const files = (state.project.textFiles || []).slice();
  const select = $('#file-picker');
  select.innerHTML = files.sort().map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  if (!state.file && files.length) {
    state.file = state.project.pages[0] || files.find((f) => f.endsWith('.css')) || files[0];
    select.value = state.file;
    openFile(state.file);
  }
}

async function openFile(rel) {
  state.file = rel;
  const { text } = await gui.readFile(rel);
  $('#file-editor').value = text;
  $('#file-diff').hidden = true;
}

function simpleDiff(original, current) {
  const a = String(original || '').split('\n');
  const b = String(current || '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const out = [];
  out.push(`… ${start} спільних рядків …`);
  for (let i = start; i <= endA; i++) out.push('- ' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+ ' + b[i]);
  out.push(`… ${a.length - endA - 1} спільних рядків …`);
  return out;
}

async function showDiff() {
  const original = await gui.originalFile(state.file);
  const current = $('#file-editor').value;
  const lines = simpleDiff(original.text, current);
  $('#file-diff').innerHTML = lines.map((l) => `<div class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${esc(l)}</div>`).join('');
  $('#file-diff').hidden = false;
}

// ---------- моки ----------

async function loadMocks() {
  const mocks = await gui.getMocks();
  state.mocks = mocks;
  renderMocks();
}

function renderMocks() {
  const items = [
    ...(state.mocks.net || []).map((r, i) => ({ ...r, kind: 'net', i })),
    ...(state.mocks.message || []).map((r, i) => ({ ...r, kind: 'message', i })),
  ];
  $('#mock-list').innerHTML = items.length
    ? items
        .map(
          (r) => `
      <div class="mock-item">
        <div class="m">${r.kind === 'net' ? '🌐' : '📮'} ${esc(r.match)}</div>
        <div class="hint" style="margin:2px 0">${esc(String(r.body || '').slice(0, 120))}</div>
        <div class="row"><button class="btn tiny danger" data-kind="${r.kind}" data-i="${r.i}">Прибрати</button></div>
      </div>`,
        )
        .join('')
    : '<div class="hint">Моків немає. Без них панель показує свій стан «сервер недоступний» — це теж корисно для оформлення.</div>';
  $$('#mock-list [data-i]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.mocks[btn.dataset.kind].splice(Number(btn.dataset.i), 1);
      gui.saveMocks(state.mocks).then(renderMocks);
    }),
  );
}

// ---------- знімки ----------

async function renderSnapshots() {
  const list = await gui.snapshots();
  $('#snapshot-list').innerHTML = list.length
    ? list.map((s) => `<div class="snap"><span class="id">${esc(s.id)}</span><span>${esc(s.label)}</span><button class="btn tiny" data-id="${esc(s.id)}">Відкатити</button></div>`).join('')
    : '<div class="hint">Знімків немає.</div>';
  $$('#snapshot-list [data-id]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await gui.restoreSnapshot(btn.dataset.id);
      await refreshProject();
      log('Відновлено знімок ' + btn.dataset.id, 'i');
    }),
  );
}

// ---------- вкладки ----------

function switchTab(name) {
  $$('#left-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'history') renderSnapshots();
}

// ---------- модальне вікно проєктів ----------

async function showProjects() {
  const list = await gui.list();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(3,7,14,.72);display:grid;place-items:center;z-index:10';
  overlay.innerHTML = `
    <div style="width:560px;max-height:70vh;overflow:auto;background:#111a29;border:1px solid #24344f;border-radius:10px;padding:14px">
      <b>Мої проєкти</b>
      <div class="hint">Робочі копії, які ти вже імпортував. Оригінали на диску не чіпаються.</div>
      ${list.map((p) => `<div class="snap"><span class="id">${esc(p.name)} ${esc(p.version || '')}</span><button class="btn tiny" data-open="${esc(p.id)}">Відкрити</button><button class="btn tiny danger" data-del="${esc(p.id)}">Видалити</button></div>`).join('') || '<div class="hint">Порожньо.</div>'}
      <div class="row">
        <button class="btn tiny" id="m-zip">Імпортувати .zip / .crx…</button>
        <button class="btn tiny" id="m-close">Закрити</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#m-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#m-zip').addEventListener('click', async () => {
    const choice = await gui.choose({});
    if (!choice.path) return;
    await gui.import(choice.path);
    await afterImport();
    overlay.remove();
  });
  overlay.querySelectorAll('[data-open]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await gui.open(btn.dataset.open);
      await afterImport();
      overlay.remove();
    }),
  );
  overlay.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await gui.deleteProject(btn.dataset.del);
      btn.closest('.snap').remove();
    }),
  );
}

async function afterImport() {
  await refreshProject();
  await loadSkin();
  await loadMocks();
  state.surface = null;
  showStage(false);
  log('Проєкт відкрито. Обери поверхню та натисни «Дивитись».', 'i');
}

window.__guiRefresh = afterImport;

// ---------- події ----------

async function boot() {
  $('#btn-import').addEventListener('click', async () => {
    const choice = await gui.choose({ dir: true });
    if (!choice.path) return;
    try {
      await gui.import(choice.path);
      await afterImport();
    } catch (e) {
      log('Імпорт не вдався: ' + e.message, 'e');
    }
  });
  $('#btn-open-list').addEventListener('click', showProjects);
  $('#btn-apply').addEventListener('click', async () => {
    const result = await gui.applySkin(state.skin);
    if (result.error) return log(result.error, 'e');
    const r = result.report;
    log(
      r.removed
        ? 'Скін-шар знято: файли розширення повернуті до вигляду без оформлення.'
        : `Застосовано. Записано: ${r.written.join(', ')}${r.manifestPatched ? ' · manifest.json оновлено' : ''}${r.pages.length ? ' · сторінки: ' + r.pages.map((p) => p.page).join(', ') : ''}`,
      'i',
    );
    (r.warnings || []).forEach((w) => log(w, 'w'));
    await refreshProject();
    showStage(true);
  });
  $('#btn-export').addEventListener('click', async () => {
    const result = await gui.export();
    if (result.canceled) return;
    log(`Експортовано: ${result.folder}${result.zip ? ' (+ .zip)' : ''}. Завантажити: chrome://extensions → Режим розробника → «Виділена папка»`, 'i');
  });
  $('#btn-snapshot').addEventListener('click', async () => {
    const id = await gui.snapshot('ручний');
    log('Знімок створено: ' + id, 'i');
  });
  $('#btn-pick').addEventListener('click', () => setMode(state.mode === 'pick' ? 'off' : 'pick'));
  $('#btn-geom').addEventListener('click', () => setMode(state.mode === 'geom' ? 'off' : 'geom'));
  $('#btn-reload').addEventListener('click', async () => {
    if (!state.surface) return;
    await gui.previewReload();
    log('Превʼю перезавантажено', 'i');
  });
  $('#chk-enabled').addEventListener('change', async (e) => {
    state.skin.enabled = e.target.checked;
    await gui.saveSkin(state.skin);
    log(e.target.checked ? 'Скін увімкнено — видно оформлення.' : 'Скін вимкнено — бачиш оригінальний вигляд.', 'i');
  });
  $('#preview-width').addEventListener('change', (e) => {
    state.width = Number(e.target.value) || 0;
    applyWidth();
  });
  $('#btn-live').addEventListener('click', async () => {
    const url = $('#live-url').value.trim();
    if (!url || !state.surface) return log('Спочатку обери контент-поверхню та введи URL.', 'w');
    await gui.previewLive(state.surface.id, url);
    log('Жива сторінка: скрипти розширення підключаються…', 'i');
  });
  $('#labels-search').addEventListener('input', renderLabels);
  $('#left-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });
  $('#file-picker').addEventListener('change', (e) => openFile(e.target.value));
  $('#btn-save-file').addEventListener('click', async () => {
    await gui.writeFile(state.file, $('#file-editor').value, true);
    await refreshProject();
    log('Файл збережено (знімок перед правкою створено).', 'i');
  });
  $('#btn-diff-file').addEventListener('click', showDiff);
  $('#btn-revert-file').addEventListener('click', async () => {
    const original = await gui.originalFile(state.file);
    if (original.text == null) return log('Оригіналу файлу немає.', 'w');
    await gui.writeFile(state.file, original.text, true);
    $('#file-editor').value = original.text;
    log('Файл повернуто до оригіналу.', 'i');
  });
  $('#btn-history-file').addEventListener('click', async () => {
    const stamps = await gui.history(state.file);
    if (!stamps.length) return log('Історії для цього файлу ще немає.', 'w');
    const pick = stamps.slice(0, 12).map((s, i) => `${i + 1}) ${s}`).join('\n');
    const n = Number(prompt('Вернути версію №:\n' + pick, '1'));
    if (!n) return;
    const { text } = await gui.restoreHistory(state.file, stamps[n - 1]);
    $('#file-editor').value = text;
    log('Повернуто версію ' + stamps[n - 1], 'i');
  });
  $('#btn-mock-add').addEventListener('click', async () => {
    const kind = $('#mock-kind').value;
    const match = $('#mock-match').value.trim();
    const raw = $('#mock-body').value.trim();
    if (!match) return log('Вкажи збіг (URL-шматок або тип повідомлення).', 'w');
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return log('Тіло мока не коректний JSON.', 'e');
    }
    const rule = { match, body, mode: $('#mock-regex').checked ? 'regex' : 'contains', enabled: true };
    state.mocks[kind] = state.mocks[kind] || [];
    state.mocks[kind].push(rule);
    await gui.saveMocks(state.mocks);
    renderMocks();
    $('#mock-match').value = '';
    $('#mock-body').value = '';
    await gui.previewReload();
    log('Мок додано, превʼю перезавтажую…', 'i');
  });
  $('#btn-strip-skin').addEventListener('click', async () => {
    state.skin = { schema: state.skin.schema, enabled: true, ops: [], css: {}, updatedAt: new Date().toISOString() };
    await gui.saveSkin(state.skin);
    const result = await gui.applySkin(state.skin);
    log('Скін-шар знято з файлів: ' + JSON.stringify(result.report.removed ? 'файли відновлені' : result.report), 'i');
    await refreshProject();
    renderOps();
  });
  $('#btn-extra-css').addEventListener('click', async () => {
    const text = $('#extra-css').value;
    const surface = state.surface ? state.surface.id : 'any';
    state.skin.css = { ...state.skin.css, [surface]: text };
    await gui.saveSkin(state.skin);
    log('Додатковий CSS застосовано до «' + surface + '»', 'i');
  });

  gui.onPicked((info) => {
    state.picked = info;
    state.editing = null;
    renderInspector();
    switchTab('surfaces');
    log(`Вибрано: ${info.tag} ${info.selector || info.ownText}`, 'i');
    if (state.mode === 'pick') setMode('off');
  });
  gui.onMode((mode) => syncModeButtons(mode));
  gui.onGeom((info) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    state.skin = info.skin;
    renderOps();
    if (state.picked && state.picked.selector === info.selector) {
      state.picked.styles = { ...(state.picked.styles || {}), ...info.style };
      renderInspector();
    }
    const parts = Object.entries(info.style || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
    log(`${info.kind === 'resize' ? 'Розмір' : 'Рухо'} мишкою → ${info.selector} (${parts})`, 'i');
    if (!info.unique) log('Селектор вказує не на один елемент — правка застосується до кількох.', 'w');
  });
  gui.onEvent((payload) => {
    if (payload.__gui === 'log') log((payload.level === 'error' ? '⛔ ' : payload.level === 'warn' ? '⚠ ' : '') + payload.text, payload.level === 'error' ? 'e' : 'w');
    if (payload.__gui === 'skin-report') {
      state.missing = new Set(payload.missing || []);
      renderOps();
      if (payload.missing && payload.missing.length) log(`Скін: ${payload.applied} правок застосовано, ${payload.missing.length} не знайдено: ${payload.missing.join(', ')}`, 'w');
      else log(`Скін: ${payload.applied} правок застосовано.`, 'i');
    }
  });

  const info = await gui.info();
  log(`Конструктор готовий. Electron ${info.electron}, Node ${info.node}.`, 'i');
  const current = await gui.current();
  if (current) {
    state.project = current;
    $('#project-chip').textContent = `${current.name} ${current.version} · MV${current.manifestVersion}`;
    renderSurfaces();
    renderLabels();
    renderFiles();
    renderWarnings();
  } else {
    renderEmpty();
  }
  await loadSkin();
  await loadMocks();
}

boot().catch((e) => log('Помилка запуску: ' + e.message, 'e'));
})();
