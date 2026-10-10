// Per-tab isolation of Commintify's frequency-filter state.
// Runs in the page's MAIN world at document_start, before the app bundle touches storage.
// The site keeps its filter in origin-wide localStorage, so every tab hydrates the last
// written list; namespacing those keys by a per-tab token makes tabs independent.
(() => {
  const w = window;
  if (w.__cmTabIso) return;
  w.__cmTabIso = true;

  const SEP = '#cmt';
  const TOKEN_KEY = '__cmTabId';
  const SWITCH_KEY = 'cm_tab_isolation';
  const ISOLATED = new Set([
    'playerFilterPanelDraft',
    'filterUrlParams_v1',
    'networks-table-globalFilter',
  ]);

  const proto = w.Storage.prototype;
  const dGet = proto.getItem;
  const dSet = proto.setItem;
  const dRem = proto.removeItem;
  const desc = Object.getOwnPropertyDescriptor(proto, 'length');
  const dLen = desc && desc.get;

  function rawLS(key, fn) {
    try {
      return fn(dGet, dSet, dRem, key);
    } catch (e) {
      return null;
    }
  }

  let disabled = false;
  try {
    disabled = dGet.call(w.localStorage, SWITCH_KEY) === 'off';
  } catch (e) {}

  let token = '';
  if (!disabled) {
    try {
      token = dGet.call(w.sessionStorage, TOKEN_KEY) || '';
      if (!token) {
        token = (w.crypto && w.crypto.randomUUID
          ? w.crypto.randomUUID().replace(/-/g, '').slice(0, 10)
          : Math.random().toString(36).slice(2, 12)) + '.' + Date.now().toString(36);
        dSet.call(w.sessionStorage, TOKEN_KEY, token);
      }
    } catch (e) {
      token = '';
      disabled = true;
    }
  }

  w.__cmTabToken = disabled ? '' : token;
  if (disabled) return;

  const namespaced = (key) => key + SEP + token;
  const isTarget = (key) => ISOLATED.has(String(key || ''));

  proto.getItem = function (key) {
    if (this !== w.localStorage || !isTarget(key)) return dGet.call(this, key);
    const ns = namespaced(key);
    const own = dGet.call(this, ns);
    if (own !== null) return own;
    // First read in this tab: inherit whatever the operator had applied globally.
    const base = dGet.call(this, key);
    if (base !== null) {
      try {
        dSet.call(this, ns, base);
      } catch (e) {}
    }
    return base;
  };

  proto.setItem = function (key, value) {
    if (this !== w.localStorage || !isTarget(key)) return dSet.call(this, key, value);
    dSet.call(this, namespaced(key), value);
    // Shadow copy of the base key: CDP tooling (cdp_filter_runner, dashboard on :5050)
    // reads the plain key names and must keep seeing a plausible value.
    try {
      dSet.call(this, key, value);
    } catch (e) {}
  };

  proto.removeItem = function (key) {
    if (this !== w.localStorage || !isTarget(key)) return dRem.call(this, key);
    dRem.call(this, namespaced(key));
  };

  if (dLen) {
    Object.defineProperty(proto, 'length', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        const n = dLen.call(this);
        if (this !== w.localStorage) return n;
        let hidden = 0;
        for (const key of ISOLATED) {
          if (dGet.call(this, key) !== null && dGet.call(this, namespaced(key)) !== null) hidden += 1;
        }
        return Math.max(0, n - hidden);
      },
    });
  }

  // The site's own writer is what must become local; expose the token for the sidebar
  // (isolated world reads the same sessionStorage value, so both worlds agree on the key).
  w.__cmTabNamespacedKey = namespaced;
})();
