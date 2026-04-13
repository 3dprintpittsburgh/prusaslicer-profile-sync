const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const {
  getConfig,
  setConfig,
  getStore,
  detectPrusaSlicerDir,
  getAvailableProfiles
} = require('./config');
const {
  ensureRepo,
  fullSync,
  listRemoteProfiles,
  isSyncInProgress
} = require('./sync');
const { startWatcher, stopWatcher, isWatching } = require('./watcher');
const { createTray, setTrayState, destroyTray } = require('./tray');

// ── In-memory activity log ──────────────────────────────────────────────

const MAX_LOG_ENTRIES = 100;
let activityLog = [];

function logActivity(message) {
  const entry = { timestamp: new Date().toISOString(), message };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG_ENTRIES) {
    activityLog = activityLog.slice(0, MAX_LOG_ENTRIES);
  }

  // Broadcast to any open renderer windows
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('sync-update', entry);
    }
  });
}

// ── Window management ───────────────────────────────────────────────────

const preloadPath = path.join(__dirname, 'preload.js');

let setupWindow = null;
let settingsWindow = null;
let statusWindow = null;

function showSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 800,
    height: 500,
    resizable: true,
    frame: true,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 650,
    height: 700,
    resizable: true,
    frame: true,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function showStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 550,
    height: 500,
    resizable: true,
    frame: true,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  statusWindow.loadFile(path.join(__dirname, '..', 'renderer', 'status.html'));

  statusWindow.on('closed', () => {
    statusWindow = null;
  });
}

// ── Sync orchestration ──────────────────────────────────────────────────

let syncTimer = null;

async function performSync(source) {
  if (isSyncInProgress()) {
    logActivity(`Sync skipped (already in progress) [${source}]`);
    return;
  }

  setTrayState('syncing');
  logActivity(`Sync started [${source}]`);

  const result = await fullSync();

  if (result.success) {
    setTrayState('ok');
    if (result.changedFiles.length > 0) {
      logActivity(`Sync complete: ${result.changedFiles.length} file(s) changed`);
      result.changedFiles.forEach(f => logActivity(`  ${f}`));
    } else {
      logActivity('Sync complete: everything up to date');
    }
  } else {
    setTrayState('error');
    logActivity(`Sync failed: ${result.error}`);
  }

  return result;
}

function startSyncTimer() {
  stopSyncTimer();
  const config = getConfig();
  const intervalMs = (config.syncIntervalSeconds || 30) * 1000;

  syncTimer = setInterval(() => {
    performSync('timer');
  }, intervalMs);
}

function stopSyncTimer() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function handleFileChanges(changes) {
  const names = changes.map(c => `${c.type}/${c.name}`).join(', ');
  logActivity(`File change detected: ${names}`);
  performSync('watcher');
}

// ── IPC handlers ────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.handle('get-config', () => {
    return getConfig();
  });

  ipcMain.handle('set-config', (event, key, value) => {
    setConfig(key, value);

    // Handle side effects for specific config changes
    if (key === 'syncIntervalSeconds') {
      startSyncTimer();
    }

    if (key === 'launchOnStartup') {
      app.setLoginItemSettings({ openAtLogin: !!value });
    }

    return { success: true };
  });

  ipcMain.handle('get-available-profiles', () => {
    return getAvailableProfiles();
  });

  ipcMain.handle('get-remote-profiles', () => {
    return listRemoteProfiles();
  });

  ipcMain.handle('sync-now', async () => {
    return await performSync('manual');
  });

  ipcMain.handle('get-status', () => {
    const config = getConfig();
    return {
      lastSync: config.lastSync,
      lastSyncStatus: config.lastSyncStatus,
      lastError: config.lastError,
      isWatching: isWatching(),
      syncInProgress: isSyncInProgress()
    };
  });

  ipcMain.handle('get-activity-log', () => {
    return activityLog;
  });

  ipcMain.handle('select-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select PrusaSlicer Data Directory'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle('finish-setup', async (event, setupConfig) => {
    // Apply all setup configuration values
    if (setupConfig.repoUrl) setConfig('repoUrl', setupConfig.repoUrl);
    if (setupConfig.githubToken) setConfig('githubToken', setupConfig.githubToken);
    if (setupConfig.prusaslicerDataDir) setConfig('prusaslicerDataDir', setupConfig.prusaslicerDataDir);
    if (setupConfig.trackedProfiles) setConfig('trackedProfiles', setupConfig.trackedProfiles);

    // Close setup window
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }

    // Initialize the app now that we have config
    await initializeAfterSetup();

    return { success: true };
  });
}

// ── App initialization ──────────────────────────────────────────────────

async function initializeAfterSetup() {
  logActivity('Initializing sync engine...');

  // Initialize the repo
  const repoResult = await ensureRepo();
  if (repoResult.success) {
    logActivity(`Repository ${repoResult.action}: ready`);
  } else {
    logActivity(`Repository setup failed: ${repoResult.error}`);
    setTrayState('error');
    return;
  }

  // Start file watcher
  const config = getConfig();
  if (config.prusaslicerDataDir) {
    try {
      startWatcher(handleFileChanges);
      logActivity('File watcher started');
    } catch (err) {
      logActivity(`File watcher failed: ${err.message}`);
    }
  }

  // Start periodic sync
  startSyncTimer();
  logActivity(`Periodic sync started (every ${config.syncIntervalSeconds}s)`);

  // Do an initial sync
  await performSync('startup');
}

// ── App lifecycle ───────────────────────────────────────────────────────

// Prevent the app from quitting when all windows are closed (tray app behavior)
app.on('window-all-closed', (e) => {
  // Do nothing - keep running in tray
});

app.whenReady().then(async () => {
  // Register IPC handlers before creating any windows
  registerIpcHandlers();

  // Auto-detect PrusaSlicer directory if not already set
  const config = getConfig();
  if (!config.prusaslicerDataDir) {
    const detected = detectPrusaSlicerDir();
    if (detected) {
      setConfig('prusaslicerDataDir', detected);
      logActivity(`Auto-detected PrusaSlicer dir: ${detected}`);
    }
  }

  // Create system tray
  createTray({
    onSyncNow: () => performSync('manual'),
    onSettings: () => showSettingsWindow(),
    onStatus: () => showStatusWindow(),
    onQuit: () => {
      stopSyncTimer();
      stopWatcher();
      destroyTray();
      app.quit();
    }
  });

  // Apply launch-on-startup setting
  if (config.launchOnStartup) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // Check if first run (no repoUrl configured)
  if (!config.repoUrl) {
    logActivity('First run detected - showing setup wizard');
    showSetupWindow();
  } else {
    // Normal startup - initialize everything
    await initializeAfterSetup();
  }
});

app.on('before-quit', () => {
  stopSyncTimer();
  stopWatcher();
  destroyTray();
});
