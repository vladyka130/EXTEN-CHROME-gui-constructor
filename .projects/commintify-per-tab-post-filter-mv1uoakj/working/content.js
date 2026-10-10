// Commintify Per-Tab Post Filter
// Дає кожній вкладці свій фільтр частот: пост вибирається локально для вкладки, а фільтр
// застосовується через адресний рядок (лише його сайт сприймає як джерело фільтра).
(() => {
  const SEP = '#cmt';
  const TOKEN_KEY = '__cmTabId';
  const DRAFT_KEY = 'playerFilterPanelDraft';
  const URLSTATE_KEY = 'filterUrlParams_v1';
  const K_HOST = 'cmpf_flask_host';
  const K_SHEET = 'cmpf_tab_sheet';
  const K_POST = 'cmpf_tab_post';
  const K_MIN = 'cmpf_minimized';
  const K_POS = 'cmpf_panel_pos';
  const DEFAULT_SHEET = 'filtr_НІЧНА';
  const DEFAULT_HOST = 'http://127.0.0.1:5050';

  const state = {
    host: localStorage.getItem(K_HOST) || DEFAULT_HOST,
    sheets: [],
    sheet: sessionStorage.getItem(K_SHEET) || DEFAULT_SHEET,
    post: sessionStorage.getItem(K_POST) || '',
    posts: {},
    error: '',
    notice: '',
    url: '',
  };

  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function nsKey(key) {
    const t = token();
    return t ? key + SEP + t : key;
  }

  function hzList(postName) {
    const out = [];
    for (const mhz of state.posts[postName] || []) {
      const hz = Math.round(mhz * 1000000);
      if (hz > 0 && out.indexOf(hz) === -1) out.push(hz);
    }
    return out.sort((a, b) => a - b);
  }

  function urlHz() {
    try {
      const raw = new URLSearchParams(window.location.search).get('freqList');
      if (raw === null) return null;
      return raw.split(',').map((v) => Math.round(parseFloat(v))).filter((v) => v > 0);
    } catch (e) {
      return null;
    }
  }

  function draftHz() {
    try {
      const raw = localStorage.getItem(nsKey(DRAFT_KEY));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed && parsed.frequenciesList) ? parsed.frequenciesList : [];
    } catch (e) {
      return null;
    }
  }

  function sameSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const x = [...a].map(String).sort();
    const y = [...b].map(String).sort();
    return x.every((v, i) => v === y[i]);
  }

  function writeFilterKeys(hz) {
    const draft = hz.length
      ? { mode: 'frequency', frequenciesType: 'list', frequenciesList: hz,
          frequenciesRangeInputs: ['', ''], networkIds: [], frequencyOnlyWithNetwork: false }
      : { mode: 'frequency', frequenciesType: 'list', frequenciesRangeInputs: ['', ''],
          networkIds: [], frequencyOnlyWithNetwork: false };
    const urlPart = hz.length ? '?' + new URLSearchParams({ freqList: hz.join(','), fv: '1' }).toString() : '';
    for (const [key, value] of [[DRAFT_KEY, JSON.stringify(draft)], [URLSTATE_KEY, JSON.stringify(urlPart)]]) {
      try {
        localStorage.setItem(nsKey(key), value);
        // Тіньова копія загального ключа: cdp_filter_runner і дашборд :5050 читають саме його.
        localStorage.setItem(key, value);
      } catch (e) {}
    }
    return urlPart;
  }

  // Спершу через сервіс-воркера розширення, потім — напряму зі сторінки.
  // Другий шлях лишається для тих, хто ще не перезавантажив розширення.
  async function fetchEtalon(url) {
    let swError = '';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'cmpf:etalon', url });
      if (r && r.data) return r.data;
      swError = (r && (r.error || r.note)) || `HTTP ${(r && r.status) || 0}`;
    } catch (err) {
      swError = String((err && err.message) || err);
    }
    try {
      const res = await fetch(url, { credentials: 'omit' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      throw new Error(`${swError}; зі сторінки: ${(err && err.message) || err}`);
    }
  }

  async function loadEtalon() {
    state.error = '';
    state.notice = '';
    const url = `${state.host}/api/lan_freq_etalon_full?sheet=${encodeURIComponent(state.sheet)}`;
    state.url = url;
    let data;
    try {
      data = await fetchEtalon(url);
    } catch (err) {
      state.error = String(err.message || err);
      render();
      return;
    }

    state.sheets = data.available_sheets || state.sheets;
    state.sheet = data.sheet_name || data.current_sheet || state.sheet;
    const posts = {};
    for (const [name, info] of Object.entries(data.posts || {})) {
      const nums = [];
      const seen = new Set();
      for (const f of (info && info.standard_freqs) || []) {
        const num = parseFloat(String(f).trim().replace(',', '.'));
        if (!isFinite(num) || num <= 0) continue;
        const rounded = Math.round(num * 10000) / 10000;
        if (seen.has(rounded)) continue;
        seen.add(rounded);
        nums.push(rounded);
      }
      nums.sort((a, b) => a - b);
      posts[String(name).trim()] = nums;
    }
    state.posts = posts;
    const names = Object.keys(posts).filter((n) => posts[n].length);
    if (state.post && names.indexOf(state.post) === -1) state.post = '';
    render();
  }

  function sortedNames() {
    return Object.keys(state.posts)
      .filter((n) => (state.posts[n] || []).length > 0)
      .sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
  }

  function render() {
    const sheetSel = document.getElementById('cmpf-sheet');
    const postSel = document.getElementById('cmpf-post');
    const hostIn = document.getElementById('cmpf-host');
    if (!sheetSel || !postSel || !hostIn) return;

    hostIn.value = state.host;
    const sheets = state.sheets.length ? state.sheets : [state.sheet];
    sheetSel.innerHTML = sheets
      .map((s) => `<option value="${esc(s)}"${s === state.sheet ? ' selected' : ''}>${esc(s)}</option>`)
      .join('');

    const names = sortedNames();
    postSel.innerHTML =
      '<option value="">🌐 Без привʼязки (уся ефірна сітка)</option>' +
      names.map((n) => `<option value="${esc(n)}"${n === state.post ? ' selected' : ''}>📡 ${esc(n)} · ${state.posts[n].length}</option>`).join('');
    postSel.value = state.post;

    updateStatus();
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const PANEL_TITLE = '📡 Фільтр цієї вкладки';

  function hzWord(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'частота';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'частоти';
    return 'частот';
  }

  function renderTitle(count) {
    const el = document.getElementById('cmpf-title');
    if (!el) return;
    const text = state.post ? `📡 ${state.post} · ${count} ${hzWord(count)}` : PANEL_TITLE;
    if (el.textContent !== text) el.textContent = text;
    el.title = text;
  }

  function updateStatus() {
    const badge = document.getElementById('cmpf-count');
    const el = document.getElementById('cmpf-status');
    if (!badge || !el) return;
    const expected = state.post ? hzList(state.post) : [];
    badge.textContent = state.post ? String(expected.length) : '—';
    renderTitle(expected.length);

    if (state.error) {
      el.className = 'cmpf-status cmpf-status-bad';
      el.innerHTML = `⚠ Еталонка недоступна: ${esc(state.error)} · <a href="${esc(state.url)}" target="_blank" rel="noreferrer">відкрити еталонку в новій вкладці</a>`;
      return;
    }
    if (state.notice) {
      el.textContent = `⚠ ${state.notice}`;
      el.className = 'cmpf-status cmpf-status-bad';
      return;
    }
    if (!state.post) {
      el.textContent = `Вкладка не привʼязана до поста · аркуш: ${state.sheet}`;
      el.className = 'cmpf-status';
      return;
    }
    const inUrl = urlHz();
    const inDraft = draftHz();
    const applied = inUrl !== null ? inUrl : inDraft;
    if (applied === null) {
      el.textContent = `Пост «${state.post}»: ${expected.length} ${hzWord(expected.length)} підготовлено, нативний фільтр не застосовано`;
      el.className = 'cmpf-status';
    } else if (sameSet(applied, expected)) {
      el.textContent = `✔ Пост «${state.post}»: ${expected.length} ${hzWord(expected.length)} — збігається з фільтром вкладки`;
      el.className = 'cmpf-status cmpf-status-ok';
    } else {
      el.textContent = `⚠ Фільтр вкладки збито: ${applied.length} ${hzWord(applied.length)} замість ${expected.length} — натисни 🎯`;
      el.className = 'cmpf-status cmpf-status-bad';
    }
  }

  function bindTab(postName, sheetName) {
    state.post = String(postName || '').trim();
    state.sheet = String(sheetName || state.sheet || '').trim();
    state.notice = '';
    try {
      sessionStorage.setItem(K_POST, state.post);
      sessionStorage.setItem(K_SHEET, state.sheet);
    } catch (e) {}
    updateStatus();
  }

  function applyToTab() {
    const hz = hzList(state.post);
    if (!hz.length) {
      state.notice = 'Спочатку обери пост, у якого є частоти в цьому аркуші';
      updateStatus();
      return;
    }
    const urlPart = writeFilterKeys(hz);
    const wanted = urlPart.replace(/^\?/, '');
    if (window.location.search.replace(/^\?/, '') !== wanted) {
      window.location.href = window.location.pathname + '?' + wanted;
    } else {
      updateStatus();
    }
  }

  function place(x, y) {
    const panel = document.getElementById('cmpf-panel');
    if (!panel) return;
    const w = panel.offsetWidth || 268;
    const h = panel.offsetHeight || 200;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    panel.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    panel.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function savedPos() {
    try {
      const p = JSON.parse(localStorage.getItem(K_POS) || 'null');
      return p && isFinite(p.x) && isFinite(p.y) ? p : null;
    } catch (e) {
      return null;
    }
  }

  function resetPos() {
    const panel = document.getElementById('cmpf-panel');
    if (!panel) return;
    try {
      localStorage.removeItem(K_POS);
    } catch (e) {}
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
  }

  function makeDraggable(panel) {
    const head = panel.querySelector('.cmpf-head');
    let grab = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.cmpf-min')) return;
      const r = panel.getBoundingClientRect();
      grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        head.setPointerCapture(e.pointerId);
      } catch (err) {}
      panel.classList.add('cmpf-dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (grab) place(e.clientX - grab.dx, e.clientY - grab.dy);
    });
    const drop = () => {
      if (!grab) return;
      grab = null;
      panel.classList.remove('cmpf-dragging');
      const r = panel.getBoundingClientRect();
      try {
        localStorage.setItem(K_POS, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      } catch (e) {}
    };
    head.addEventListener('pointerup', drop);
    head.addEventListener('pointercancel', drop);
    // Подвійний клік по заголовку — повернути панель на типове місце (низ-ліво).
    head.addEventListener('dblclick', resetPos);
  }

  function buildUI() {
    if (document.getElementById('cmpf-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'cmpf-panel';
    panel.innerHTML = `
      <div class="cmpf-head" title="Перетягни за заголовок, щоб переставити · подвійний клік — повернути у кут">
        <span class="cmpf-title" id="cmpf-title">${PANEL_TITLE}</span>
        <button class="cmpf-min" id="cmpf-min" title="Згорнути / розгорнути">–</button>
      </div>
      <div class="cmpf-body" id="cmpf-body">
        <label class="cmpf-label">Сервер еталонки (Flask)</label>
        <input class="cmpf-input" id="cmpf-host" spellcheck="false" />
        <label class="cmpf-label">Аркуш</label>
        <select class="cmpf-select" id="cmpf-sheet"></select>
        <label class="cmpf-label">Пост для цієї вкладки</label>
        <div class="cmpf-row">
          <select class="cmpf-select" id="cmpf-post"></select>
          <span class="cmpf-count" id="cmpf-count">—</span>
        </div>
        <div class="cmpf-row">
          <button class="cmpf-btn" id="cmpf-apply" title="Застосувати фільтр поста лише до цієї вкладки">🎯 Застосувати</button>
          <button class="cmpf-btn cmpf-btn-icon" id="cmpf-reload" title="Перезавантажити лише цю вкладку">🔁</button>
        </div>
        <div class="cmpf-status" id="cmpf-status">Завантаження еталонки…</div>
      </div>
    `;
    document.body.appendChild(panel);

    if (sessionStorage.getItem(K_MIN) === '1') panel.classList.add('cmpf-collapsed');

    document.getElementById('cmpf-min').addEventListener('click', () => {
      panel.classList.toggle('cmpf-collapsed');
      try {
        sessionStorage.setItem(K_MIN, panel.classList.contains('cmpf-collapsed') ? '1' : '0');
      } catch (e) {}
    });

    document.getElementById('cmpf-host').addEventListener('change', (e) => {
      state.host = e.target.value.trim().replace(/\/+$/, '') || DEFAULT_HOST;
      localStorage.setItem(K_HOST, state.host);
      loadEtalon();
    });

    document.getElementById('cmpf-sheet').addEventListener('change', (e) => {
      bindTab(state.post, e.target.value);
      loadEtalon();
    });

    document.getElementById('cmpf-post').addEventListener('change', (e) => {
      bindTab(e.target.value, state.sheet);
    });

    document.getElementById('cmpf-apply').addEventListener('click', applyToTab);
    document.getElementById('cmpf-reload').addEventListener('click', () => {
      writeFilterKeys(hzList(state.post));
      window.location.reload();
    });

    makeDraggable(panel);
    const pos = savedPos();
    if (pos) place(pos.x, pos.y);
    window.addEventListener('resize', () => {
      const r = panel.getBoundingClientRect();
      place(r.left, r.top);
    });
  }

  function init() {
    buildUI();
    loadEtalon().then(() => {
      // Перевірка «на живця»: чи не збив хтось фільтр цієї вкладки, поки ти слухаєш ефір.
      setInterval(updateStatus, 10000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
