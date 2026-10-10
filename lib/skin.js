'use strict';
// Шар оформлення («скін»): декларативні правки інтерфейсу + генерація файлів.
// Логіка розширення не змінюється: додається лише gui-skin/* і рядки в manifest/HTML.
const fs = require('node:fs');
const path = require('node:path');
const { within, copyTree } = require('./project');

const SCHEMA = 'extgui-skin/v1';
const DIR = 'gui-skin';
const CSS_FILE = `${DIR}/skin.css`;
const DATA_FILE = `${DIR}/skin-data.json`;
const RUNTIME_FILE = `${DIR}/skin-runtime.js`;
const MARK_START = '<!-- gui-skin:start -->';
const MARK_END = '<!-- gui-skin:end -->';

function emptySkin() {
  return { schema: SCHEMA, enabled: true, updatedAt: new Date().toISOString(), ops: [], css: {} };
}

function scopeKey(surfaceId) {
  // Усі контент-панелі живуть на одній сторінці-господарі, тому для них спільна область.
  const key = String(surfaceId || 'any').startsWith('content:') ? 'content' : String(surfaceId || 'any');
  return key.replace(/[^A-Za-z0-9._]/g, '_');
}

function isPlainRule(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normaliseOp(op, i) {
  const out = {
    id: String(op && op.id ? op.id : 'op-' + (i + 1) + '-' + Math.random().toString(36).slice(2, 7)),
    surface: String((op && op.surface) || 'any'),
    note: String((op && op.note) || ''),
    enabled: op && op.enabled === false ? false : true,
    anchor: {
      selector: String((op && op.anchor && op.anchor.selector) || '').trim(),
      text: (op && op.anchor && op.anchor.text) || '',
      attr: (op && op.anchor && op.anchor.attr) || '',
      match: (op && op.anchor && op.anchor.match) || 'exact',
    },
    text: isPlainRule(op && op.text) ? { mode: op.text.mode || 'replace', value: op.text.value == null ? '' : String(op.text.value) } : null,
    style: isPlainRule(op && op.style) ? op.style : null,
    classes: isPlainRule(op && op.classes) ? { add: op.classes.add || [], remove: op.classes.remove || [] } : null,
    attrs: isPlainRule(op && op.attrs) ? { set: op.attrs.set || {}, remove: op.attrs.remove || [] } : null,
    layout: isPlainRule(op && op.layout) ? op.layout : null,
    source: (op && op.source) || null,
  };
  if (out.text && out.text.mode === 'remove') out.text.value = '';
  if (out.style && out.style.display === 'none') out.hidden = true;
  if (op && op.hidden && !out.style) out.style = { display: 'none' };
  return out;
}

function normaliseSkin(raw) {
  const skin = raw && raw.schema === SCHEMA ? JSON.parse(JSON.stringify(raw)) : emptySkin();
  skin.ops = (Array.isArray(skin.ops) ? skin.ops : []).map(normaliseOp);
  skin.css = isPlainRule(skin.css) ? skin.css : {};
  skin.enabled = skin.enabled !== false;
  return skin;
}

function hasWork(skin) {
  return skin.ops.some((o) => o.enabled && (o.text || o.style || o.classes || o.attrs || o.layout));
}

const PROPERTIES_ORDER = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'margin', 'padding', 'gap', 'align-items', 'justify-content', 'flex-direction',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align',
  'color', 'background', 'background-color', 'background-image', 'opacity',
  'border', 'border-color', 'border-radius', 'box-shadow', 'filter', 'backdrop-filter', 'cursor',
];

