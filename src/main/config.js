const Store = require('electron-store');
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

let store = null;

function initStore() {
  if (!store) {
    store = new Store({
      name: 'prusaslicer-sync-config',
      defaults
    });
  }
  return store;
}

function getStore() {
  return initStore();
}

function getConfig() {
  const s = initStore();
  const config = {};
  for (const key of Object.keys(defaults)) {
    config[key] = s.get(key);
  }
  return config;
}

function setConfig(key, value) {
  const s = initStore();
  s.set(key, value);
}

/**
 * Detect the PrusaSlicer data directory based on the current platform.
 * Returns the first existing path found, or null if none found.
 */
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
    // Deduplicate in case XDG_CONFIG_HOME is ~/.config
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'PrusaSlicer')
    );
  }

  // Deduplicate paths
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return resolved;
      }
    } catch {
      // Directory doesn't exist, try next
    }
  }

  return null;
}

/**
 * Scan the PrusaSlicer data directory for available .ini profiles.
 * Returns { printer: [...], filament: [...], print: [...] } with profile names (no .ini extension).
 */
function getAvailableProfiles() {
  const s = initStore();
  const dataDir = s.get('prusaslicerDataDir');
  const result = { printer: [], filament: [], print: [] };

  if (!dataDir) return result;

  const types = ['printer', 'filament', 'print'];

  for (const type of types) {
    const dir = path.join(dataDir, type);
    try {
      const files = fs.readdirSync(dir);
      result[type] = files
        .filter(f => f.endsWith('.ini'))
        .map(f => f.replace(/\.ini$/, ''))
        .sort();
    } catch {
      // Directory doesn't exist or can't be read
      result[type] = [];
    }
  }

  return result;
}

/**
 * Check if a specific profile is being tracked for sync.
 */
function isProfileTracked(type, name) {
  const s = initStore();
  const tracked = s.get('trackedProfiles') || { printer: [], filament: [], print: [] };
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
