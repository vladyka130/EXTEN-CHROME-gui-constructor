#!/usr/bin/env bash
# Автоматичний ремонт Electron після копіювання node_modules з іншої ФС
# (втрачені права +x та симлінк .bin/electron). Безпечний для повторних запусків.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  for candidate in ../.toolchain/node-*/bin /usr/local/opt/node/bin; do
    [ -x "$candidate/node" ] && { PATH="$(cd "$candidate" && pwd):$PATH"; export PATH; break; }
  done
fi
command -v node >/dev/null 2>&1 || { echo "Потрібен Node 20+." >&2; exit 1; }

# Якщо electron ще не встановлено — ставимо залежності.
if [ ! -d node_modules/electron ]; then
  echo "Встановлюю залежності (npm install)…"
  npm install
  [ -f node_modules/electron/install.js ] && node node_modules/electron/install.js
fi

DIST="node_modules/electron/dist"
CLI="node_modules/electron/cli.js"

# 1) Права на виконання для бінарників.
if [ -d "$DIST" ]; then
  for bin in electron chrome-sandbox chrome_crashpad_handler; do
    [ -f "$DIST/$bin" ] && chmod +x "$DIST/$bin" && echo "+x: $DIST/$bin"
  done
fi
[ -f "$CLI" ] && chmod +x "$CLI" && echo "+x: $CLI"

# 2) Симлінк .bin/electron -> ../electron/cli.js
mkdir -p node_modules/.bin
ln -sf ../electron/cli.js node_modules/.bin/electron
chmod +x node_modules/.bin/electron 2>/dev/null || true
echo "symlink: node_modules/.bin/electron -> ../electron/cli.js"

# 3) Перевірка — НЕ запускаємо electron (щоб не залежати від sandbox/GPU).
#    Достатньо переконатися, що бінарник виконуваний і симлінк на місці.
if [ ! -x "$DIST/electron" ]; then
  echo "Помилка: $DIST/electron відсутній або не виконуваний. Спробуйте 'npm install'." >&2
  exit 1
fi
if [ ! -e node_modules/.bin/electron ]; then
  echo "Помилка: не вдалося створити симлінк node_modules/.bin/electron." >&2
  exit 1
fi
VER="$(cat "$DIST/version" 2>/dev/null || echo '?')"
echo "OK: electron ${VER} готовий (бінарник виконуваний, симлінк на місці)."
