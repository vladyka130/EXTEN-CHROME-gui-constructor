'use strict';
// Головний процес Конструктора GUI для Chrome-розширень.
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, protocol, net, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ProjectStore, within } = require('./lib/project');
const skinLib = require('./lib/skin');
const { buildCss, buildData, normaliseSkin, scopeKey } = skinLib;

const APP_ROOT = __dirname;
const RES_DIR = path.join(APP_ROOT, 'resources');
const PROJECTS_DIR = path.join(APP_ROOT, '.projects');
const SELFTEST_RAW = process.env.GUI_SELFTEST || (process.argv.find((a) => String(a).startsWith('--selftest=')) || '').split('=').slice(1).join('=');
const SELFTEST = SELFTEST_RAW ? path.resolve(SELFTEST_RAW) : null;
const NO_GPU = !!SELFTEST || !!process.env.GUI_NOGPU;
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
}

const store = new ProjectStore(PROJECTS_DIR);
const state = {
  project: null,
  skin: skinLib.emptySkin(),
  mocks: { message: [], net: [] },
  previewSurface: null,
  previewMode: 'mock',
  picker: false,
  mode: 'off',
  skinVersion: 1,
};

let win = null;
let view = null;
let viewReady = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function response(body, type, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': type || 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function serveFile(abs) {
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('not found', { status: 404 });
  return response(fs.readFileSync(abs), type);
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return null;
  }
}

// ---------- генерація превʼю-сторінок ----------

function previewUrls(surfaceId) {
  const v = state.skinVersion;
  return {
    css: `extgui://p/${skinLib.DIR}/skin.css?v=${v}`,
    data: `extgui://p/${skinLib.DIR}/skin-data.json?v=${v}`,
    runtime: `extgui://p/${skinLib.DIR}/skin-runtime.js?v=${v}`,
  };
}

