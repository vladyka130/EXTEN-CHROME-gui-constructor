// Ізольований світ прев'ю. Робить три речі:
// 1) підсвітку і вибір елемента кліком (підсвітка + збір селектора/стилів) → в конструктор;
// 2) перетягування мишкою (рух) і зміну розміру за ручки, а також точний крок стрілками
//    (1 px, Shift — 10 px) — на результат дивимось одразу, а по завершенню правка летить у скін;
// 3) гаряче застосування скіна (CSS + текстові правки) без перезавантаження сторінки
//    та міст між shim.js і головним процесом.
const { ipcRenderer } = require('electron');

const PICK_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'max-width', 'padding', 'margin', 'gap',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'color', 'background-color', 'background', 'opacity', 'border', 'border-radius', 'box-shadow', 'cursor',
];

// 'off' — нічого; 'pick' — вибір кліком; 'geom' — рух і розмір мишкою.
let mode = 'off';
let hoverEl = null;
let lockEl = null;
let box = null;
let chip = null;
let handleBar = null;
let drag = null;
let pendingClear = null;

const HANDLE_SPEC = [
  ['nw', 0, 0, 'nwse-resize'],
  ['n', 0.5, 0, 'ns-resize'],
  ['ne', 1, 0, 'nesw-resize'],
  ['e', 1, 0.5, 'ew-resize'],
  ['se', 1, 1, 'nwse-resize'],
  ['s', 0.5, 1, 'ns-resize'],
  ['sw', 0, 1, 'nesw-resize'],
  ['w', 0, 0.5, 'ew-resize'],
];

function ensureOverlay() {
  if (box && document.documentElement.contains(box)) return;
  box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;z-index:2147483646;pointer-events:none;border:1.5px solid #6aa6ff;background:rgba(106,166,255,.14);display:none');
  chip = document.createElement('div');
  chip.setAttribute('style', 'position:fixed;z-index:2147483647;pointer-events:none;display:none;font:11px/1.6 system-ui;color:#fff;background:#2b6fd6;padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:46vw;overflow:hidden;text-overflow:ellipsis');
  handleBar = document.createElement('div');
  handleBar.setAttribute('style', 'position:fixed;left:0;top:0;z-index:2147483647;display:none');
  for (const [name, fx, fy, cursor] of HANDLE_SPEC) {
    const h = document.createElement('div');
    h.dataset.guiHandle = name;
    h.dataset.fx = String(fx);
    h.dataset.fy = String(fy);
    h.setAttribute('style', 'position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;border:1.5px solid #fff;background:#2b6fd6;border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,.5);cursor:' + cursor);
    handleBar.appendChild(h);
  }
  const root = document.documentElement || document.body;
  root.appendChild(box);
  root.appendChild(chip);
  root.appendChild(handleBar);
}

function hideOverlay() {
  if (!box) return;
  box.style.display = 'none';
  chip.style.display = 'none';
  handleBar.style.display = 'none';
}

function isOurs(el) {
  return !el || el === box || el === chip || el === handleBar || !!(el.dataset && el.dataset.guiHandle);
}

// Сторінка-господар (мімія-полото чи живий сайт): її <html>/<body> до інтерфейсу розширення
// не належать, тому не беремо їх у здобич. Для popup/options тіло сторінки — саме інтерфейс,
// тож воно лишається доступним для вибору.
function isHostShell(el) {
  if (!el || !document.body || !document.body.dataset.guiHost) return false;
  return el === document.body || el === document.documentElement;
}

function isTarget(el) {
  return !isOurs(el) && !isHostShell(el);
}

function describe(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? '#' + el.id : '';
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return (tag + id + cls).slice(0, 80);
}

function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
    // Ланцюжок збирається знизу вгору; якщо зустріли елемента з id — ним і завершуємо шлях,
    // але накопичені частини обов'язково лишаємо: інакше селектор вказував би на весь контейнер.
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      return parts.join(' > ');
    }
    let part = node.tagName.toLowerCase();
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) part += '.' + cls.slice(0, 2).join('.');
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
    if (parts.length > 6) break;
  }
  return parts.join(' > ');
}

