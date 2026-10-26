'use strict';

const {
  app, BrowserWindow, Menu, clipboard, dialog, nativeTheme, protocol, screen, session, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const {
  APP_SCHEME, SECTIONS, mimeFor, isAppUrl, isAppBlobUrl, isSectionUrl, isExternalUrl,
  sectionUrl, resolveAppFile,
} = require('./lib/util');

const APP_DIR = path.join(__dirname, 'app');
const ICON = path.join(__dirname, 'build', 'icon.png');
const DEV = process.argv.includes('--dev');

// Данные (localStorage, IndexedDB с файлами, настройки окна) лежат в %APPDATA%\ChuvakChervyak.
// Путь задан явно, чтобы он не менялся при переименовании программы.
app.setPath('userData', path.join(app.getPath('appData'), 'ChuvakChervyak'));
app.setAppUserModelId('ru.chuvak.chervyak');

// Своя схема app:// даёт страницам нормальный защищённый origin: IndexedDB, localStorage
// и File System Access API работают так же, как на сайте, и данные не зависят от места установки.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;

/* ---------------- состояние окна ---------------- */

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
let normalBounds = null;

function boundsVisible(b) {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y;
  });
}

function loadState() {
  const def = { width: 1280, height: 860, maximized: false };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const ok = ['width', 'height'].every((k) => Number.isFinite(s[k]) && s[k] >= 400);
    if (!ok) return def;
    const out = { width: s.width, height: s.height, maximized: !!s.maximized };
    if (Number.isFinite(s.x) && Number.isFinite(s.y) && boundsVisible({ x: s.x, y: s.y, width: s.width, height: s.height })) {
      out.x = s.x;
      out.y = s.y;
    }
    return out;
  } catch (e) {
    return def;
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = normalBounds || win.getBounds();
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (e) {
    /* не критично */
  }
}

/* ---------------- протокол app:// ---------------- */

function registerProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(APP_DIR, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-cache' } });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------------- права доступа ---------------- */

// Страницам приложения нужен доступ к файлам на диске (редактор пишет прямо в файл) и полноэкранный режим видео.
// Всё остальное (камера, геолокация и т.д.) запрещено.
const ALLOWED_PERMISSIONS = new Set(['fileSystem', 'fullscreen', 'clipboard-sanitized-write']);

function lockDownSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const from = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
    callback(isAppUrl(from) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isAppUrl(origin) && ALLOWED_PERMISSIONS.has(permission));
}

/* ---------------- навигация ---------------- */

function navigate(url) {
  if (win && !win.isDestroyed()) win.loadURL(url);
}

function goBack() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.navigationHistory && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (typeof wc.canGoBack === 'function' && wc.canGoBack()) wc.goBack();
}

function goForward() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.navigationHistory && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (typeof wc.canGoForward === 'function' && wc.canGoForward()) wc.goForward();
}

function openExternal(url) {
  if (isExternalUrl(url)) shell.openExternal(url);
}

// Правила для любого окна приложения.
function windowOpenHandler({ url }) {
  // Переход между разделами: открываем в том же окне (в браузере это была новая вкладка).
  if (isSectionUrl(url)) {
    navigate(url);
    return { action: 'deny' };
  }
  // Файлы из «Учебной папки» (PDF, картинки, аудио, видео, HTML) открываются в отдельном окне.
  if (isAppBlobUrl(url)) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1000,
        height: 760,
        autoHideMenuBar: true,
        backgroundColor: '#0c0618',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
      },
    };
  }
  // Внешние ссылки (сайты нейронок, ссылки из конспектов) уходят в браузер по умолчанию.
  openExternal(url);
  return { action: 'deny' };
}

function contextMenuFor(contents, params) {
  const items = [];
  if (params.isEditable) {
    items.push(
      { role: 'undo', label: 'Отменить' },
      { role: 'redo', label: 'Повторить' },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' },
    );
  } else if (params.selectionText) {
    items.push({ role: 'copy', label: 'Копировать' });
  }
  if (params.linkURL && isExternalUrl(params.linkURL)) {
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: 'Открыть ссылку в браузере', click: () => openExternal(params.linkURL) },
      { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(params.linkURL) },
    );
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) });
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(windowOpenHandler);
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || isAppBlobUrl(url)) return;
    // Случайно брошенный на окно файл или ссылка не должны подменять приложение.
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('context-menu', (_e, params) => contextMenuFor(contents, params));
});

/* ---------------- меню ---------------- */

function showAbout() {
  dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'info',
    title: 'О программе',
    message: 'Чувак Червяк',
    detail: `Версия ${app.getVersion()}\nУчебная папка, Нейро-нора и игра «Угадай флаг» в одном приложении.\n\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    buttons: ['Понятно'],
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть папку с данными', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Разделы',
      submenu: [
        ...SECTIONS.map((s) => ({ label: s.title, accelerator: `CmdOrCtrl+${s.key}`, click: () => navigate(sectionUrl(s.file)) })),
        { type: 'separator' },
        { label: 'Назад', accelerator: 'Alt+Left', click: goBack },
        { label: 'Вперёд', accelerator: 'Alt+Right', click: goForward },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Масштаб 100%' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    { label: 'Справка', submenu: [{ label: 'О программе', click: showAbout }] },
  ]);
}

/* ---------------- окно ---------------- */

function createMainWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0c0618',
    autoHideMenuBar: true, // меню видно по нажатию Alt
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // встроенный просмотрщик PDF
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  normalBounds = win.isMaximized() ? null : win.getBounds();

  win.once('ready-to-show', () => win.show());

  const remember = () => {
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) normalBounds = win.getBounds();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', saveState);
  win.on('closed', () => {
    win = null;
    app.quit();
  });
  // Кнопки «назад/вперёд» на мыши (Windows).
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    else if (cmd === 'browser-forward') goForward();
  });

  navigate(sectionUrl(SECTIONS[0].file));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function focusMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function start() {
  nativeTheme.themeSource = 'dark';
  registerProtocol();
  lockDownSession(session.defaultSession);
  Menu.setApplicationMenu(buildMenu());
  createMainWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMain);
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start);
}
