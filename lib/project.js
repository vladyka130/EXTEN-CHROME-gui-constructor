'use strict';
// Імпорт розширень, робоча копія, історія змін, експорт.
// Оригінал ніколи не редагується: правки йдуть у working/, з backup у history/.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { scanProject } = require('./scan');

const run = promisify(execFile);

const SKIP = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', 'Thumbs.db']);
const HISTORY_KEEP = 25;

function slugify(value, fallback = 'extension') {
  const base = String(value || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return base || fallback;
}

function copyTree(src, dst, depth = 0) {
  if (depth > 40) throw new Error('Занадто глибока структура тек — зупинивсь на підозрі цикл');
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to, depth + 1);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function historyKey(rel) {
  return slugify(rel.replace(/[\\/]/g, '_'), 'file');
}

// Безпечне з'єднання шляху всередині кореня (запобіга ../ виходу).
function within(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error('Шлях поза межами проєкту: ' + rel);
  }
  return abs;
}

class ProjectStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  list() {
    const out = [];
    for (const id of fs.readdirSync(this.root)) {
      const metaPath = path.join(this.root, id, 'meta.json');
      try {
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        out.push({ ...meta, exists: true });
      } catch (e) {
        out.push({ id, name: id, broken: String(e.message) });
      }
    }
    return out.sort((a, b) => String(b.lastOpenedAt || b.importedAt || '').localeCompare(String(a.lastOpenedAt || a.importedAt || '')));
  }

  dir(id) {
    return within(this.root, id);
  }

  // sourcePath: директорія розширення | .zip | .crx
  async import(sourcePath) {
    const stat = fs.statSync(sourcePath);
    let extractFrom = sourcePath;
    const ext = path.extname(sourcePath).toLowerCase();

    if (stat.isFile()) {
      if (ext === '.crx') extractFrom = await this.normaliseCrx(sourcePath);
      else if (ext !== '.zip') throw new Error('Можна імпортувати теку, .zip або .crx');
      const tmp = fs.mkdtempSync(path.join(this.root, '.unpack-'));
      try {
        await this.unzip(extractFrom, tmp);
        sourcePath = await this.collapseSingleDir(tmp);
      } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
      }
    }

    const manifestFile = path.join(sourcePath, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('У вибраній папці немає manifest.json — це не розширення');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const name = slugify(manifest.name || path.basename(path.dirname(sourcePath)));
    const id = `${name}-${Date.now().toString(36)}`;
    const base = path.join(this.root, id);

    fs.mkdirSync(path.join(base, 'original'), { recursive: true });
    copyTree(sourcePath, path.join(base, 'original'));
    copyTree(sourcePath, path.join(base, 'working'));

    const meta = {
      id,
      name: manifest.name || id,
      slug: name,
      version: manifest.version || '',
      manifestVersion: manifest.manifest_version || 2,
      source: stat.isDirectory() ? sourcePath : path.resolve(sourcePath),
      sourceKind: stat.isDirectory() ? 'folder' : ext.replace('.', ''),
      importedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2));
    if (extractFrom !== sourcePath && extractFrom.startsWith(this.root)) fs.rmSync(extractFrom, { force: true });
    return this.open(id);
  }

  async normaliseCrx(file) {
    const buf = fs.readFileSync(file);
    const idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (idx < 0) throw new Error('.crx не містить ZIP-архів — не вдалось розпакувати');
    const out = path.join(this.root, `${slugify(path.basename(file))}-${Date.now().toString(36)}.zip`);
    fs.writeFileSync(out, buf.subarray(idx));
    return out;
  }

  async unzip(zip, dst) {
    if (process.platform === 'win32') {
      const ps = 'powershell.exe';
      await run(ps, ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dst.replace(/'/g, "''")}' -Force`]);
      return;
    }
    await run('unzip', ['-qq', '-o', zip, '-d', dst]);
  }

  // ZIP з однією текою всередині — піднятися вгору.
  collapseSingleDir(dir) {
    let entries = fs.readdirSync(dir);
    if (entries.length === 1) {
      const only = path.join(dir, entries[0]);
      if (fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, 'manifest.json'))) return only;
    }
    return dir;
  }

  open(id) {
    const base = this.dir(id);
    const meta = JSON.parse(fs.readFileSync(path.join(base, 'meta.json'), 'utf8'));
    meta.lastOpenedAt = new Date().toISOString();
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2));
    const working = path.join(base, 'working');
    const scan = scanProject(working);
    return { base, working, original: path.join(base, 'original'), meta, scan };
  }

  touch(id) {
    const p = path.join(this.dir(id), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    meta.lastOpenedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(meta, null, 2));
    return meta;
  }

  readFile(project, rel) {
    const abs = within(project.working, rel);
    if (!fs.existsSync(abs)) throw new Error('Файл відсутній: ' + rel);
    return fs.readFileSync(abs, 'utf8');
  }

  originalFile(project, rel) {
    const abs = within(project.original, rel);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
  }

  writeFile(project, rel, text) {
    const abs = within(project.working, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) {
      const prev = fs.readFileSync(abs, 'utf8');
      if (prev === text) return { unchanged: true };
      this.pushHistory(project, rel, prev);
    }
    fs.writeFileSync(abs, text);
    return { unchanged: false };
  }

  pushHistory(project, rel, content) {
    const dir = path.join(project.base, 'history', historyKey(rel));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.txt`), content);
    const all = fs.readdirSync(dir).sort();
    while (all.length > HISTORY_KEEP) {
      const drop = all.shift();
      fs.rmSync(path.join(dir, drop), { force: true });
    }
  }

  historyList(project, rel) {
    const dir = path.join(project.base, 'history', historyKey(rel));
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().reverse().map((f) => ({
      stamp: f.replace(/\.txt$/, ''),
      path: path.join(dir, f),
    }));
  }

  restoreHistory(project, rel, stamp) {
    const entry = this.historyList(project, rel).find((h) => h.stamp === stamp);
    if (!entry) throw new Error('Версію не знайдено');
    const text = fs.readFileSync(entry.path, 'utf8');
    fs.writeFileSync(within(project.working, rel), text);
    return text;
  }

  snapshot(project, label = 'ручна') {
    const id = `${Date.now().toString(36)}-${slugify(label, 'zmiy')}`;
    const dst = path.join(project.base, 'snapshots', id);
    copyTree(project.working, dst);
    fs.writeFileSync(path.join(dst, '_snapshot.json'), JSON.stringify({ label, at: new Date().toISOString() }, null, 2));
    return id;
  }

  snapshots(project) {
    const dir = path.join(project.base, 'snapshots');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().reverse().map((id) => {
      let label = '';
      try {
        label = JSON.parse(fs.readFileSync(path.join(dir, id, '_snapshot.json'), 'utf8')).label || '';
      } catch (e) {}
      return { id, label };
    });
  }

  restoreSnapshot(project, id) {
    const src = within(path.join(project.base, 'snapshots'), id);
    if (!fs.existsSync(src)) throw new Error('Знімок не знайдено');
    this.snapshot(project, `перед-відкатом-${id}`);
    for (const entry of fs.readdirSync(project.working)) {
      if (entry === 'snapshots' || entry === 'history') continue;
      fs.rmSync(path.join(project.working, entry), { recursive: true, force: true });
    }
    const skip = new Set(['_snapshot.json']);
    const copy = (s, d) => {
      fs.mkdirSync(d, { recursive: true });
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        if (skip.has(e.name) || e.name === 'snapshots' || e.name === 'history') continue;
        const from = path.join(s, e.name);
        const to = path.join(d, e.name);
        if (e.isDirectory()) copy(from, to);
        else fs.copyFileSync(from, to);
      }
    };
    copy(src, project.working);
    return true;
  }

  async export(project, targetDir, { zip = false } = {}) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const dst = path.join(targetDir, `${project.meta.slug}-gui`);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    copyTree(project.working, dst);
    const report = { folder: dst };
    if (zip) {
      const zipPath = dst + '.zip';
      if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
      if (process.platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Compress-Archive -LiteralPath '${dst.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`]);
      } else {
        await run('zip', ['-qr', zipPath, path.basename(dst)], { cwd: path.dirname(dst) });
      }
      report.zip = zipPath;
    }
    return report;
  }

  delete(id) {
    const base = this.dir(id);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

module.exports = { ProjectStore, within, slugify, copyTree };