function uniqueSelector(el) {
  const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
  const candidates = [];
  if (el.id) candidates.push('#' + CSS.escape(el.id));
  for (const attr of el.attributes) {
    // data-probe-* — мітки самоперевірки; ігноруємо, щоб тест перевіряв справжню генерацію селектора.
    if (/^(id|class|style|data-gui-skin|data-gui-orig|data-probe-\w+)$/.test(attr.name)) continue;
    if (/^data-/.test(attr.name)) candidates.push(`[${attr.name}="${attr.value.replace(/"/g, '')}"]`);
  }
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  if (cls.length) candidates.push(el.tagName.toLowerCase() + '.' + cls.map((c) => CSS.escape(c)).join('.'));
  candidates.push(cssPath(el));
  for (const sel of candidates) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length === 1 && found[0] === el) return { selector: sel, ownText };
    } catch (e) {}
  }
  return { selector: candidates[candidates.length - 1], ownText };
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function capture(el, point) {
  const computed = getComputedStyle(el);
  const styles = {};
  for (const prop of PICK_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value && value !== 'normal' && value !== 'auto' && value !== 'none' && value !== 'static' && value !== 'rgba(0, 0, 0, 0)' && value !== '0px') styles[prop] = value;
  }
  const { selector, ownText } = uniqueSelector(el);
  const attrs = {};
  for (const a of el.attributes) if (a.name !== 'style') attrs[a.name] = a.value.slice(0, 160);
  const chain = [];
  let node = el.parentElement;
  while (node && node.tagName !== 'HTML' && chain.length < 6) {
    chain.push(describe(node));
    node = node.parentElement;
  }
  return {
    selector,
    ownText,
    text: (el.textContent || '').trim().slice(0, 200),
    tag: el.tagName.toLowerCase(),
    attrs,
    styles,
    rect: rectOf(el),
    chain,
    html: el.outerHTML.slice(0, 600),
    point,
    pageUrl: location.href,
    scope: document.documentElement.getAttribute('data-gui-scope') || '',
  };
}

function drawBox(el, label) {
  ensureOverlay();
  const r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = r.left + 'px';
  box.style.top = r.top + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
  chip.style.display = 'block';
  chip.style.left = Math.max(2, r.left) + 'px';
  chip.style.top = Math.max(2, r.top - 20) + 'px';
  chip.textContent = label || describe(el);
}

function drawHandles(el) {
  if (mode !== 'geom' || !el || drag) {
    if (handleBar && !drag) handleBar.style.display = 'none';
    return;
  }
  ensureOverlay();
  const r = el.getBoundingClientRect();
  handleBar.style.display = 'block';
  handleBar.style.left = '0';
  handleBar.style.top = '0';
  for (const h of handleBar.children) {
    h.style.left = r.left + Number(h.dataset.fx) * r.width + 'px';
    h.style.top = r.top + Number(h.dataset.fy) * r.height + 'px';
  }
}

// ---------- геометрія ----------

// Поточні left/top, від яких рахуємо зміщення. Для static/relative це просто нулі або
// вже виставлені відступи; для absolute/fixed з auto — фактичне положення у контейнері.
function baseOffsets(el) {
  const cs = getComputedStyle(el);
  const pos = cs.position === 'static' ? 'relative' : cs.position;
  const px = (v) => (/px$/.test(v) ? Math.round(parseFloat(v)) : null);
  let left = px(cs.left);
  let top = px(cs.top);
  if (pos === 'relative' || pos === 'static') {
    left = left == null ? 0 : left;
    top = top == null ? 0 : top;
  } else if (left == null || top == null) {
    const r = el.getBoundingClientRect();
    if (pos === 'fixed') {
      left = left == null ? Math.round(r.left) : left;
      top = top == null ? Math.round(r.top) : top;
    } else {
      const parent = el.offsetParent || document.documentElement;
      const pr = parent.getBoundingClientRect();
      left = left == null ? Math.round(r.left - pr.left) : left;
      top = top == null ? Math.round(r.top - pr.top) : top;
    }
  }
  return { pos, left, top };
}

