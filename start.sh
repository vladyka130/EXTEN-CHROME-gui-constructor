#!/usr/bin/env bash
# Запуск «Конструктора GUI» на Linux/macOS.
# Потрібен Node (системний або портативний із ../.toolchain) — сам Electron вже лежить у node_modules.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  for candidate in ../.toolchain/node-*/bin /usr/local/opt/node/bin; do
    if [ -x "$candidate/node" ]; then
      PATH="$(cd "$candidate" && pwd):$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Не знайдено node. Встановіть Node 20+ або розпакуйте портативний у ../.toolchain/" >&2
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "Встановлюю залежності…"
  npm install
  node node_modules/electron/install.js
fi

exec node_modules/.bin/electron . --no-sandbox "$@"
