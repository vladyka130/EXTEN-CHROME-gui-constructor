'use strict';
// Сканування розширення: які в нього інтерфейси і де живуть підписи/тексти.
// Тільки читає — нічого не змінює.
const fs = require('node:fs');
const path = require('node:path');

const TEXT_MIN = 2;
const TEXT_MAX = 120;
const SKIP_DIRS = new Set(['node_modules', '.git', 'snapshots', 'history', 'gui-skin', '__gui_preview__']);

const ATTR_RE = /\b(title|placeholder|aria-label|alt|data-tip)\s*=\s*"([^"\n]{2,120})"/g;
const TEXTNODE_RE = />([^<>{}]+?)</g;
const ASSIGN_RE = /\b(?:textContent|innerText|label|title|buttonText|value)\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const HTML_BLOCK_RE = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g;

function walk(dir, root = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) walk(abs, root, out);
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out;
}

function lineIndex(text) {
  const idx = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) idx.push(i + 1);
  return idx;
}
function posOf(idx, text, offset) {
  let lo = 0;
  let hi = idx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - idx[lo] + 1 };
}

function isLabel(value) {
  const v = String(value == null ? '' : value).trim();
  if (v.length < TEXT_MIN || v.length > TEXT_MAX) return false;
  if (!/[A-Za-zА-Яа-яІіЇїЄєҐґ0-9]/.test(v)) return false;
  if (/^(function|return|var|const|let|if|else|this|window|document|null|true|false|undefined|\d+)$/.test(v)) return false;
  if (/^(https?:|data:|chrome-extension:|extgui:|\{\{|\$\{)/.test(v)) return false;
  if (/^[\w$-]+$/.test(v) && !/[aeiouеїієїоичсфгхjklyg]/i.test(v)) return false;
  if (/^[a-z0-9_-]+\.(js|css|html|png|svg|json)$/i.test(v)) return false;
  return true;
}

// Шаблонні літерали `...` без повного парсингу JS: масив статичних шматків між ${}.
function templateLiterals(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      const parts = [];
      let chunk = '';
      let chunkStart = j;
      let exprDepth = 0;
      while (j < n) {
        const c = text[j];
        if (c === '\\') {
          chunk += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (exprDepth === 0 && c === quote) break;
        if (quote === '`' && c === '$' && text[j + 1] === '{' && exprDepth === 0) {
          if (chunk.trim()) parts.push({ text: chunk, start: chunkStart });
          chunk = '';
          exprDepth = 1;
          j += 2;
          continue;
        }
        if (exprDepth > 0) {
          if (c === '{') exprDepth += 1;
          else if (c === '}') exprDepth -= 1;
          else if (c === '`') {
            // вкладений шаблон — пропускаємо до закриття
            let k = j + 1;
            while (k < n) {
              if (text[k] === '\\') k += 2;
              else if (text[k] === '`') break;
              else k += 1;
            }
            j = k + 1;
            continue;
          }
          j += 1;
          continue;
        }
        if (!chunk.trim() && c !== quote) chunkStart = j;
        chunk += c;
        j += 1;
      }
      if (chunk.trim()) parts.push({ text: chunk, start: chunkStart });
      out.push({ quote, start: i, end: j, parts });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function tagBefore(fragment, index) {
  const before = fragment.slice(Math.max(0, index - 300), index);
  const opens = [...before.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)];
  const last = opens[opens.length - 1];
  if (!last) return '';
  const id = /\bid\s*=\s*["']?([\w-]+)/.exec(last[2]);
  const cls = /\bclass\s*=\s*["']([^"']+)/.exec(last[2]);
  const label = /\bdata-gui-label\s*=\s*["']([^"']+)/.exec(last[2]);
  return [last[1], id ? '#' + id[1] : '', cls ? '.' + cls[1].trim().split(/\s+/)[0] : '', label ? '«' + label[1] + '»' : ''].join('');
}

// fragment — шматок HTML-подібного тексту; baseStart — його абсолютний початок у файлі.
function labelsFromHtml(text, fragment, baseStart, rel) {
  const idx = lineIndex(text);
  const out = [];
  const add = (value, absoluteStart, kind, attr, hint) => {
    if (!isLabel(value)) return;
    const p = posOf(idx, text, absoluteStart);
    out.push({
      id: `${rel}@${absoluteStart}`,
      file: rel,
      value: value.trim(),
      raw: value,
      kind,
      attr: attr || null,
      hint: hint || '',
      start: absoluteStart,
      end: absoluteStart + value.length,
      line: p.line,
      col: p.col,
    });
  };

  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(fragment))) {
    const value = m[2];
    add(value, baseStart + m.index + m[0].indexOf(value), 'attr', m[1], tagBefore(fragment, m.index));
  }
  TEXTNODE_RE.lastIndex = 0;
  while ((m = TEXTNODE_RE.exec(fragment))) {
    const raw = m[1];
    if (!raw.trim()) continue;
    const lead = raw.length - raw.trimStart().length;
    add(raw, baseStart + m.index + 1 + lead, 'text', null, tagBefore(fragment, m.index));
  }
  return out;
}

function scanHtmlFile(text, rel) {
  const idx = lineIndex(text);
  const hidden = new Uint8Array(text.length);
  let h;
  HTML_BLOCK_RE.lastIndex = 0;
  while ((h = HTML_BLOCK_RE.exec(text))) for (let i = h.index; i < h.index + h[0].length; i++) hidden[i] = 1;
  const bodyStart = text.toLowerCase().indexOf('<body');

  const out = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text))) {
    if (hidden[m.index]) continue;
    const value = m[2];
    if (!isLabel(value)) continue;
    const start = m.index + m[0].indexOf(value);
    const p = posOf(idx, text, start);
    out.push({ id: `${rel}@${start}`, file: rel, value, raw: value, kind: 'attr', attr: m[1], hint: tagBefore(text, m.index), start, end: start + value.length, line: p.line, col: p.col });
  }
  TEXTNODE_RE.lastIndex = 0;
  while ((m = TEXTNODE_RE.exec(text))) {
    if (hidden[m.index]) continue;
    const raw = m[1];
    const value = raw.trim();
    if (!value || !isLabel(value)) continue;
    const start = m.index + 1 + (raw.length - raw.trimStart().length);
    if (bodyStart >= 0 && start < bodyStart && !/<(h1|h2|span|div|p|a|button|option|label|strong|em)\b/i.test(text.slice(Math.max(0, m.index - 60), m.index + 1))) continue;
    const p = posOf(idx, text, start);
    out.push({ id: `${rel}@${start}`, file: rel, value, raw: value, kind: 'text', attr: null, hint: tagBefore(text, m.index), start, end: start + value.length, line: p.line, col: p.col });
  }
  return out;
}

function scanJsFile(text, rel) {
  const idx = lineIndex(text);
  const out = [];
  for (const tpl of templateLiterals(text)) {
    for (const part of tpl.parts) {
      if (!/[<>]/.test(part.text)) continue;
      out.push(...labelsFromHtml(text, part.text, part.start, rel));
    }
  }
  ASSIGN_RE.lastIndex = 0;
  let m;
  while ((m = ASSIGN_RE.exec(text))) {
    const value = m[2];
    if (!/^[A-Za-zА-Яа-яІіЇїЄєҐґ .,!?«»():%/-]{2,80}$/.test(value)) continue;
    const start = m.index + m[0].indexOf(value);
    const p = posOf(idx, text, start);
    out.push({ id: `${rel}@${start}`, file: rel, value, raw: value, kind: 'assign', attr: m[1], hint: '', start, end: start + value.length, line: p.line, col: p.col });
  }
  return out;
}

function dedupe(labels) {
  const seen = new Map();
  for (const l of labels) {
    if (!seen.has(l.id)) seen.set(l.id, l);
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
}

function readJsonSafe(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { __error: String(e.message) };
  }
}

function scanProject(workingDir) {
  const files = walk(workingDir);
  const manifestAbs = path.join(workingDir, 'manifest.json');
  if (!fs.existsSync(manifestAbs)) throw new Error('manifest.json не знайдено');
  const manifestText = fs.readFileSync(manifestAbs, 'utf8');
  const manifest = readJsonSafe(manifestAbs);
  if (manifest.__error) throw new Error('manifest.json пошкоджений: ' + manifest.__error);

  const surfaces = [];
  const warnings = [];

  const action = manifest.action || manifest.browser_action || null;
  if (action && action.default_popup) {
    surfaces.push({
      id: `popup:${action.default_popup}`,
      kind: 'popup',
      label: 'Вікно розширення (popup)',
      page: action.default_popup,
      matches: ['—'],
      js: [],
      css: [],
      note: action.default_title || '',
    });
  }
  const options = manifest.options_ui || manifest.options_page;
  if (options) {
    const page = typeof options === 'string' ? options : options.page;
    if (page) surfaces.push({ id: `options:${page}`, kind: 'options', label: 'Сторінка налаштувань', page, matches: ['—'], js: [], css: [] });
  }
  for (const [key, page] of Object.entries(manifest.chrome_url_overrides || {})) {
    if (page) surfaces.push({ id: `override:${key}`, kind: 'override', label: `Підміна сторінки: ${key}`, page, matches: ['—'], js: [], css: [] });
  }
  if (manifest.side_panel && manifest.side_panel.default_path) {
    surfaces.push({ id: `sidepanel:${manifest.side_panel.default_path}`, kind: 'sidepanel', label: 'Бічна панель', page: manifest.side_panel.default_path, matches: ['—'], js: [], css: [] });
  }

  (manifest.content_scripts || []).forEach((cs, i) => {
    const js = cs.js || [];
    const css = cs.css || [];
    surfaces.push({
      id: `content:${i}:${js[0] || css[0] || 'empty'}`,
      index: i,
      kind: 'content',
      label: `Панель на сторінці #${i + 1}`,
      page: null,
      matches: cs.matches || [],
      js,
      css,
      world: cs.world || 'ISOLATED',
      runAt: cs.run_at || 'DOCUMENT_IDLE',
      note: js.join(', '),
    });
    if (!js.length && !css.length) warnings.push(`content_scripts[${i}] без файлів`);
    if (cs.world === 'MAIN') warnings.push(`content_scripts[${i}] у MAIN world: у попередньому перегляді всі скрипти йдуть в одному світі`);
  });

  const pages = files.filter((f) => /\.html?$/i.test(f.rel)).map((f) => f.rel);
  const styles = files.filter((f) => /\.css$/i.test(f.rel)).map((f) => f.rel);
  const scripts = files.filter((f) => /\.m?js$/i.test(f.rel)).map((f) => ({ rel: f.rel, bytes: fs.statSync(f.abs).size }));

  const labels = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.abs, 'utf8');
    } catch (e) {
      continue;
    }
    if (/\.html?$/i.test(f.rel)) labels.push(...scanHtmlFile(text, f.rel));
    else if (/\.m?js$/i.test(f.rel)) labels.push(...scanJsFile(text, f.rel));
  }

  const locales = {};
  const localesDir = path.join(workingDir, '_locales');
  if (fs.existsSync(localesDir)) {
    for (const lang of fs.readdirSync(localesDir)) {
      const msg = readJsonSafe(path.join(localesDir, lang, 'messages.json'));
      if (msg && !msg.__error) locales[lang] = msg;
    }
  }

  const cssVars = [];
  for (const rel of styles) {
    const text = fs.readFileSync(path.join(workingDir, rel), 'utf8');
    for (const m of text.matchAll(/--[A-Za-z0-9-]+\s*:\s*[^;\n]{1,60}/g)) cssVars.push({ file: rel, decl: m[0].trim() });
  }

  return {
    root: workingDir,
    manifest,
    manifestText,
    manifestVersion: manifest.manifest_version || 2,
    name: manifest.name || '',
    version: manifest.version || '',
    permissions: [...(manifest.permissions || []), ...(manifest.host_permissions || [])],
    surfaces,
    pages,
    styles,
    scripts,
    labels: dedupe(labels),
    locales,
    cssVars,
    warnings,
    allFiles: files.map((f) => f.rel),
    fileCount: files.length,
  };
}

module.exports = { scanProject, templateLiterals, isLabel, posOf, lineIndex };
