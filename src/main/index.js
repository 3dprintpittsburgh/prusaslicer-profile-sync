const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { execFile, execSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
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
  isSyncInProgress,
  detectConflicts,
  resolveAndSync
} = require('./sync');
const { startWatcher, stopWatcher, isWatching } = require('./watcher');
const { createTray, setTrayState, destroyTray } = require('./tray');

// ── Dependency checking ────────────────────────────────────────────────

function checkGitInstalled() {
  try {
    const result = execSync('git --version', { encoding: 'utf-8', timeout: 5000 });
    return { installed: true, version: result.trim() };
  } catch {
    return { installed: false, version: null };
  }
}

function checkAllDependencies() {
  const git = checkGitInstalled();
  return {
    allSatisfied: git.installed,
    deps: {
      git: {
        name: 'Git',
        installed: git.installed,
        version: git.version,
        required: true,
        description: 'Required for syncing profiles between machines',
        installUrl: {
          win32: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe',
          darwin: null,  // Use xcode-select --install
          linux: null    // Use package manager
        },
        installInstructions: {
          win32: 'Click "Install Git" to download and run the installer. Use default settings.',
          darwin: 'Open Terminal and run: xcode-select --install',
          linux: 'Open a terminal and run: sudo apt install git (Debian/Ubuntu) or sudo dnf install git (Fedora)'
        }
      }
    }
  };
}

// Download a file to a temp path, returns the file path
function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), filename);
    const file = fs.createWriteStream(tmpPath);

    const request = (url) => {
      https.get(url, (response) => {
        // Follow redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(tmpPath);
        });
      }).on('error', reject);
    };

    request(url);
  });
}

let depsWindow = null;

function showDepsWindow() {
  if (depsWindow && !depsWindow.isDestroyed()) {
    depsWindow.focus();
    return;
  }

  depsWindow = new BrowserWindow({
    width: 600,
    height: 480,
    resizable: false,
    frame: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  depsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'deps.html'));
  depsWindow.on('closed', () => { depsWindow = null; });
}

// ── PrusaSlicer process detection & restart ─────────────────────────────

const PRUSASLICER_PROCESS_NAMES = [
  'prusa-slicer', 'prusaslicer', 'PrusaSlicer', 'prusa-slicer-console',
  'prusa-slicer.exe', 'PrusaSlicer.exe'
];

function findPrusaSlicerProcess() {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        'wmic process where "name like \'%prusa%slicer%\'" get ProcessId,ExecutablePath /format:csv',
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      );
      const lines = output.trim().split('\n').filter(l => l.includes(',') && l.toLowerCase().includes('slicer'));
      if (lines.length === 0) return null;
      // Parse CSV: Node,ExecutablePath,ProcessId
      const parts = lines[0].split(',');
      const exePath = parts.length >= 2 ? parts[1].trim() : null;
      const pid = parts.length >= 3 ? parseInt(parts[2].trim()) : null;
      return exePath && pid ? { pid, exePath } : null;
    } else {
      // Linux/macOS: use pgrep
      const output = execSync('pgrep -a -i prusaslicer 2>/dev/null || pgrep -a -i prusa-slicer 2>/dev/null || true', {
        encoding: 'utf-8', timeout: 5000
      });
      const line = output.trim().split('\n')[0];
      if (!line) return null;
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[0]);
      const exePath = parts.slice(1).join(' ');
      return pid ? { pid, exePath } : null;
    }
  } catch {
    return null;
  }
}

