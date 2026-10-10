// Запуск автотесту: node scripts/selftest.js [шлях-до-розширення]
// Без аргументу бере examples/demo-extension. Результат — .selftest/result.json і скріншоти.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const arg = process.argv[2];
const target = path.resolve(arg ? (path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg)) : path.join(root, 'examples', 'demo-extension'));

if (!fs.existsSync(target)) {
  console.error('Немає такого шляху: ' + target);
  process.exit(2);
}

const electronBin = require('electron');
const child = spawn(electronBin, ['.', '--no-sandbox'], {
  cwd: root,
  stdio: 'inherit',
  env: Object.assign({}, process.env, { GUI_SELFTEST: target }),
});

child.on('exit', (code) => {
  const file = path.join(root, '.selftest', 'result.json');
  let result = { ok: false, error: 'автотест не записав результат' };
  try {
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  console.log('\n' + (result.ok ? 'RESULT: OK' : 'RESULT: FAIL'));
  if (!result.ok) console.log(result.error);
  console.log('Докази: ' + path.join(root, '.selftest') + ' (result.json, app.png, preview.png, preview-skinned.png, preview-geom.png, preview-arrows.png)');
  console.log('Ціль: ' + target);
  process.exit(result.ok ? 0 : 1);
});
