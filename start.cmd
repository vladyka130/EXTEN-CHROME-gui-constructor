@echo off
rem Запуск «Конструктора GUI» на Windows.
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Встановлюю залежності…
  call npm install
  call node node_modules\electron\install.js
)

start "" "node_modules\electron\dist\electron.exe" . %*