function mockHostHtml(surface, project) {
  const urls = previewUrls(surface.id);
  const scripts = [];
  const cssLinks = [];
  for (const cs of project.scan.manifest.content_scripts || []) {
    for (const js of cs.js || []) scripts.push(`<script src="extgui://p/${encodeURI(js)}"></script>`);
    for (const css of cs.css || []) cssLinks.push(`<link rel="stylesheet" href="extgui://p/${encodeURI(css)}">`);
  }
  const hostMatch = (surface.matches[0] || '').replace(/^(\w+):\/\/([^/]+).*/, '$1://$2');
  // Полотно навмисне порожнє: у полі редагування має бути лише інтерфейс розширення,
  // щоб мишкою не чіпати сторонні елементи. Контекст справжнього сайту — кнопка «Жива сторінка».
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="gui-skin-scope" content="${scopeKey(surface.id)}">
<title>Інтерфейс розширення — ${escapeHtml(hostMatch || 'page')}</title>
<script src="extgui://r/shim.js"></script>
<link rel="stylesheet" href="${urls.css}">
${cssLinks.join('\n')}
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 13px/1.5 system-ui, sans-serif;
    color: #cfe0f5;
    background-color: #151d2b;
    background-image: linear-gradient(45deg, #121a26 25%, transparent 25%), linear-gradient(-45deg, #121a26 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #121a26 75%), linear-gradient(-45deg, transparent 75%, #121a26 75%);
    background-size: 24px 24px;
    background-position: 0 0, 0 12px, 12px -12px, -12px 0;
  }
  /* Підказка — псевдоелемент: його не можна випадковохопити мишкою як елемент розширення. */
  body::after {
    content: "Тут показано лише інтерфейс розширення (без сторінки-господаря). Контекст реального сайту — кнопка «Жива сторінка».";
    position: fixed;
    left: 14px;
    top: 12px;
    max-width: 70%;
    color: #6d84a3;
    font-size: 12px;
    pointer-events: none;
  }
</style>
</head>
<body data-gui-host="1">
${scripts.join('\n')}
  <script src="${urls.runtime}"></script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Для popup/options: той самий HTML, але з CSP-меою, підключеним shim і (можливо) ще не
// застосованим скін-шаром — щоб було видно правки до запису в файли.
function previewHtmlTransform(html, surface) {
  let text = String(html).replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  const urls = previewUrls(surface.id);
  const inject =
    `\n<script src="extgui://r/shim.js"></script>\n<meta name="gui-skin-scope" content="${scopeKey(surface.id)}">\n<link rel="stylesheet" href="${urls.css}">\n<script src="${urls.runtime}"></script>\n`;
  const head = /<head[^>]*>/i.exec(text);
  if (head) text = text.slice(0, head.index + head[0].length) + inject + text.slice(head.index + head[0].length);
  else text = inject + text;
  const manifestText = JSON.stringify((state.project && state.project.scan.manifest) || {});
  text = text.replace(/<head[^>]*>/i, (m) => `${m}\n<script>window.__guiManifestJson=${manifestText};</script>`);
  return text;
}

// ---------- протокол extgui:// ----------

async function handleProtocol(request) {
  const url = new URL(request.url);
  const host = url.hostname;
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (process.env.GUI_PROTOCOL_DEBUG) console.log('[protocol]', request.method, url.href, '→', host, '/', rel);

  if (host === 'app') {
    const abs = within(APP_ROOT, rel || 'renderer/index.html');
    return serveFile(abs);
  }
  if (host === 'r') {
    return serveFile(within(RES_DIR, rel));
  }
  if (host === 'p') {
    if (!state.project) return new Response('немає відкритого проєкту', { status: 404 });
    if (rel.startsWith(skinLib.DIR + '/')) {
      const name = rel.slice(skinLib.DIR.length + 1).split('?')[0];
      if (name === 'skin.css') return response(buildCss(state.skin), MIME['.css']);
      if (name === 'skin-data.json') return response(JSON.stringify(buildData(state.skin)), MIME['.json']);
      if (name === 'skin-runtime.js') return serveFile(path.join(RES_DIR, 'skin-runtime.js'));
      return new Response('not found', { status: 404 });
    }
    const clean = rel.split('?')[0];
    if (clean.startsWith('__gui_preview__/')) {
      const surfaceId = decodeURIComponent(clean.slice('__gui_preview__/'.length)).replace(/\.html$/, '');
      const surface = state.project.scan.surfaces.find((s) => s.id === surfaceId);
      if (!surface) return new Response('surface not found', { status: 404 });
      return response(mockHostHtml(surface, state.project), MIME['.html']);
    }
    const abs = within(state.project.working, clean);
    let text = readText(abs);
    if (text == null) return new Response('not found: ' + clean, { status: 404 });
    if (url.searchParams.get('guiPreview') === '1' && /\.html?$/i.test(clean)) {
      const surface = state.project.scan.surfaces.find((s) => s.page === clean) || { id: 'page:' + clean, page: clean };
      return response(previewHtmlTransform(text, surface), MIME['.html']);
    }
    return serveFile(abs);
  }
  return new Response('bad host', { status: 404 });
}

// ---------- міст для превʼю (shim -> main) ----------

function matchRule(rules, needle) {
  for (const rule of rules || []) {
    if (!rule || rule.enabled === false) continue;
    const pattern = String(rule.match || '');
    if (!pattern) continue;
    if (rule.mode === 'regex') {
      try {
        if (new RegExp(pattern).test(needle)) return rule;
      } catch (e) {}
    } else if (needle.includes(pattern)) return rule;
  }
  return null;
}

async function handleBridge(type, payload) {
  if (type === 'message') {
    const kind = payload && payload.type ? String(payload.type) : '';
    const rule = matchRule(state.mocks.message, kind || JSON.stringify(payload).slice(0, 200));
    // Тіло мока — це рівно те, що розширення отримає у колбек sendMessage.
    if (rule) return rule.body;
    return { mocked: false, error: `Немає мок-відповіді на повідомлення типу «${kind || '?'}». Додай її на вкладці «Мережа».` };
  }
  if (type === 'net') {
    const url = String((payload && payload.url) || '');
    const rule = matchRule(state.mocks.net, url);
    if (rule) return { status: rule.status || 200, body: typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body ?? null) };
    const timeout = 2500;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await net.fetch(url, {
        method: (payload.method || 'GET').toUpperCase(),
        headers: payload.headers || undefined,
        body: payload.body && payload.method !== 'GET' ? payload.body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      return { status: res.status, body: text, statusText: res.statusText };
    } catch (e) {
      return { status: 503, body: JSON.stringify({ error: `Сервер недоступний із превʼю (${e.name}): ${url}` }), headers: { 'content-type': 'application/json' } };
    }
  }
  if (type === 'open') {
    const url = String((payload && payload.url) || '');
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { ok: true };
  }
  if (type === 'tab-message') return null;
  throw new Error('not supported: ' + type);
}

// ---------- превʼю-view ----------

function ensureView() {
  if (view) return view;
  view = new WebContentsView({
    webPreferences: {
      preload: path.join(APP_ROOT, 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: PREVIEW_PARTITION,
    },
  });
  view.setBackgroundColor('#0b0f17');
  console.log('[preview] contentView?', typeof win.contentView, 'addChildView?', typeof (win.contentView || {}).addChildView, 'addBrowserView?', typeof win.addBrowserView);
  if (win.contentView && typeof win.contentView.addChildView === 'function') win.contentView.addChildView(view);
  else if (typeof win.addBrowserView === 'function') win.addBrowserView(view);
  view.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) console.log('[preview] start-nav', url);
  });
  view.webContents.on('dom-ready', () => console.log('[preview] dom-ready', view.webContents.getURL()));
  view.webContents.on('render-process-gone', (_e, details) => console.log('[preview] render-gone', JSON.stringify(details)));
  view.webContents.on('unresponsive', () => console.log('[preview] unresponsive'));
  view.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (process.env.GUI_PROTOCOL_DEBUG) console.log('[preview console]', message, '(', sourceId, ':', line, ')');
  });
  view.webContents.on('did-finish-load', () => console.log('[preview] finish-load', view.webContents.getURL()));
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[preview] did-fail-load', code, desc, url);
    if (code === -3) return;
    send('preview:event', { __gui: 'log', level: 'error', text: `завантаження не вдалось (${code} ${desc}): ${url}` });
  });
  view.webContents.on('dom-ready', () => {
    viewReady = true;
    if (state.picker) view.webContents.send('gui:picker', true);
    applyHotSkin();
  });
  view.webContents.on('render-process-gone', () => send('preview:event', { __gui: 'log', level: 'error', text: 'процес превʼю впав' }));
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return view;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function previewUrlFor(surface) {
  if (surface.kind === 'content') {
    return `extgui://p/__gui_preview__/${encodeURIComponent(surface.id)}.html`;
  }
  return `extgui://p/${encodeURI(surface.page)}?guiPreview=1`;
}

function openPreview(surfaceId) {
  if (!state.project) return { error: 'Проєкт не відкрито' };
  const surface = state.project.scan.surfaces.find((s) => s.id === surfaceId);
  if (!surface) return { error: 'Поверхню не знайдено: ' + surfaceId };
  state.previewSurface = surface;
  const v = ensureView();
  v.webContents.loadURL(previewUrlFor(surface));
  return { ok: true, surface };
}

function applyHotSkin() {
  if (!view || view.webContents.isDestroyed() || !viewReady) return;
  view.webContents.send('gui:hot', { css: buildCss(state.skin), ops: state.skin.ops });
}

