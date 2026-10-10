// Додаток оформлення, згенерований Конструктором GUI.
// Читає gui-skin/skin-data.json і застосовує текстові/структурні правки; кольори й розміри
// робить CSS. Логіку розширення не чіпає: править лише DOM після (і під час) його рендеру.
(() => {
  const SCOPE_ATTR = 'data-gui-scope';
  const MARK_ATTR = 'data-gui-skin';
  const ORIG_ATTR = 'data-gui-orig';
  let ops = [];
  let applied = 0;
  let missing = [];
  let busy = false;
  let timer = null;

  function scopeKey(id) {
    return String(id || 'any').replace(/[^A-Za-z0-9._]/g, '_');
  }

  function currentScope() {
    const meta = document.querySelector('meta[name="gui-skin-scope"]');
    return scopeKey(meta && meta.content ? meta.content : 'content');
  }

  function dataUrl() {
    const script = document.currentScript;
    if (script && script.src) return script.src.replace(/skin-runtime\.js(\?[\s\S]*)?$/, 'skin-data.json');
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL('gui-skin/skin-data.json');
      }
    } catch (e) {}
    return null;
  }

  // Якорі без селектора шукаємо за видимим текстом — так правки тримаються, коли розширення
  // генерує класи/ідентифікатори динамічно.
  function findByText(root, want, match) {
    const target = String(want || '').trim();
    if (!target) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const own = Array.from(node.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.nodeValue)
          .join('')
          .trim();
        if (!own) return NodeFilter.FILTER_REJECT;
        const hit = match === 'contains' ? own.indexOf(target) !== -1 : own === target;
        return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const out = [];
    let node = walker.nextNode();
    while (node && out.length < 40) {
      out.push(node);
      node = walker.nextNode();
    }
    return out;
  }

  function resolve(op, root) {
    const anchor = op.anchor || {};
    if (anchor.selector) {
      try {
        const found = Array.from(root.querySelectorAll(anchor.selector));
        if (found.length) return found;
      } catch (e) {
        return [];
      }
    }
    if (anchor.text) return findByText(root, anchor.text, anchor.match);
    if (anchor.attr) {
      try {
        return Array.from(root.querySelectorAll('[' + anchor.attr + ']'));
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  function applyText(el, op) {
    const spec = op.text;
    if (!spec) return;
    if (!el.hasAttribute(ORIG_ATTR)) el.setAttribute(ORIG_ATTR, el.textContent || '');
    const original = el.getAttribute(ORIG_ATTR);
    let next;
    if (spec.mode === 'append') next = original + (spec.value || '');
    else if (spec.mode === 'prepend') next = (spec.value || '') + original;
    else if (spec.mode === 'remove') next = '';
    else next = spec.value == null ? original : String(spec.value);
    if (el.textContent !== next) el.textContent = next;
    // Динамічні підписи: розширення може перезаписати textContent після нашого — спостерігач
    // побачить зміну і поверне потрібний текст.
    if (spec.mode === 'append' || spec.mode === 'prepend') el.setAttribute(ORIG_ATTR, original);
  }

  function applyClasses(el, op) {
    const cls = op.classes || {};
    for (const name of cls.add || []) if (name) el.classList.add(name);
    for (const name of cls.remove || []) if (name) el.classList.remove(name);
  }

  function applyAttrs(el, op) {
    const attrs = op.attrs || {};
    for (const [key, value] of Object.entries(attrs.set || {})) {
      if (value === null || value === false) el.removeAttribute(key);
      else el.setAttribute(key, String(value));
    }
    for (const key of attrs.remove || []) el.removeAttribute(key);
  }

  function applyLayout(el, op, root) {
    const layout = op.layout;
    if (!layout || !layout.action) return;
    try {
      if (layout.action === 'hide') el.style.setProperty('display', 'none', 'important');
      else if (layout.action === 'show') el.style.removeProperty('display');
      else if (layout.action === 'appendTo') {
        const parent = root.querySelector(layout.target);
        if (parent) parent.appendChild(el);
      } else if (layout.action === 'before') {
        const ref = root.querySelector(layout.target);
        if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref);
      } else if (layout.action === 'after') {
        const ref = root.querySelector(layout.target);
        if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref.nextSibling);
      }
    } catch (e) {}
  }

  function applyAll() {
    const root = document.documentElement;
    if (!root) return;
    busy = true;
    applied = 0;
    missing = [];
    const seen = new Set();
    for (const op of ops) {
      if (!op.enabled) continue;
      if (op.anchor && op.anchor.selector) seen.add(op.anchor.selector);
      const nodes = resolve(op, root);
      if (!nodes.length) {
        if (op.anchor && (op.anchor.selector || op.anchor.text)) missing.push(op.note || op.anchor.selector || op.anchor.text || op.id);
        continue;
      }
      for (const el of nodes) {
        if (el === document || el === root) continue;
        if (el.hasAttribute(MARK_ATTR) && el.getAttribute(MARK_ATTR) !== op.id) {
          /* інший operaція — не конфліктуємо */
        }
        el.setAttribute(MARK_ATTR, op.id);
        applyText(el, op);
        applyClasses(el, op);
        applyAttrs(el, op);
        applyLayout(el, op, root);
        applied += 1;
      }
    }
    // Прибираємо наслідки вимкнених операцій.
    for (const el of Array.from(root.querySelectorAll('[' + MARK_ATTR + ']'))) {
      if (!seen.has(el.getAttribute(MARK_ATTR)) && !ops.some((o) => o.id === el.getAttribute(MARK_ATTR) && o.enabled)) {
        const original = el.getAttribute(ORIG_ATTR);
        if (original !== null && el.textContent !== original) el.textContent = original;
        el.removeAttribute(MARK_ATTR);
        el.removeAttribute(ORIG_ATTR);
        el.style.removeProperty('display');
      }
    }
    busy = false;
    report();
  }

  function report() {
    const payload = { __gui: 'skin-report', applied, missing: missing.slice(0, 20), scope: document.documentElement.getAttribute(SCOPE_ATTR) };
    try {
      if (window.top !== window.self) window.top.postMessage(payload, '*');
    } catch (e) {}
    try {
      window.postMessage(payload, window.location.origin === 'null' ? '*' : window.location.origin);
    } catch (e) {}
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!busy) applyAll();
    }, 120);
  }

  function boot() {
    document.documentElement.setAttribute(SCOPE_ATTR, currentScope());
    // Живий режим: конструктор підсовує дані прямо в сторінку.
    if (window.__GUI_SKIN_DATA__ && Array.isArray(window.__GUI_SKIN_DATA__.ops)) {
      ops = window.__GUI_SKIN_DATA__.ops;
      applyAll();
      observe();
      return;
    }
    const url = dataUrl();
    if (!url) return;
    fetch(url, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.ops)) return;
        ops = data.ops;
        applyAll();
        observe();
      })
      .catch(() => {});
  }

  function observe() {
    new MutationObserver((mutations) => {
      if (busy) return;
      for (const m of mutations) {
        if (m.type === 'attributes' && (m.attributeName === SCOPE_ATTR || m.attributeName === MARK_ATTR)) continue;
        schedule();
        return;
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    // CSS уже підключений; DOM з'являється поступово — стежимо за документом.
    new MutationObserver(() => schedule()).observe(document, { childList: true, subtree: false });
  } else {
    boot();
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.__gui === 'skin-reload') {
      ops = Array.isArray(data.ops) ? data.ops : ops;
      applyAll();
    }
  });
})();
