@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите версию LTS с https://nodejs.org и запустите файл снова.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Первый запуск: установка зависимостей...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm start
