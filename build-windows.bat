@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите версию LTS с https://nodejs.org и запустите файл снова.
  pause
  exit /b 1
)
echo [1/2] Установка зависимостей (нужен интернет, первый раз это несколько минут)...
call npm install
if errorlevel 1 goto fail
echo [2/2] Сборка установщика...
call npm run dist
if errorlevel 1 goto fail
echo.
echo Готово. Установщик и портативная версия лежат в папке dist.
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo Сборка не удалась, причина написана выше. Подсказки есть в README.md.
pause
exit /b 1
