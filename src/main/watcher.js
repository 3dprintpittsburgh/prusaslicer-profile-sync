const chokidar = require('chokidar');
const path = require('path');
const { getConfig, isProfileTracked } = require('./config');

const PROFILE_TYPES = ['printer', 'filament', 'print'];

let watcher = null;
let debounceTimer = null;
let pendingChanges = [];
let watching = false;

/**
 * Start watching the PrusaSlicer data directory for .ini file changes.
 * Only triggers the callback for tracked profiles.
 *
 * @param {Function} onChange - Called with [{type, name}, ...] after debounce
 */
function startWatcher(onChange) {
  if (watcher) {
    stopWatcher();
  }

  const config = getConfig();
  const dataDir = config.prusaslicerDataDir;

  if (!dataDir) {
    throw new Error('PrusaSlicer data directory not configured');
  }

  // Build watch paths for each profile type subdirectory
  const watchPaths = PROFILE_TYPES.map(type =>
    path.join(dataDir, type, '*.ini')
  );

  watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  // Only watch add and change events, ignore deletions
  watcher.on('add', filePath => handleFileEvent(filePath, onChange));
  watcher.on('change', filePath => handleFileEvent(filePath, onChange));

  watcher.on('error', err => {
    console.error('Watcher error:', err);
  });

  watching = true;
}

/**
 * Handle a file event, extracting profile type and name,
 * then adding to the debounced change set.
 */
function handleFileEvent(filePath, onChange) {
  const parsed = parseProfilePath(filePath);
  if (!parsed) return;

  const { type, name } = parsed;

  // Only trigger for tracked profiles
  if (!isProfileTracked(type, name)) return;

  // Add to pending changes (dedup later)
  pendingChanges.push({ type, name });

  // Reset debounce timer - collect changes for 2 seconds
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    // Deduplicate changes
    const uniqueMap = new Map();
    for (const change of pendingChanges) {
      const key = `${change.type}/${change.name}`;
      uniqueMap.set(key, change);
    }

    const uniqueChanges = Array.from(uniqueMap.values());
    pendingChanges = [];

    if (uniqueChanges.length > 0 && typeof onChange === 'function') {
      onChange(uniqueChanges);
    }
  }, 2000);
}

/**
 * Parse a file path into {type, name} where type is printer/filament/print
 * and name is the filename without .ini extension.
 */
function parseProfilePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(filePath);

  if (!basename.endsWith('.ini')) return null;

  const name = basename.replace(/\.ini$/, '');

  // Determine profile type from the parent directory name
  const parentDir = path.basename(path.dirname(filePath));

  if (PROFILE_TYPES.includes(parentDir)) {
    return { type: parentDir, name };
  }

  return null;
}

/**
 * Stop the file watcher and clean up.
 */
function stopWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  pendingChanges = [];

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  watching = false;
}

/**
 * Check whether the watcher is currently active.
 */
function isWatching() {
  return watching;
}

module.exports = {
  startWatcher,
  stopWatcher,
  isWatching
};