function killPrusaSlicer(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid}`, { timeout: 5000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function launchPrusaSlicer(exePath) {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function notifyPrusaSlicerRestart(changedProfileNames) {
  const psProcess = findPrusaSlicerProcess();
  if (!psProcess) return; // Not running, no action needed

  const { getConfig: gc } = require('./config');
  if (!gc().showNotifications) return;

  const profileList = changedProfileNames.slice(0, 3).join(', ');
  const extra = changedProfileNames.length > 3 ? ` +${changedProfileNames.length - 3} more` : '';

  const notification = new Notification({
    title: 'PrusaSlicer Profiles Updated',
    body: `${profileList}${extra} changed by another machine.\nClick to restart PrusaSlicer and apply changes.`,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    urgency: 'normal',
    silent: false
  });

  notification.on('click', () => {
    const currentProcess = findPrusaSlicerProcess();
    if (currentProcess) {
      logActivity(`Restarting PrusaSlicer (PID ${currentProcess.pid})...`);
      const exePath = currentProcess.exePath;
      if (killPrusaSlicer(currentProcess.pid)) {
        // Wait a moment for the process to exit, then relaunch
        setTimeout(() => {
          if (launchPrusaSlicer(exePath)) {
            logActivity('PrusaSlicer restarted successfully');
          } else {
            logActivity('Failed to relaunch PrusaSlicer — please open it manually');
          }
        }, 2000);
      } else {
        logActivity('Failed to close PrusaSlicer — please restart it manually');
      }
    }
  });

  notification.show();
  logActivity(`PrusaSlicer is running — sent restart notification for ${changedProfileNames.length} updated profile(s)`);
}

// ── Auto-updater ───────────────────────────────────────────────────────

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let updateStatus = { state: 'idle', version: null, progress: null, error: null };

autoUpdater.on('checking-for-update', () => {
  updateStatus = { state: 'checking', version: null, progress: null, error: null };
  logActivity('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  updateStatus = { state: 'downloading', version: info.version, progress: 0, error: null };
  logActivity(`Update available: v${info.version} — downloading...`);

  const notification = new Notification({
    title: 'Update Available',
    body: `PrusaSlicer Profile Sync v${info.version} is downloading. It will install on next restart.`,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
  });
  notification.show();
});

autoUpdater.on('update-not-available', () => {
  updateStatus = { state: 'up-to-date', version: app.getVersion(), progress: null, error: null };
  logActivity(`App is up to date (v${app.getVersion()})`);
});

autoUpdater.on('download-progress', (progress) => {
  updateStatus.progress = Math.round(progress.percent);
});

autoUpdater.on('update-downloaded', (info) => {
  updateStatus = { state: 'ready', version: info.version, progress: 100, error: null };
  logActivity(`Update v${info.version} downloaded — will install on next restart`);

  const notification = new Notification({
    title: 'Update Ready',
    body: `v${info.version} will install when you restart the app. Click to restart now.`,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
  });
  notification.on('click', () => {
    autoUpdater.quitAndInstall(false, true);
  });
  notification.show();
});

autoUpdater.on('error', (err) => {
  updateStatus = { state: 'error', version: null, progress: null, error: err.message };
  logActivity(`Update check failed: ${err.message}`);
});

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch(err => {
    logActivity(`Update check failed: ${err.message}`);
  });
}

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
let conflictWindow = null;

function showConflictWindow() {
  if (conflictWindow && !conflictWindow.isDestroyed()) {
    conflictWindow.focus();
    return;
  }

  conflictWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: true,
    frame: true,
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  conflictWindow.loadFile(path.join(__dirname, '..', 'renderer', 'conflicts.html'));
  conflictWindow.on('closed', () => { conflictWindow = null; });
}

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

      // Check if any profiles were PULLED (incoming from another machine)
      // and PrusaSlicer is running — offer to restart
      const pulledProfiles = result.changedFiles
        .filter(f => f.startsWith('pulled: '))
        .map(f => f.replace('pulled: ', '').replace('.ini', ''));

      if (pulledProfiles.length > 0) {
        notifyPrusaSlicerRestart(pulledProfiles);
      }
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

  ipcMain.handle('set-config', async (event, key, value) => {
    setConfig(key, value);

    // Handle side effects for specific config changes
    if (key === 'syncIntervalSeconds') {
      startSyncTimer();
    }

    if (key === 'launchOnStartup') {
      app.setLoginItemSettings({ openAtLogin: !!value });
    }

    // When tracked profiles are set for the first time, check for conflicts
    if (key === 'trackedProfiles' && !getConfig().firstSyncDone) {
      const totalTracked = Object.values(value || {}).flat().length;
      if (totalTracked > 0) {
        logActivity(`Profiles selected (${totalTracked}) — checking for conflicts...`);

        // Make sure repo is pulled so we can compare
        try {
          const repoResult = await ensureRepo();
          if (repoResult.success) {
            const git = require('simple-git')(getRepoDir());
            await git.fetch('origin', 'main');
            await git.pull('origin', 'main', { '--strategy-option': 'theirs' });
          }
        } catch (err) {
          logActivity(`Pre-conflict pull failed: ${err.message}`);
        }

        const conflicts = await detectConflicts();
        if (conflicts.length > 0) {
          logActivity(`Found ${conflicts.length} conflict(s) — showing resolution window`);
          showConflictWindow();
          return { success: true, conflicts: conflicts.length };
        }

        // No conflicts — mark done and do first sync
        setConfig('firstSyncDone', true);
        logActivity('No conflicts — starting first sync');
        performSync('first-sync');
      }
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

  ipcMain.handle('check-for-updates', () => {
    checkForUpdates();
    return { checking: true };
  });

  ipcMain.handle('get-update-status', () => {
    return updateStatus;
  });

  ipcMain.handle('install-update', () => {
    if (updateStatus.state === 'ready') {
      autoUpdater.quitAndInstall(false, true);
    }
    return { installing: updateStatus.state === 'ready' };
  });

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('detect-conflicts', async () => {
    return await detectConflicts();
  });

  ipcMain.handle('resolve-conflicts', async (event, resolutions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();

    logActivity(`Resolving ${resolutions.length} conflict(s)...`);
    const result = await resolveAndSync(resolutions);

    if (result.success) {
      logActivity(`Conflicts resolved: ${result.changedFiles.length} file(s) updated`);
      result.changedFiles.forEach(f => logActivity(`  ${f}`));
      // Continue with normal app initialization
      await initializeAfterSetup();
    } else {
      logActivity(`Conflict resolution failed: ${result.error}`);
    }

    return result;
  });

  ipcMain.handle('skip-conflicts', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    setConfig('firstSyncDone', true);
    await initializeAfterSetup();
  });

  ipcMain.handle('check-deps', () => {
    return checkAllDependencies();
  });

  ipcMain.handle('install-dep', async (event, depName) => {
    const deps = checkAllDependencies().deps;
    const dep = deps[depName];
    if (!dep) return { success: false, error: 'Unknown dependency' };

    const platform = process.platform;

    // macOS: open terminal instruction
    if (platform === 'darwin') {
      if (depName === 'git') {
        try {
          execSync('xcode-select --install', { timeout: 5000 });
          return { success: true, message: 'Xcode Command Line Tools installer launched' };
        } catch {
          return { success: false, error: 'Please open Terminal and run: xcode-select --install' };
        }
      }
    }

    // Linux: provide instructions (can't auto-install without sudo)
    if (platform === 'linux') {
      shell.openExternal('https://git-scm.com/download/linux');
      return { success: true, message: 'Opened Git download page. Install via your package manager.' };
    }

    // Windows: download and run installer
    if (platform === 'win32' && dep.installUrl.win32) {
      try {
        const installerPath = await downloadFile(dep.installUrl.win32, 'Git-Setup.exe');
        // Launch the installer (not silent - let user see and approve)
        execFile(installerPath, [], { detached: true, stdio: 'ignore' });
        return { success: true, message: 'Git installer launched. Complete the installation, then click "Re-check".' };
      } catch (err) {
        // Fallback: open download page in browser
        shell.openExternal('https://git-scm.com/download/win');
        return { success: false, error: `Auto-download failed. Opened download page instead. Error: ${err.message}` };
      }
    }

    return { success: false, error: 'Auto-install not available for this platform. Please install manually.' };
  });

  ipcMain.handle('deps-continue', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    continueAfterDeps();
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

  const config = getConfig();

  // On first run, don't start syncing until the user picks profiles in Settings.
  // The conflict check is triggered by set-config('trackedProfiles') when firstSyncDone is false.
  if (!config.firstSyncDone) {
    const totalTracked = Object.values(config.trackedProfiles || {}).flat().length;
    if (totalTracked === 0) {
      logActivity('Waiting for profile selection in Settings before first sync...');
      return; // Don't start sync timer — wait for user to pick profiles
    }
  }

  // Start file watcher
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

  // Check for app updates (delayed to not compete with initial sync)
  setTimeout(() => checkForUpdates(), 10000);
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
    onCheckUpdate: () => checkForUpdates(),
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

  // Check dependencies before anything else
  const depsResult = checkAllDependencies();
  if (!depsResult.allSatisfied) {
    logActivity('Missing dependencies detected - showing dependency installer');
    showDepsWindow();
  } else {
    continueAfterDeps();
  }
});

function continueAfterDeps() {
  const config = getConfig();
  if (!config.repoUrl) {
    logActivity('First run detected - showing setup wizard');
    showSetupWindow();
  } else {
    initializeAfterSetup();
  }
}

app.on('before-quit', () => {
  stopSyncTimer();
  stopWatcher();
  destroyTray();
});
