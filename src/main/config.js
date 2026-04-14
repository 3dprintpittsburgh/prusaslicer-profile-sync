const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const defaults = {
  repoUrl: '',
  githubToken: '',
  prusaslicerDataDir: '',
  syncIntervalSeconds: 30,
  trackedProfiles: { printer: [], filament: [], print: [] },
  lastSync: null,
  lastSyncStatus: 'never',
  lastError: null,
  showNotifications: true,
  launchOnStartup: false
};

// Simple JSON file store (replaces electron-store to avoid ESM issues)
let _data = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (_data) return _data;
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    _data = { ...defaults, ...JSON.parse(raw) };
  } catch {
    _data = { ...defaults };
  }
  return _data;
}

function save() {
  try {
    const dir = path.dirname(configPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(_data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CONFIG] Save failed:', err.message);
  }
}

function getConfig() {
  return { ...load() };
}

function setConfig(key, value) {
  load();
  _data[key] = value;
  save();
}

function getStore() {
  return { get: (k) => load()[k], set: (k, v) => setConfig(k, v) };
}

function detectPrusaSlicerDir() {
  const platform = process.platform;
  const candidates = [];

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(
      path.join(appData, 'PrusaSlicer'),
      path.join(appData, 'PrusaSlicer-alpha')
    );
  } else if (platform === 'linux') {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    candidates.push(
      path.join(os.homedir(), '.config', 'PrusaSlicer'),
      path.join(xdgConfig, 'PrusaSlicer')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'PrusaSlicer')
    );
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // not found
    }
  }
  return null;
}

function getAvailableProfiles() {
  const dataDir = load().prusaslicerDataDir;
  const result = { printer: [], filament: [], print: [] };
  if (!dataDir) return result;

  for (const type of ['printer', 'filament', 'print']) {
    try {
      result[type] = fs.readdirSync(path.join(dataDir, type))
        .filter(f => f.endsWith('.ini'))
        .map(f => f.replace(/\.ini$/, ''))
        .sort();
    } catch {
      result[type] = [];
    }
  }
  return result;
}

function isProfileTracked(type, name) {
  const tracked = load().trackedProfiles || {};
  return Array.isArray(tracked[type]) && tracked[type].includes(name);
}

module.exports = {
  getConfig,
  setConfig,
  getStore,
  detectPrusaSlicerDir,
  getAvailableProfiles,
  isProfileTracked,
  defaults
};