function moveStyle(dx, dy, shift) {
  let x = dx;
  let y = dy;
  if (shift) {
    if (Math.abs(dx) >= Math.abs(dy)) y = 0;
    else x = 0;
  }
  return {
    position: drag.base.pos,
    left: Math.round(drag.base.left + x) + 'px',
    top: Math.round(drag.base.top + y) + 'px',
  };
}

function resizeStyle(dx, dy, handle, shift) {
  const r = drag.rect;
  const hasE = handle.indexOf('e') >= 0;
  const hasW = handle.indexOf('w') >= 0;
  const hasS = handle.indexOf('s') >= 0;
  const hasN = handle.indexOf('n') >= 0;
  let w = r.width + (hasE ? dx : 0) - (hasW ? dx : 0);
  let h = r.height + (hasS ? dy : 0) - (hasN ? dy : 0);
  if (shift && (hasE || hasW) && (hasS || hasN) && r.width > 0 && r.height > 0) {
    const ratio = r.height / r.width;
    if (Math.abs(dx) >= Math.abs(dy)) h = w * ratio;
    else w = h / ratio;
  }
  w = Math.max(8, Math.round(w));
  h = Math.max(8, Math.round(h));
  const style = { 'box-sizing': 'border-box', width: w + 'px', height: h + 'px' };
  // Край, що тягнеться (захід/північ), зсуває й сам елемент.
  const shiftX = hasW ? r.width - w : 0;
  const shiftY = hasN ? r.height - h : 0;
  if (shiftX || shiftY) {
    style.position = drag.base.pos;
    style.left = Math.round(drag.base.left + shiftX) + 'px';
    style.top = Math.round(drag.base.top + shiftY) + 'px';
  }
  return style;
}

function setInline(el, style) {
  for (const [prop, value] of Object.entries(style)) el.style.setProperty(prop, value, 'important');
}

// Обмеження розширення (min/max, флекс-розподіл у контейнері) можуть не дати розтягнути
// елемент. Тоді знімаємо їх і переводимо флекс-елемент у фіксований розмір — так числа
// на екрані й у правці збігаються.
function fitStyle(el, style) {
  const wantW = style.width ? parseFloat(style.width) : null;
  const wantH = style.height ? parseFloat(style.height) : null;
  setInline(el, style);
  let r = el.getBoundingClientRect();
  if (wantW != null && Math.abs(r.width - wantW) > 1) {
    style['min-width'] = '0';
    style['max-width'] = 'none';
    style['flex-grow'] = '0';
    style['flex-shrink'] = '0';
    style['flex-basis'] = 'auto';
    setInline(el, style);
    r = el.getBoundingClientRect();
  }
  if (wantH != null && Math.abs(r.height - wantH) > 1) {
    style['min-height'] = '0';
    style['max-height'] = 'none';
    style['flex-grow'] = '0';
    style['flex-shrink'] = '0';
    style['flex-basis'] = 'auto';
    setInline(el, style);
    r = el.getBoundingClientRect();
  }
  if (wantW != null) style.width = Math.round(r.width) + 'px';
  if (wantH != null) style.height = Math.round(r.height) + 'px';
  return style;
}

