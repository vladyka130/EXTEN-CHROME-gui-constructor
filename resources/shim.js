// Сторінний світ (page world) попереднього перегляду.
// Дає розширенню те, чого воно чекає від Chrome: chrome.runtime/storage/tabs, доступ до
// файлів розширення через extgui://, і мережеві запити через проксі головного процесу.
// Це тільки плагін-заглушка для перегляду — у справжньому розширенні його немає.
(() => {
  const w = window;
  if (w.__guiShim) return;
  w.__guiShim = true;

  const PROJECT_BASE = 'extgui://p/';
  let seq = 0;
  const pending = new Map();

  function ask(type, payload, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const id = 'q' + ++seq;
      pending.set(id, { resolve, reject });
      w.postMessage({ __gui: 'call', id, type, payload }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('shim timeout: ' + type));
        }
      }, timeoutMs);
    });
  }

  w.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__gui !== 'reply') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
  });

  const listeners = { sendMessage: [], message: [] };

  function storageArea(name) {
    const key = '__gui_preview_storage_' + name;
    let cache = {};
    try {
      cache = JSON.parse(w.localStorage.getItem(key) || '{}') || {};
    } catch (e) {
      cache = {};
    }
    const flush = () => {
      try {
        w.localStorage.setItem(key, JSON.stringify(cache));
      } catch (e) {}
    };
    return {
      get(keys, cb) {
        let out = {};
        if (keys == null) out = { ...cache };
        else if (typeof keys === 'string') out = keys in cache ? { [keys]: cache[keys] } : {};
        else if (Array.isArray(keys)) for (const k of keys) if (k in cache) out[k] = cache[k];
        else out = keys && typeof keys === 'object' ? { ...keys, ...Object.fromEntries(Object.entries(cache).filter(([k]) => k in keys)) } : {};
        Promise.resolve().then(() => cb && cb(structuredClone(out)));
        return structuredClone(out);
      },
      set(obj, cb) {
        Object.assign(cache, obj);
        flush();
        Promise.resolve().then(() => cb && cb());
      },
      remove(keys, cb) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete cache[k];
        flush();
        Promise.resolve().then(() => cb && cb());
      },
      clear(cb) {
        cache = {};
        flush();
        Promise.resolve().then(() => cb && cb());
      },
    };
  }

  const chrome = {
    __guiPreview: true,
    runtime: {
      id: 'gui-preview',
      getURL(path) {
        return PROJECT_BASE + String(path || '').replace(/^\/+/, '');
      },
      sendMessage(message, cb) {
        const calls = listeners.sendMessage.map((fn) => {
          try {
            return fn(message, { tab: { id: 1 } }, cb);
          } catch (e) {
            return Promise.reject(e);
          }
        });
        if (cb && !calls.length) cb(undefined);
        if (!calls.length) return ask('message', message).then((result) => (cb ? cb(result) : result), (err) => (cb ? cb({ error: String(err.message) }) : { error: String(err.message) }));
        return Promise.race(calls).then((result) => (cb ? cb(result) : result));
      },
      onMessage: {
        addListener(fn) {
          listeners.sendMessage.push(fn);
        },
      },
      onInstalled: { addListener() {} },
      getManifest() {
        return w.__guiManifestJson || null;
      },
      openOptionsPage() {},
    },
    storage: { local: storageArea('local'), sync: storageArea('sync'), session: storageArea('session') },
    tabs: {
      query(q, cb) {
        const t = { id: 1, url: w.location.href, active: true };
        if (cb) cb([t]);
        return Promise.resolve([t]);
      },
      sendMessage(...args) {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        ask('tab-message', args[1]).then((r) => cb && cb(r), () => cb && cb());
      },
      create(opts) {
        if (opts && opts.url) w.open(opts.url, '_blank');
      },
      update(...args) {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
          if (args[1] && args[1].url) w.location.href = args[1].url;
        } catch (e) {}
        if (cb) cb({});
      },
      reload() {
        w.location.reload();
      },
    },
    windows: {
      getCurrent(cb) {
        if (cb) cb({ id: 1 });
      },
      create(opts) {
        if (opts && opts.url) w.open(opts.url, '_blank');
      },
    },
    action: {
      setBadgeText(opts, cb) {
        document.title = '🔘 ' + ((opts && opts.text) || '') + ' — ' + document.title.replace(/^🔘\s.*?\s—\s/, '');
        if (cb) cb();
      },
      setBadgeBackgroundColor() {},
      setPopup() {},
      setTitle() {},
    },
    pageAction: { setIcon() {}, setPopup() {}, setTitle() {} },
    browserAction: chrome_action_stub(),
    i18n: {
      getMessage(key, substitutions) {
        const bag = w.__guiLocale || {};
        const entry = bag[key];
        let text = entry && entry.message ? entry.message : key;
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        subs.filter(Boolean).forEach((s, i) => {
          text = text.replace(new RegExp('\\$' + (i + 1), 'gi'), s);
        });
        return text.replace(/\$\w+/g, '');
      },
      getUILanguage: () => navigator.language || 'uk',
    },
    commands: { onCommand: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    notifications: { create() {}, clear() {} },
  };

  function chrome_action_stub() {
    return {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setPopup() {},
      setTitle() {},
      setIcon() {},
    };
  }

  w.chrome = chrome;
  if (!w.browser) w.browser = chrome;

  // Мережу через проксі головного процесу: у прев'ю немає ні mixed content, ні CORS.
  const nativeFetch = w.fetch ? w.fetch.bind(w) : null;
  w.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
    if (/^(extgui|data|blob|file):/i.test(rawUrl) || rawUrl.startsWith(w.location.origin)) {
      return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error('no fetch'));
    }
    if (/^https?:/i.test(rawUrl)) {
      try {
        const body = init && init.body != null && typeof init.body !== 'object' ? String(init.body) : null;
        const res = await ask('net', { url: rawUrl, method: (init && init.method) || 'GET', headers: (init && init.headers) || null, body }, 6000);
        return new Response(res.body == null ? '' : res.body, { status: res.status || 200, statusText: res.statusText || '', headers: res.headers || {} });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'preview: ' + err.message }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    }
    return nativeFetch ? nativeFetch(input, init) : Promise.reject(new Error('unsupported url'));
  };

  const nativeOpen = w.open;
  w.open = function (url) {
    ask('open', { url: String(url || '') }).catch(() => {});
    return null;
  };
  w.__guiOpenNative = nativeOpen;

  // Логи сторінки — у панель конструктора, щоб було видно, чому UI не зібрався.
  const levels = ['log', 'info', 'warn', 'error'];
  for (const level of levels) {
    const original = w.console ? w.console[level] : null;
    if (!original) continue;
    w.console[level] = function (...args) {
      try {
        w.postMessage({ __gui: 'log', level, text: args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ').slice(0, 400) }, '*');
      } catch (e) {}
      return original.apply(w.console, args);
    };
  }
  w.addEventListener('error', (event) => {
    w.postMessage({ __gui: 'log', level: 'error', text: (event.message || 'помилка') + (event.filename ? ' у ' + event.filename.split('/').pop() + ':' + event.lineno : '') }, '*');
  });

  function safeString(value) {
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
})();