// one selector -> one rule; `!important`, бо скін іде поверх існуючих правил.
function buildCss(skin) {
  const lines = [
    '/* Згенеровано Конструктором GUI. Не редагуйте вручну — правки загубляться при наступному застосуванні.',
    '   Джерело: gui-skin/skin-data.json */',
    '',
  ];
  for (const op of skin.ops) {
    if (!op.enabled || !op.anchor.selector || !op.style) continue;
    const props = Object.keys(op.style)
      .filter((p) => op.style[p] !== '' && op.style[p] != null)
      .sort((a, b) => {
        const ai = PROPERTIES_ORDER.indexOf(a);
        const bi = PROPERTIES_ORDER.indexOf(b);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
      });
    if (!props.length) continue;
    const scope = `:root[data-gui-scope="${scopeKey(op.surface)}"]`;
    const body = props.map((p) => `  ${p}: ${op.style[p]} !important;`).join('\n');
    lines.push(`/* ${op.note || op.id} */`, `${scope} ${op.anchor.selector} {\n${body}\n}`, '');
  }
  for (const [surface, css] of Object.entries(skin.css || {})) {
    const text = String(css || '').trim();
    if (!text) continue;
    lines.push(`/* додатковий CSS для ${surface} */`, text, '');
  }
  return lines.join('\n');
}

function buildData(skin) {
  return {
    schema: SCHEMA,
    updatedAt: skin.updatedAt,
    surfaces: skin.ops.reduce((acc, op) => {
      (acc[op.surface] = acc[op.surface] || []).push(op);
      return acc;
    }, {}),
    ops: skin.ops,
  };
}

function stripHtmlSkin(html) {
  return String(html || '').replace(/\n?[ \t]*<!-- gui-skin:start -->[\s\S]*?<!-- gui-skin:end -->/g, '');
}