function liveDrag(event) {
  let dx = event.clientX - drag.startX;
  let dy = event.clientY - drag.startY;
  if (!drag.moved && !drag.handle && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
  drag.moved = true;
  let style = drag.handle ? resizeStyle(dx, dy, drag.handle, event.shiftKey) : moveStyle(dx, dy, event.shiftKey);
  if (drag.handle) style = fitStyle(drag.el, style);
  else setInline(drag.el, style);
  drag.style = style;
  const r = drag.el.getBoundingClientRect();
  drawBox(drag.el, drag.handle ? `${Math.round(r.width)} × ${Math.round(r.height)} px` : `Δ ${dx >= 0 ? '+' : ''}${dx} · ${dy >= 0 ? '+' : ''}${dy} px`);
  drawHandles(drag.el);
  event.preventDefault();
  event.stopPropagation();
}

function commitGeom(el, style, kind, note) {
  if (!el || !style) return;
  const { selector, ownText } = uniqueSelector(el);
  let unique = true;
  try {
    const found = document.querySelectorAll(selector);
    unique = found.length === 1 && found[0] === el;
  } catch (e) {}
  ipcRenderer.send('gui:geom', {
    kind,
    selector,
    ownText,
    unique,
    style,
    note: note + ': ' + describe(el),
    rect: rectOf(el),
    pageUrl: location.href,
  });
  // Інлайн-стилі тримаємо, доки не прийде новий CSS: так немає «стрибка».
  pendingClear = { el, props: Object.keys(style) };
}

function commitDrag() {
  const el = drag.el;
  const style = drag.style;
  const handle = drag.handle;
  drag = null;
  handleBar.style.display = 'none';
  commitGeom(el, style, handle ? 'resize' : 'move', handle ? 'розмір мишкою' : 'рух мишкою');
}

// ---------- точний рух стрілками ----------

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
let nudgeTimer = null;
let nudgeStyle = null;

function scheduleNudgeCommit(el) {
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    commitGeom(el, nudgeStyle, 'move', 'рух стрілками');
  }, 140);
}

function nudge(dx, dy) {
  const el = lockEl && document.documentElement.contains(lockEl) ? lockEl : null;
  if (!el) return false;
  const base = baseOffsets(el);
  nudgeStyle = { position: base.pos, left: base.left + dx + 'px', top: base.top + dy + 'px' };
  setInline(el, nudgeStyle);
  drawBox(el, `зміщення ${nudgeStyle.left} / ${nudgeStyle.top}`);
  drawHandles(el);
  scheduleNudgeCommit(el);
  return true;
}

function clearInline() {
  if (!pendingClear) return;
  const { el, props } = pendingClear;
  if (document.documentElement.contains(el)) for (const prop of props) el.style.removeProperty(prop);
  pendingClear = null;
}

// ---------- обробники подій ----------

function onMove(event) {
  if (drag) return liveDrag(event);
  if (mode === 'off') return;
  const el = document.elementFromPoint(event.clientX, event.clientY);
  if (!isTarget(el)) return;
  hoverEl = el;
  lockEl = el;
  if (mode === 'geom') {
    drawBox(el, describe(el) + ' · тягни мишкою / стрілками, Tab — вгору');
    drawHandles(el);
  } else {
    drawBox(el);
  }
  event.preventDefault();
  event.stopPropagation();
}

function onDown(event) {
  if (event.button !== 0) return;
  if (mode === 'off') return;
  if (mode === 'geom') {
    const target = event.target;
    const handle = target && target.dataset ? target.dataset.guiHandle : null;
    const el = handle ? hoverEl : document.elementFromPoint(event.clientX, event.clientY);
    if (!isTarget(el)) return;
    hoverEl = el;
    lockEl = el;
    ensureOverlay();
    drag = {
      el,
      handle: handle || null,
      startX: event.clientX,
      startY: event.clientY,
      rect: { left: el.getBoundingClientRect().left, top: el.getBoundingClientRect().top, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height },
      base: baseOffsets(el),
      moved: false,
      style: null,
    };
    try {
      document.documentElement.setPointerCapture(event.pointerId);
    } catch (e) {}
    event.preventDefault();
    event.stopPropagation();
  }
}

