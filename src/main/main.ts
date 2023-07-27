/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain, nativeTheme } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { remove, pathExists, readFile, writeFile } from 'fs-extra';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './utils/resolvePath';
import {
  allNodeVersions,
  allInstalledNodeVersions,
} from './deps/all-node-versions';
import getNode from './deps/get-node';
import { APPDIR, INSTALL_DIR } from './constants';
import { checkShellFile } from './utils/nvmdShell';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

nativeTheme.on('updated', () => {
  mainWindow &&
    mainWindow.webContents.send(
      'native-theme:changed',
      nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    );
});

console.log(app.getName())

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    frame: false,
    title: "NVM-Desktop",
    width: 1024,
    maxWidth: 1024,
    minWidth: 1024,
    height: 728,
    maxHeight: 728,
    minHeight: 728,
    center: true,
    resizable: false,
    icon: getAssetPath('icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: {
      x: 12,
      y: 12,
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000": "#ffffff",
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  if (isDebug) mainWindow.webContents.openDevTools({ mode: 'undocked' });

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(async () => {
    await checkShellFile();

    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);

const controllers = new Map<string, AbortController>();

ipcMain.handle(
  'all-node-versions',
  async (_event, { id, fetch }: { id?: string; fetch?: boolean } = {}) => {
    const abortController = new AbortController();
    id && controllers.set(id, abortController);
    let result;
    try {
      result = await allNodeVersions({
        signal: abortController.signal,
        fetch,
        timeout: {
          response: 1000 * 60 * 3,
        },
      });
    } catch (err) {
      return Promise.reject(`${err.name}: ${err.message}`);
    } finally {
      id && controllers.delete(id);
    }
    return result;
  },
);

ipcMain.handle('controller:abort', async (_event, id) => {
  const controller = controllers.get(id);
  if (!controller) return;

  controller.abort();
  controllers.delete(id);
  return 'successfully';
});

ipcMain.handle(
  'installed-node-versions',
  async (_event, refresh: boolean = false) => {
    const versions = await allInstalledNodeVersions(refresh);

    return versions;
  },
);

ipcMain.handle(
  'get-node',
  async (_event, { id, version }: { id: string; version: string }) => {
    const abortController = new AbortController();
    controllers.set(id, abortController);

    try {
      const result = await getNode(version, {
        signal: abortController.signal,
        onProgress: (data) => {
          mainWindow?.webContents.send('get-node:progress', id, data);
        },
      });
      return result;
    } catch (err) {
      return Promise.reject(err.message);
    } finally {
      controllers.delete(id);
    }
  },
);

ipcMain.handle(
  'uninstall-node-version',
  async (_event, version: string, current: boolean = false) => {
    const path = `${INSTALL_DIR}/${version}`;
    await remove(path);
    current && (await remove(`${APPDIR}/default`));
    return;
  },
);

ipcMain.handle('current-version', async () => {
  const file = `${APPDIR}/default`;
  if (!(await pathExists(file))) return '';

  const version = (await readFile(file)).toString();
  return version;
});

ipcMain.handle('use-version', async (_event, version: string) => {
  const file = `${APPDIR}/default`;
  await writeFile(file, version);
  return;
});

ipcMain.on('get-system-theme', (event) => {
  event.returnValue = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});