function injectIntoHtml(html, rel, surfaceId) {
  const base = stripHtmlSkin(html);
  const depth = (rel.match(/\//g) || []).length;
  const prefix = '../'.repeat(depth);
  const block =
    `\n${MARK_START}\n<meta name="gui-skin-scope" content="${scopeKey(surfaceId)}">\n` +
    `<link rel="stylesheet" href="${prefix}${CSS_FILE}">\n` +
    `<script src="${prefix}${RUNTIME_FILE}"></script>\n` +
    `${MARK_END}\n`;
  const headMatch = /<head[^>]*>/i.exec(base);
  if (headMatch) return base.slice(0, headMatch.index + headMatch[0].length) + block + base.slice(headMatch.index + headMatch[0].length);
  const htmlMatch = /<html[^>]*>/i.exec(base);
  if (htmlMatch) return base.slice(0, htmlMatch.index + htmlMatch[0].length) + block + base.slice(htmlMatch.index + htmlMatch[0].length);
  return block + base;
}

function stripManifestSkin(manifest) {
  const m = JSON.parse(JSON.stringify(manifest || {}));
  if (Array.isArray(m.content_scripts)) {
    m.content_scripts = m.content_scripts
      .map((cs) => {
        const js = (cs.js || []).filter((f) => !/gui-skin\//.test(f));
        const css = (cs.css || []).filter((f) => !/gui-skin\//.test(f));
        if (!js.length && !css.length) return null;
        return { ...cs, js, css };
      })
      .filter(Boolean);
    if (!m.content_scripts.length) delete m.content_scripts;
  }
  if (Array.isArray(m.web_accessible_resources)) {
    m.web_accessible_resources = m.web_accessible_resources
      .map((entry) => ({ ...entry, resources: (entry.resources || []).filter((r) => !/^gui-skin\//.test(r)) }))
      .filter((entry) => (entry.resources || []).length);
    if (!m.web_accessible_resources.length) delete m.web_accessible_resources;
  }
  return m;
}

function collectMatches(manifest) {
  const set = new Set();
  for (const cs of manifest.content_scripts || []) for (const m of cs.matches || []) set.add(m);
  set.delete('<all_urls>');
  const list = [...set];
  return list.length ? list : ['<all_urls>'];
}

function injectManifestSkin(manifest, skin, scan) {
  const m = stripManifestSkin(manifest);
  if (!hasWork(skin)) return { manifest: m, changed: false };
  const hasContent = skin.ops.some((o) => o.enabled && String(o.surface).startsWith('content:'));
  if (hasContent) {
    m.content_scripts = m.content_scripts || [];
    m.content_scripts = [
      ...m.content_scripts,
      {
        matches: collectMatches(m),
        js: [RUNTIME_FILE],
        css: [CSS_FILE],
        run_at: 'document_start',
        all_frames: true,
      },
    ];
    const matches = collectMatches(m);
    m.web_accessible_resources = m.web_accessible_resources || [];
    m.web_accessible_resources = [
      ...m.web_accessible_resources,
      { resources: [DATA_FILE], matches, use_dynamic_url: false },
    ];
  }
  return { manifest: m, changed: true, content: hasContent };
}

// Пише/gui-оновлює файли шару та підключає їх. Повертає детальний звіт.
function applySkin(project, skinRaw, resourcesDir) {
  const skin = normaliseSkin(skinRaw);
  const guiDir = within(project.working, DIR);
  const report = { written: [], pages: [], manifestPatched: false, removed: false, warnings: [] };
  const scan = project.scan;

  const pageTargets = Object.keys(skin.css).filter((s) => !String(s).startsWith('content:'));
  const opPages = skin.ops.filter((o) => o.enabled && !String(o.surface).startsWith('content:')).map((o) => o.surface);
  const surfacesToPatch = new Set([...pageTargets, ...opPages].filter((s) => s && s !== 'any'));

  if (!hasWork(skin) && !Object.keys(skin.css).length) {
    if (fs.existsSync(guiDir)) fs.rmSync(guiDir, { recursive: true, force: true });
    const manifestPath = within(project.working, 'manifest.json');
    const stripped = stripManifestSkin(scan.manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(stripped, null, 2) + '\n');
    for (const page of scan.pages) {
      const abs = within(project.working, page);
      const text = fs.readFileSync(abs, 'utf8');
      const next = stripHtmlSkin(text);
      if (next !== text) {
        fs.writeFileSync(abs, next);
        report.pages.push({ page, action: 'знято шар' });
      }
    }
    report.removed = true;
    return report;
  }

  fs.mkdirSync(guiDir, { recursive: true });
  fs.writeFileSync(path.join(guiDir, 'skin.css'), buildCss(skin));
  fs.writeFileSync(path.join(guiDir, 'skin-data.json'), JSON.stringify(buildData(skin), null, 2));
  fs.copyFileSync(path.join(resourcesDir, 'skin-runtime.js'), path.join(guiDir, 'skin-runtime.js'));
  report.written = [CSS_FILE, DATA_FILE, RUNTIME_FILE];

  const { manifest: patchedManifest, changed } = injectManifestSkin(scan.manifest, skin, scan);
  const manifestPath = within(project.working, 'manifest.json');
  const nextManifestText = JSON.stringify(patchedManifest, null, 2) + '\n';
  const currentManifestText = fs.readFileSync(manifestPath, 'utf8');
  if (nextManifestText !== currentManifestText) {
    fs.writeFileSync(manifestPath, nextManifestText);
    report.manifestPatched = true;
  }

  const surfacesById = new Map(scan.surfaces.map((s) => [s.id, s]));
  for (const surfaceId of surfacesToPatch) {
    const surface = surfacesById.get(surfaceId);
    if (!surface || !surface.page) continue;
    const abs = within(project.working, surface.page);
    if (!fs.existsSync(abs)) {
      report.warnings.push(`Немає файлу сторінки ${surface.page}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const injected = injectIntoHtml(stripHtmlSkin(text), surface.page, surface.id);
    if (injected !== text) {
      fs.writeFileSync(abs, injected);
      report.pages.push({ page: surface.page, action: 'підключено шар' });
    }
  }
  void changed;
  return report;
}

function readSkin(project) {
  const abs = path.join(project.base, 'skin.json');
  if (!fs.existsSync(abs)) return emptySkin();
  try {
    return normaliseSkin(JSON.parse(fs.readFileSync(abs, 'utf8')));
  } catch (e) {
    return emptySkin();
  }
}

function writeSkin(project, skin) {
  const normalised = normaliseSkin(skin);
  normalised.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(project.base, 'skin.json'), JSON.stringify(normalised, null, 2));
  return normalised;
}

module.exports = {
  SCHEMA,
  DIR,
  CSS_FILE,
  DATA_FILE,
  RUNTIME_FILE,
  MARK_START,
  MARK_END,
  emptySkin,
  normaliseSkin,
  normaliseOp,
  hasWork,
  buildCss,
  buildData,
  scopeKey,
  applySkin,
  readSkin,
  writeSkin,
  stripManifestSkin,
  stripHtmlSkin,
  injectIntoHtml,
};
void copyTree;