function onUp(event) {
  if (!drag) return;
  if (!drag.moved) {
    // Клік без руху у режимі геометрії теж корисний: вибираємо елемент в інспектор.
    const el = drag.el;
    drag = null;
    handleBar.style.display = 'none';
    ipcRenderer.send('gui:picked', capture(el, { x: event.clientX, y: event.clientY }));
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  commitDrag();
}

function onClick(event) {
  if (mode !== 'pick') return;
  const el = hoverEl || document.elementFromPoint(event.clientX, event.clientY);
  if (!isTarget(el)) return;
  lockEl = el;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send('gui:picked', capture(el, { x: event.clientX, y: event.clientY }));
}

function setMode(next) {
  mode = next === 'pick' || next === 'geom' ? next : 'off';
  drag = null;
  document.documentElement.style.cursor = mode === 'pick' ? 'crosshair' : mode === 'geom' ? 'move' : '';
  if (mode === 'off') hideOverlay();
  ensureOverlay();
  if (mode !== 'geom' && handleBar) handleBar.style.display = 'none';
  if (mode === 'geom') {
    try {
      window.focus();
    } catch (e) {}
  }
}

window.addEventListener('DOMContentLoaded', ensureOverlay, { once: true });
// Показник (pointer), а не миша: багато панелей у розширеннях самі чіпають pointerdown
// і через preventDefault ріжуть сумісні mouse-події. Наші слухачі на document у фазі
// захоплення працюють першими, тож у режимі геометрії ми забираємо керування мишею собі.
document.addEventListener('pointermove', onMove, true);
document.addEventListener('pointerdown', onDown, true);
document.addEventListener('pointerup', onUp, true);
document.addEventListener('pointercancel', onUp, true);
document.addEventListener('click', onClick, true);
document.addEventListener('dragstart', (event) => {
  if (mode !== 'off') event.preventDefault();
}, true);
document.addEventListener('keydown', (event) => {
  if (mode !== 'geom') return;
  if (event.key === 'Tab') {
    // Як у devtools: Tab піднімає на батька, щоб можна було взяти всю панель, а не її підрядок.
    const next = hoverEl && hoverEl.parentElement && hoverEl.parentElement.tagName !== 'HTML' ? hoverEl.parentElement : null;
    if (next && isTarget(next)) {
      hoverEl = next;
      lockEl = next;
      drawBox(next, describe(next) + ' · тягни мишкою / стрілками, Tab — вгору');
      drawHandles(next);
    }
    event.preventDefault();
    return;
  }
  const arrow = ARROWS[event.key];
  if (arrow) {
    if (nudge(arrow[0] * (event.shiftKey ? 10 : 1), arrow[1] * (event.shiftKey ? 10 : 1))) event.preventDefault();
    return;
  }
  if (event.key === 'Escape') ipcRenderer.send('gui:mode-off');
}, true);

ipcRenderer.on('gui:picker', (_e, on) => setMode(on ? 'pick' : 'off'));
ipcRenderer.on('gui:mode', (_e, next) => setMode(String(next || 'off')));

ipcRenderer.on('gui:hot', (_e, payload) => {
  ensureOverlay();
  let style = document.getElementById('__gui_live_css');
  if (!style) {
    style = document.createElement('style');
    style.id = '__gui_live_css';
    document.head.appendChild(style);
  }
  style.textContent = (payload && payload.css) || '';
  clearInline();
  window.postMessage({ __gui: 'skin-reload', ops: (payload && payload.ops) || [] }, '*');
});

ipcRenderer.on('gui:eval', (_e, code) => {
  try {
    // Виконуємо в ізольованому світі: має доступ до того ж DOM.
    // eslint-disable-next-line no-new-func
    new Function(String(code))();
  } catch (e) {
    ipcRenderer.send('gui:eval-error', String(e && e.message));
  }
});

// міст: запити від shim.js (сторінний світ) → головний процес
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.__gui === 'call') {
    ipcRenderer
      .invoke('gui:bridge', data.type, data.payload)
      .then((result) => window.postMessage({ __gui: 'reply', id: data.id, result }, '*'))
      .catch((error) => window.postMessage({ __gui: 'reply', id: data.id, error: String(error && error.message) }, '*'));
    return;
  }
  if (data.__gui === 'log' || data.__gui === 'skin-report') {
    ipcRenderer.send('gui:event', data);
  }
});

setTimeout(() => {
  ensureOverlay();
  ipcRenderer.send('gui:ready', { url: location.href });
}, 50);