function setMode(next) {
  state.mode = next === 'pick' || next === 'geom' ? next : 'off';
  state.picker = state.mode === 'pick';
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.send('gui:mode', state.mode);
    // Клавіші-стрілки мають приходити в прев'ю, а не в головне вікно конструктора.
    if (state.mode === 'geom') view.webContents.focus();
  }
  send('preview:mode', state.mode);
  return { mode: state.mode };
}

// Результат перетягування/розтягування мишкою: правку вкладаємо в скін і одразу гріємо прев'ю.
function applyGeometry(info) {
  if (!state.project || !state.previewSurface) return { error: 'Немає відкритої поверхні' };
  const selector = String((info && info.selector) || '').trim();
  const style = info && info.style && typeof info.style === 'object' ? info.style : null;
  if (!selector || !style) return { error: 'Не прийшов селектор чи стиль' };
  const surface = state.previewSurface.id;
  let op = null;
  for (const candidate of state.skin.ops) {
    if (candidate.surface === surface && candidate.anchor && candidate.anchor.selector === selector) op = candidate;
  }
  if (!op) {
    op = normaliseSkin({
      schema: skinLib.SCHEMA,
      ops: [{ id: 'geo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5), surface, anchor: { selector }, style: {}, note: String((info && info.note) || '') }],
    }).ops[0];
    state.skin.ops.push(op);
  }
  op.style = { ...(op.style || {}), ...style };
  op.enabled = true;
  if (!op.note) op.note = String((info && info.note) || '');
  state.skin = skinLib.writeSkin(state.project, normaliseSkin(state.skin));
  state.skinVersion += 1;
  applyHotSkin();
  send('preview:geom', {
    skin: state.skin,
    selector,
    surface,
    kind: String((info && info.kind) || 'move'),
    style: op.style,
    unique: info.unique !== false,
  });
  return { ok: true, selector, style: op.style };
}

// «Жива» сторінка: справжній сайт + наші скрипти, щоб бачити панель на реальній сторінці.
async function openLivePreview(surfaceId, url) {
  if (!state.project) return { error: 'Проєкт не відкрито' };
  const surface = state.project.scan.surfaces.find((s) => s.id === surfaceId);
  if (!surface) return { error: 'Поверхню не знайдено' };
  state.previewSurface = surface;
  state.previewMode = 'live';
  const v = ensureView();
  const wc = v.webContents;
  wc.removeAllListeners('did-finish-load');
  wc.once('did-finish-load', async () => {
    const run = async (label, fn) => {
      try {
        await fn();
      } catch (e) {
        send('preview:event', { __gui: 'log', level: 'error', text: `${label}: ${e.message}` });
      }
    };
    await run('shim', () => wc.executeJavaScript(readText(path.join(RES_DIR, 'shim.js')) || 'void 0', true));
    for (const cs of state.project.scan.manifest.content_scripts || []) {
      for (const js of cs.js || []) {
        await run(js, () => wc.executeJavaScript(readText(within(state.project.working, js)) || 'void 0', true));
      }
      for (const css of cs.css || []) {
        await run(css, () => wc.insertCSS(readText(within(state.project.working, css)) || '', { cssOrigin: 'author' }));
      }
    }
    await run('skin', async () => {
      await wc.insertCSS(buildCss(state.skin), { cssOrigin: 'author' });
      const data = JSON.stringify(buildData(state.skin));
      const runtime = readText(path.join(RES_DIR, 'skin-runtime.js')) || 'void 0';
      await wc.executeJavaScript(`window.__GUI_SKIN_DATA__=${data};\n${runtime}`, true);
    });
    send('preview:event', { __gui: 'log', level: 'info', text: 'жива сторінка: скрипти розширення підключені' });
    // Позначаємо <body> як господар: на живій сторінці теж не можна випадковохопити
    // увесь сайт замість елемента розширення.
    await run('хост', () => wc.executeJavaScript(`if(document.body) document.body.dataset.guiHost='1'; void 0`, true));
  });
  wc.loadURL(url);
  return { ok: true };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('gui:bridge', (_e, type, payload) => handleBridge(String(type), payload));
  ipcMain.handle('app:choose', async (_e, opts = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: opts.title || 'Обери теку розширення, .zip або .crx',
      properties: opts.dir ? ['openDirectory'] : ['openFile'],
      filters: opts.dir ? undefined : [{ name: 'Розширення', extensions: ['zip', 'crx', 'xpi'] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('app:import', async (_e, source) => {
    const project = await store.import(String(source));
    useProject(project);
    return describeProject();
  });

  ipcMain.handle('app:open', (_e, id) => {
    useProject(store.open(String(id)));
    return describeProject();
  });

  ipcMain.handle('app:list', () => store.list().map((p) => ({ id: p.id, name: p.name, version: p.version, manifestVersion: p.manifestVersion, importedAt: p.importedAt, lastOpenedAt: p.lastOpenedAt })));

  ipcMain.handle('app:current', () => describeProject());

  ipcMain.handle('app:readFile', (_e, rel) => ({ text: store.readFile(state.project, String(rel)) }));
  ipcMain.handle('app:writeFile', (_e, { rel, text, snapshot }) => {
    const before = store.readFile(state.project, String(rel));
    if (snapshot && before !== String(text)) store.snapshot(state.project, 'перед правкою ' + path.basename(String(rel)));
    store.writeFile(state.project, String(rel), String(text));
    projectRefresh(false);
    return { ok: true };
  });
  ipcMain.handle('app:originalFile', (_e, rel) => ({ text: store.originalFile(state.project, String(rel)) }));
  ipcMain.handle('app:createFile', (_e, { rel, text }) => {
    store.writeFile(state.project, String(rel), String(text));
    projectRefresh(false);
    return { ok: true };
  });
  ipcMain.handle('app:history', (_e, rel) => store.historyList(state.project, String(rel)).map((h) => h.stamp));
  ipcMain.handle('app:restoreHistory', (_e, { rel, stamp }) => {
    const text = store.restoreHistory(state.project, String(rel), String(stamp));
    projectRefresh(false);
    return { text };
  });

  ipcMain.handle('app:getSkin', () => state.skin);
  ipcMain.handle('app:saveSkin', (_e, skin) => {
    state.skin = skinLib.writeSkin(state.project, normaliseSkin(skin));
    state.skinVersion += 1;
    applyHotSkin();
    return state.skin;
  });
  ipcMain.handle('app:applySkin', (_e, skin) => {
    state.skin = skinLib.writeSkin(state.project, normaliseSkin(skin || state.skin));
    store.snapshot(state.project, 'перед застосуванням скіна');
    const report = skinLib.applySkin(state.project, state.skin, RES_DIR);
    projectRefresh(true);
    state.skinVersion += 1;
    applyHotSkin();
    return { report, scan: state.project.scan };
  });
  ipcMain.handle('app:reloadSkinFromDisk', () => {
    state.skin = skinLib.readSkin(state.project);
    return state.skin;
  });

  ipcMain.handle('app:getMocks', () => state.mocks);
  ipcMain.handle('app:saveMocks', (_e, mocks) => {
    state.mocks = { message: (mocks && mocks.message) || [], net: (mocks && mocks.net) || [] };
    fs.writeFileSync(path.join(state.project.base, 'mocks.json'), JSON.stringify(state.mocks, null, 2));
    return state.mocks;
  });

  ipcMain.handle('app:previewOpen', (_e, { surfaceId }) => openPreview(String(surfaceId)));
  ipcMain.handle('app:previewLive', (_e, { surfaceId, url }) => openLivePreview(String(surfaceId), String(url)));
  ipcMain.handle('app:previewBounds', (_e, bounds) => {
    if (!view) return { ok: false };
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(80, Math.round(bounds.width)),
      height: Math.max(80, Math.round(bounds.height)),
    });
    return { ok: true };
  });
  ipcMain.handle('app:previewHide', () => {
    if (view) view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return { ok: true };
  });
  ipcMain.handle('app:previewReload', () => {
    if (!state.previewSurface) return { ok: false };
    openPreview(state.previewSurface.id);
    return { ok: true };
  });
  ipcMain.handle('app:picker', (_e, on) => {
    const result = setMode(on ? 'pick' : 'off');
    return { on: result.mode === 'pick', mode: result.mode };
  });
  ipcMain.handle('app:mode', (_e, next) => setMode(String(next)));
  ipcMain.handle('app:capture', async () => {
    if (!view) return { error: 'Превʼю не відкрито' };
    const image = await view.webContents.capturePage();
    return { dataUrl: image.toDataURL() };
  });
  ipcMain.handle('app:eval', async (_e, code) => {
    if (!view) return { error: 'Превʼю не відкрито' };
    try {
      return { result: await view.webContents.executeJavaScript(String(code), true) };
    } catch (e) {
      return { error: String(e.message) };
    }
  });

  ipcMain.handle('app:snapshot', (_e, label) => store.snapshot(state.project, String(label || 'ручний')));
  ipcMain.handle('app:snapshots', () => store.snapshots(state.project));
  ipcMain.handle('app:restoreSnapshot', (_e, id) => {
    store.restoreSnapshot(state.project, String(id));
    projectRefresh(true);
    return describeProject();
  });
  ipcMain.handle('app:export', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Куди експортувати', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    store.snapshot(state.project, 'перед експортом');
    const report = await store.export(state.project, result.filePaths[0], { zip: true });
    return { ...report, folderHint: report.folder };
  });
  ipcMain.handle('app:reveal', async (_e, target) => {
    const abs = String(target || (state.project && state.project.working));
    if (fs.existsSync(abs)) await shell.openPath(abs);
    return { ok: true };
  });
  ipcMain.handle('app:deleteProject', (_e, id) => {
    store.delete(String(id));
    if (state.project && state.project.meta.id === id) {
      state.project = null;
      state.skin = skinLib.emptySkin();
    }
    return { ok: true };
  });
  ipcMain.handle('app:info', () => ({ appRoot: APP_ROOT, projectsDir: PROJECTS_DIR, electron: process.versions.electron, node: process.versions.node }));

  ipcMain.on('gui:picked', (event, info) => {
    if (!state.project) return;
    const hits = (state.project.scan.labels || []).filter((l) => info.ownText && l.value === info.ownText.trim()).slice(0, 6);
    send('preview:picked', { ...info, labelHits: hits, surface: state.previewSurface ? state.previewSurface.id : null });
  });
  ipcMain.on('gui:geom', (_e, info) => {
    const result = applyGeometry(info);
    if (result && result.error) send('preview:event', { __gui: 'log', level: 'error', text: result.error });
  });
  ipcMain.on('gui:mode-off', () => setMode('off'));
  ipcMain.on('gui:event', (_e, payload) => send('preview:event', payload));
  ipcMain.on('gui:ready', () => {
    viewReady = true;
    applyHotSkin();
    if (state.mode !== 'off') view.webContents.send('gui:mode', state.mode);
    send('preview:ready', { surface: state.previewSurface ? state.previewSurface.id : null });
  });
}

function useProject(project) {
  state.project = project;
  state.skin = skinLib.readSkin(project);
  state.previewSurface = null;
  state.skinVersion += 1;
  const mocksPath = path.join(project.base, 'mocks.json');
  try {
    state.mocks = fs.existsSync(mocksPath) ? JSON.parse(fs.readFileSync(mocksPath, 'utf8')) : { message: [], net: [] };
  } catch (e) {
    state.mocks = { message: [], net: [] };
  }
  if (view && !view.webContents.isDestroyed()) view.webContents.loadURL('about:blank');
}

function projectRefresh(reopen) {
  state.project.scan = require('./lib/scan').scanProject(state.project.working);
  const surfaceId = state.previewSurface && state.previewSurface.id;
  if (reopen && surfaceId) {
    const next = state.project.scan.surfaces.find((s) => s.id === surfaceId);
    if (next) openPreview(next.id);
  }
}

function describeProject() {
  if (!state.project) return null;
  const { meta, scan } = state.project;
  return {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    manifestVersion: scan.manifestVersion,
    working: scan.root,
    surfaces: scan.surfaces,
    pages: scan.pages,
    styles: scan.styles,
    scripts: scan.scripts,
    textFiles: (scan.allFiles || []).filter((rel) => /\.(html?|css|m?js|json|txt|md)$/i.test(rel)),
    labels: scan.labels,
    locales: Object.keys(scan.locales),
    localeBag: (scan.locales && (scan.locales.uk || scan.locales.en)) || {},
    cssVars: scan.cssVars,
    warnings: scan.warnings,
    permissions: scan.permissions,
    fileCount: scan.fileCount,
    applied: fs.existsSync(path.join(scan.root, skinLib.DIR, 'skin.css')),
  };
}

// ---------- selftest ----------

async function runSelftest(importPath) {
  const out = { ok: false, steps: [] };
  let project = null;
  const resultDir = path.join(APP_ROOT, '.selftest');
  fs.mkdirSync(resultDir, { recursive: true });
  const writeResult = () => fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify(out, null, 2));
  const log = (name, data) => {
    out.steps.push({ name, data });
    console.log('[selftest]', name, JSON.stringify(data).slice(0, 400));
  };
  try {
    project = await store.import(importPath);
    useProject(project);
    log('import', { id: project.meta.id, surfaces: project.scan.surfaces.map((s) => s.id), labels: project.scan.labels.length, warnings: project.scan.warnings });
    await win.webContents.executeJavaScript('window.__guiRefresh && window.__guiRefresh()');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const uiProbe = await win.webContents.executeJavaScript(
      `({
         chip: document.getElementById('project-chip').textContent,
         surfaces: document.querySelectorAll('#surfaces-list .surface').length,
         labels: document.querySelectorAll('#labels-list .label-item').length,
         files: document.querySelectorAll('#file-picker option').length,
         log: document.getElementById('log').textContent.slice(-200)
       })`,
      true,
    );
    log('ui', uiProbe);
    fs.writeFileSync(path.join(resultDir, 'app.png'), (await win.capturePage()).toPNG());
    const target = project.scan.surfaces.find((s) => s.kind === 'content') || project.scan.surfaces[0];
    if (!target) throw new Error('немає жодної UI-поверхні');
    state.mocks = {
      message: [
        {
          match: 'cmpf:etalon',
          mode: 'contains',
          enabled: true,
          body: {
            ok: true,
            status: 200,
            data: {
              available_sheets: ['filtr_НІЧНА', 'filtr_ДЕННА'],
              sheet_name: 'filtr_НІЧНА',
              posts: {
                'Пост Північ': { standard_freqs: ['14150.0', '7045,5', '5362.0'] },
                'Пост Захід': { standard_freqs: ['3905.0', '5412.0'] },
              },
            },
          },
        },
      ],
      net: [],
    };
    ensureView();
    view.setBounds({ x: 40, y: 40, width: 1120, height: 700 });
    openPreview(target.id);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      view.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const probe = await view.webContents.executeJavaScript(
      `({
         url: location.href,
         nodes: document.querySelectorAll('*').length,
         hostFixtures: document.querySelectorAll('.mk-top, .mk-body, .mk-side, .mk-main, .mk-row').length,
         hostFlag: !!(document.body && document.body.dataset.guiHost),
         text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160),
         postOptions: Array.from(document.querySelectorAll('#cmpf-post option')).map((o) => o.textContent.trim()),
         panel: !!document.querySelector('#cmpf-panel, #demo-panel, #popup-title')
       })`,
      true,
    );
    log('preview', { surface: target.id, probe });
    if (probe.nodes < 10) throw new Error('у превʼю майже немає елементів — інтерфейс розширення не збудувався');
    if (probe.hostFixtures) throw new Error('у полі редагування лишились елементи сторінки-господаря: ' + probe.hostFixtures);
    if (target.kind === 'content' && !probe.hostFlag) throw new Error('полото не позначено як «господар» — можна випадковохопити <body> замість елемента розширення');
    fs.writeFileSync(path.join(resultDir, 'preview.png'), (await view.webContents.capturePage()).toPNG());

    // Кінець у кінець: вмикаємо вибір елемента й реально клікаємо мишкою по інтерфейсу.
    const pickedPromise = new Promise((resolve) => {
      const handler = (_e, info) => {
        ipcMain.removeListener('gui:picked', handler);
        resolve(info);
      };
      ipcMain.on('gui:picked', handler);
      setTimeout(() => {
        ipcMain.removeListener('gui:picked', handler);
        resolve(null);
      }, 8000);
    });
    view.webContents.send('gui:picker', true);
    const point = await view.webContents.executeJavaScript(
      `(()=>{
         const el = document.querySelector('#cmpf-panel, #demo-panel, #popup-title, h1, button, select') || document.body;
         const r = el.getBoundingClientRect();
         return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(14, r.height / 2)) };
       })()`,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    view.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 200));
    view.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, clickCount: 1 });
    const picked = await pickedPromise;
    log('pick', { point, picked: picked ? { selector: picked.selector, text: picked.ownText, styles: Object.keys(picked.styles).length } : null });
    if (!picked || !picked.selector) throw new Error('вибір елемента кліком не спрацював');

    const skin = normaliseSkin({
      schema: skinLib.SCHEMA,
      ops: [
        { id: 't1', surface: target.id, anchor: { selector: picked.selector }, style: { 'background-color': '#12301a', 'border-radius': '18px' } },
        { id: 't2', surface: target.id, anchor: { selector: picked.selector }, text: { mode: 'replace', value: 'ТЕСТОВА ПРАВКА' } },
      ],
    });
    state.skin = skinLib.writeSkin(project, skin);
    state.skinVersion += 1;
    applyHotSkin();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const after = await view.webContents.executeJavaScript(
      `(()=>{
         const el = document.querySelector(${JSON.stringify(picked.selector)});
         if (!el) return { found: false };
         const cs = getComputedStyle(el);
         return { found: true, bg: cs.backgroundColor, radius: cs.borderRadius, text: el.textContent.trim().slice(0, 40), scope: document.documentElement.getAttribute('data-gui-scope') };
       })()`,
      true,
    );
    log('skin', after);
    fs.writeFileSync(path.join(resultDir, 'preview-skinned.png'), (await view.webContents.capturePage()).toPNG());
    if (!after.found) throw new Error('селектор із пікера не знайшов елемент');
    if (after.bg !== 'rgb(18, 48, 26)') throw new Error('CSS зі скіна не застосувався (scope=' + after.scope + ')');
    if (after.text !== 'ТЕСТОВА ПРАВКА') throw new Error('текстова правка не застосувалась: ' + after.text);
    if (probe.postOptions.length && probe.postOptions.length < 3) throw new Error('дані з мока не дійшли до панелі');

    // ---------- рух і розмір мишкою ----------
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const dragTo = async (from, dx, dy) => {
      await view.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
      await sleep(160);
      await view.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, clickCount: 1 });
      const steps = 6;
      for (let i = 1; i <= steps; i += 1) {
        await view.webContents.sendInputEvent({ type: 'mouseMove', x: from.x + Math.round((dx * i) / steps), y: from.y + Math.round((dy * i) / steps), clickCount: 1 });
        await sleep(35);
      }
      await view.webContents.sendInputEvent({ type: 'mouseUp', x: from.x + dx, y: from.y + dy, clickCount: 1 });
      await sleep(450);
    };
    const rectOf = (selector) => view.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+Math.min(10,r.height/2)), w:Math.round(r.width), h:Math.round(r.height), cssW:cs.width, cssH:cs.height, pos:cs.position, left:cs.left, top:cs.top};})()`,
      true,
    );
    setMode('geom');
    const start = await rectOf(picked.selector);
    if (!start) throw new Error('не вдалось виміряти елемент перед рухом');
    await dragTo({ x: start.x, y: start.y }, -48, 30);
    const moveOp = [...state.skin.ops].reverse().find((o) => o.style && o.style.position && o.style.left && o.style.top);
    log('geom-move', { start: { w: start.w, h: start.h }, op: moveOp && { selector: moveOp.anchor.selector, style: moveOp.style } });
    if (!moveOp) throw new Error('перетягування мишкою не створило правку');
    if (moveOp.style.left !== '-48px' || moveOp.style.top !== '30px') throw new Error('зміщення не збіглось: ' + moveOp.style.left + '/' + moveOp.style.top);
    const movedRect = await rectOf(moveOp.anchor.selector);
    if (!movedRect || movedRect.left !== '-48px' || movedRect.top !== '30px') {
      throw new Error('після відпускання миші елемент не на новому місці: ' + (movedRect && (movedRect.left + '/' + movedRect.top)));
    }

    await view.webContents.sendInputEvent({ type: 'mouseMove', x: movedRect.x, y: movedRect.y });
    await sleep(250);
    const handlePoint = await view.webContents.executeJavaScript(
      `(()=>{const se=[...document.querySelectorAll('[data-gui-handle="se"]')].find(h=>h.getClientRects().length);if(!se)return null;const r=se.getBoundingClientRect();return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`,
      true,
    );
    if (!handlePoint) throw new Error('ручки зміни розміру не зʼявились');
    await dragTo(handlePoint, 30, 18);
    const resizeOp = [...state.skin.ops].reverse().find((o) => o.anchor.selector === moveOp.anchor.selector && o.style && o.style.width && o.style.height);
    log('geom-resize', { handlePoint, before: { w: movedRect.w, h: movedRect.h }, style: resizeOp && resizeOp.style });
    if (!resizeOp) throw new Error('розтягування за ручку не створило правку розміру');
    const afterResize = await rectOf(moveOp.anchor.selector);
    if (!afterResize) throw new Error('елемент зник після розтягування');
    if (Math.abs(afterResize.w - movedRect.w) < 10) throw new Error('ширина не змінилась: ' + movedRect.w + ' → ' + afterResize.w);
    if (Math.abs(parseFloat(afterResize.cssW) - parseFloat(resizeOp.style.width)) > 1.5) {
      throw new Error('записаний розмір не збігається з фактичним: ' + resizeOp.style.width + ' vs ' + afterResize.cssW);
    }
    setMode('off');
    fs.writeFileSync(path.join(resultDir, 'preview-geom.png'), (await view.webContents.capturePage()).toPNG());

    // ---------- регресія: рух одного елемента не повинен тягнути сусідів ----------
    // Раніше селектор-генератор обрізав шлях до батька з id (#cmpf-body), тож перетягування
    // підпису «Аркуш» рухало всю контейнерну колонку.
    const leaf = await view.webContents.executeJavaScript(
      `(()=>{
        const cands = [...document.querySelectorAll('body *')].filter((el) => {
          if (el.children.length || !el.nextElementSibling) return false;
          if (el.dataset.guiSkin) return false;
          if (el.textContent.trim().length < 3) return false;
          if (!el.parentElement || el.parentElement.children.length < 3) return false;
          const s = el.nextElementSibling.getBoundingClientRect();
          if (s.width < 8 || s.height < 8) return false;
          return s.top >= el.getBoundingClientRect().bottom;
        });
        // Беремо той кандидат, по якому клік справді потрапить у нього (а не в елемент поверх).
        let el = null, point = null;
        for (const c of cands) {
          const r = c.getBoundingClientRect();
          if (r.width < 24 || r.height < 8 || r.top <= 0) continue;
          const p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          if (document.elementFromPoint(p.x, p.y) === c) { el = c; point = p; break; }
        }
        if (!el) return null;
        el.dataset.probeEl = '1';
        el.nextElementSibling.dataset.probeNext = '1';
        const r = el.getBoundingClientRect();
        const rs = el.nextElementSibling.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: el.textContent.trim().slice(0, 24),
          x: point.x,
          y: point.y,
          top: Math.round(r.top),
          sibTop: Math.round(rs.top),
          leaves: cands.length,
        };
      })()`,
      true,
    );
    if (!leaf) throw new Error('у превʼю немає листового елемента з видимим сусідом — не чим перевіряти точність вибору');
    setMode('geom');
    await view.webContents.sendInputEvent({ type: 'mouseMove', x: leaf.x, y: leaf.y });
    await sleep(250);
    // У маленького елемента центр часто потрапляє на ручку зміни розміру — шукаємо точку,
    // за якої клік дістає саме елемент, а не нашу ручку.
    const leafPoint = await view.webContents.executeJavaScript(
      `(()=>{
        const el = document.querySelector('[data-probe-el="1"]');
        if (!el) return null;
        const sib = document.querySelector('[data-probe-next="1"]');
        const r = el.getBoundingClientRect();
        // Вимірюємо «до» вже в режимі геометрії: тож подальший зсув на 14 px точний.
        const before = { x: 0, y: 0, top: Math.round(r.top), sibTop: sib ? Math.round(sib.getBoundingClientRect().top) : -1 };
        for (const fy of [0.5, 0.42, 0.58, 0.3, 0.7]) {
          for (const fx of [0.25, 0.5, 0.75, 0.35, 0.65]) {
            const p = { x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) };
            if (document.elementFromPoint(p.x, p.y) === el) return { ...before, ...p };
          }
        }
        return null;
      })()`,
      true,
    );
    if (!leafPoint) throw new Error('не знайшли точку на елементі «' + leaf.text + '», вільну від ручок розміру');
    const geomEvents = [];
    const collectGeom = (_e, info) => geomEvents.push({ selector: info.selector, kind: info.kind, style: info.style, note: info.note });
    ipcMain.on('gui:geom', collectGeom);
    await dragTo(leafPoint, 0, -14);
    ipcMain.removeListener('gui:geom', collectGeom);
    const geomOps = state.skin.ops.filter((o) => o.style && o.style.position && o.style.top);
    const leafOp = geomOps[geomOps.length - 1];
    const leafAfter = await view.webContents.executeJavaScript(
      `(()=>{
        const a = document.querySelector('[data-probe-el="1"]');
        const b = document.querySelector('[data-probe-next="1"]');
        if (!a || !b) return { ok: false, reason: 'зникли пробі-мітки' };
        const sel = ${JSON.stringify(leafOp ? leafOp.anchor.selector : '')};
        let hits = 0, exact = false;
        try { const f = document.querySelectorAll(sel); hits = f.length; exact = hits === 1 && f[0] === a; } catch (e) {}
        return { ok: true, sel, hits, exact, top: Math.round(a.getBoundingClientRect().top), sibTop: Math.round(b.getBoundingClientRect().top) };
      })()`,
      true,
    );
    log('geom-leaf', { leaf, point: leafPoint, events: geomEvents, op: leafOp && { selector: leafOp.anchor.selector, style: leafOp.style }, after: leafAfter });
    if (!leafOp) throw new Error('перетягування leaf-елемента не створило правку');
    if (geomEvents.length !== 1 || geomEvents[0].kind !== 'move') throw new Error('перетягування пішло не як «рух»: ' + JSON.stringify(geomEvents));
    if (!leafAfter.ok) throw new Error('перевірку leaf-елемента не вдалось виконати: ' + leafAfter.reason);
    if (!leafAfter.exact) throw new Error('селектор правки вказує не на той елемент (' + leafAfter.hits + ' збігів): ' + leafAfter.sel);
    if (leafAfter.top !== leafPoint.top - 14) throw new Error('елемент зсунувся не на 14 px: ' + leafPoint.top + ' → ' + leafAfter.top);
    if (leafAfter.sibTop !== leafPoint.sibTop) throw new Error('рух одного елемента затягнув сусідів: сусід ' + leafPoint.sibTop + ' → ' + leafAfter.sibTop);

    // ---------- стрілки: піксель за пікселем ----------
    view.webContents.focus();
    await sleep(120);
    const key = async (keyCode, modifiers) => {
      const opts = { type: 'keyDown', keyCode };
      if (modifiers) opts.modifiers = modifiers;
      await view.webContents.sendInputEvent(opts);
      await view.webContents.sendInputEvent({ type: 'keyUp', keyCode, ...(modifiers ? { modifiers } : {}) });
      await sleep(90);
    };
    const geomOf = () => view.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('[data-probe-el="1"]');if(!el)return null;const cs=getComputedStyle(el);return {left:parseFloat(cs.left)||0, top:parseFloat(cs.top)||0};})()`,
      true,
    );
    const beforeKeys = await geomOf();
    for (let i = 0; i < 3; i += 1) await key('Down');
    await sleep(400);
    const afterDown = await geomOf();
    for (let i = 0; i < 2; i += 1) await key('Right');
    await sleep(400);
    const afterRight = await geomOf();
    await key('Down', ['shift']);
    await sleep(400);
    const afterShift = await geomOf();
    const keyOps = [...state.skin.ops].reverse().filter((o) => o.anchor.selector === leafOp.anchor.selector && o.style && o.style.position).slice(0, 4).map((o) => ({ left: o.style.left, top: o.style.top, note: o.note }));
    log('geom-arrows', { beforeKeys, afterDown, afterRight, afterShift, ops: keyOps });
    if (!beforeKeys || !afterDown || !afterRight || !afterShift) throw new Error('не вдалось виміряти елемент під час руху стрілками');
    if (afterDown.top !== beforeKeys.top + 3) throw new Error('стрілка ↓ не дає крок 1 px: ' + beforeKeys.top + ' → ' + afterDown.top);
    if (afterRight.left !== beforeKeys.left + 2) throw new Error('стрілка → не дає крок 1 px: ' + beforeKeys.left + ' → ' + afterRight.left);
    if (afterShift.top !== afterDown.top + 10) throw new Error('Shift + ↓ не дає крок 10 px: ' + afterDown.top + ' → ' + afterShift.top);
    fs.writeFileSync(path.join(resultDir, 'preview-arrows.png'), (await view.webContents.capturePage()).toPNG());
    setMode('off');

    const report = skinLib.applySkin(project, state.skin, RES_DIR);
    log('apply', report);
    if (!report.written.length) throw new Error('скін-шар не записано у файли');
    const manifestAfter = JSON.parse(fs.readFileSync(path.join(project.working, 'manifest.json'), 'utf8'));
    const patchedPages = project.scan.pages.filter((page) => /gui-skin/.test(fs.readFileSync(path.join(project.working, page), 'utf8')));
    log('files', {
      content_scripts: (manifestAfter.content_scripts || []).length,
      war: (manifestAfter.web_accessible_resources || []).length,
      patchedPages,
    });
    if (target.kind === 'content' && (manifestAfter.content_scripts || []).length !== project.scan.surfaces.filter((s) => s.kind === 'content').length + 1) {
      throw new Error('manifest не доповнено нашим content_scripts-записом');
    }
    if (target.kind !== 'content' && !patchedPages.length) throw new Error('у сторінку не підключено шар');

    state.skin = skinLib.writeSkin(project, skinLib.emptySkin());
    const stripReport = skinLib.applySkin(project, state.skin, RES_DIR);
    const manifestStripped = JSON.parse(fs.readFileSync(path.join(project.working, 'manifest.json'), 'utf8'));
    const stillPatched = project.scan.pages.filter((page) => /gui-skin/.test(fs.readFileSync(path.join(project.working, page), 'utf8')));
    log('strip', {
      removed: stripReport.removed,
      content_scripts: (manifestStripped.content_scripts || []).length,
      hasGuiDir: fs.existsSync(path.join(project.working, skinLib.DIR)),
      stillPatched,
    });
    if (!stripReport.removed || stillPatched.length || fs.existsSync(path.join(project.working, skinLib.DIR))) {
      throw new Error('зняття шару лишило сліди у файлах');
    }
    const untouched = (() => {
      const same = (a, b) => fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
      return project.scan.scripts.every((s) => same(path.join(project.working, s.rel), path.join(project.original, s.rel)));
    })();
    log('logic-untouched', untouched);
    if (!untouched) throw new Error('JS-файли розширення змінились — конструктор не має їх чіпати');

    // Окремий шлях коду: сторінки розширення (popup/options) рендеряться з трансформацією HTML.
    for (const page of project.scan.surfaces.filter((s) => s.kind !== 'content')) {
      openPreview(page.id);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        view.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const pageProbe = await view.webContents.executeJavaScript(
        `({ url: location.href, nodes: document.querySelectorAll('*').length, title: document.title, text: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0, 80) })`,
        true,
      );
      log('page-preview', { surface: page.id, probe: pageProbe });
      if (pageProbe.nodes < 5) throw new Error('сторінка ' + page.id + ' не відтворилась у превʼю');
    }
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.stack);
    console.error('[selftest] FAIL', e);
  }
  writeResult();
  // Автотест не має залишати проєктів у .projects.
  if (project) {
    try {
      state.project = null;
      store.delete(project.meta.id);
    } catch (e) {
      console.log('[selftest] cleanup skip:', String(e));
    }
  }
  app.exit(out.ok ? 0 : 1);
}

// ---------- запуск ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'extgui', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const PREVIEW_PARTITION = 'gui-preview';

app.whenReady().then(async () => {
  protocol.handle('extgui', handleProtocol);
  // Прев'ю відкрито в окремій сесії — туди теж треба підв'язати extgui://.
  session.fromPartition(PREVIEW_PARTITION).protocol.handle('extgui', handleProtocol);
  registerIpc();

  if (SELFTEST) {
    try {
      const probe = await net.fetch('extgui://app/renderer/index.html');
      const body = await probe.text();
      console.log('[selftest] protocol probe:', probe.status, 'bytes', body.length);
    } catch (e) {
      console.log('[selftest] protocol probe FAILED:', e.message);
    }
  }

  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0f17',
    title: 'Конструктор GUI для розширень',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setTitle('Конструктор GUI для розширень');
  if (SELFTEST) win.webContents.on('console-message', (event) => console.log('[app console]', event.level, String(event.message).slice(0, 240)));
  await win.loadURL('extgui://app/renderer/index.html');

  if (SELFTEST) {
    await runSelftest(SELFTEST);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
