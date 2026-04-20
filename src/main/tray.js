const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { getConfig } = require('./config');

let tray = null;
let currentState = 'offline';
let callbacks = {};

/**
 * State color map for tray icons.
 */
const STATE_COLORS = {
  ok: { r: 76, g: 175, b: 80 },       // Green
  syncing: { r: 255, g: 193, b: 7 },   // Yellow/Amber
  error: { r: 244, g: 67, b: 54 },     // Red
  offline: { r: 158, g: 158, b: 158 }  // Grey
};

/**
 * Generate a colored circle icon programmatically.
 * Creates a 16x16 PNG-format buffer using raw RGBA pixel data.
 */
function generateIcon(state) {
  const size = 16;
  const color = STATE_COLORS[state] || STATE_COLORS.offline;

  // Create raw RGBA pixel buffer
  const buffer = Buffer.alloc(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const radius = 6;
  const borderRadius = 7;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist <= radius) {
        // Inner fill
        buffer[offset] = color.r;
        buffer[offset + 1] = color.g;
        buffer[offset + 2] = color.b;
        buffer[offset + 3] = 255;
      } else if (dist <= borderRadius) {
        // Anti-aliased border
        const alpha = Math.max(0, Math.round(255 * (borderRadius - dist)));
        buffer[offset] = Math.round(color.r * 0.7);
        buffer[offset + 1] = Math.round(color.g * 0.7);
        buffer[offset + 2] = Math.round(color.b * 0.7);
        buffer[offset + 3] = alpha;
      } else {
        // Transparent
        buffer[offset] = 0;
        buffer[offset + 1] = 0;
        buffer[offset + 2] = 0;
        buffer[offset + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, {
    width: size,
    height: size
  });
}

/**
 * Compute the tooltip text based on current state and last sync time.
 */
function getTooltip(state) {
  const config = getConfig();
  const base = 'PrusaSlicer Sync';

  if (!config.lastSync) {
    return `${base} - Never synced`;
  }

  const lastSyncDate = new Date(config.lastSync);
  const now = new Date();
  const diffMs = now - lastSyncDate;
  const diffMinutes = Math.floor(diffMs / 60000);

  let timeAgo;
  if (diffMinutes < 1) {
    timeAgo = 'just now';
  } else if (diffMinutes === 1) {
    timeAgo = '1 min ago';
  } else if (diffMinutes < 60) {
    timeAgo = `${diffMinutes} min ago`;
  } else {
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours === 1) {
      timeAgo = '1 hour ago';
    } else {
      timeAgo = `${diffHours} hours ago`;
    }
  }

  const stateLabel = state === 'error' ? ' (Error)' : '';
  return `${base}${stateLabel} \u2014 Last: ${timeAgo}`;
}

/**
 * Build the context menu for the tray icon.
 */
function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Sync Now',
      click: () => {
        if (typeof callbacks.onSyncNow === 'function') {
          callbacks.onSyncNow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Status...',
      click: () => {
        if (typeof callbacks.onStatus === 'function') {
          callbacks.onStatus();
        }
      }
    },
    {
      label: 'Settings...',
      click: () => {
        if (typeof callbacks.onSettings === 'function') {
          callbacks.onSettings();
        }
      }
    },
    {
      label: 'Check for Updates...',
      click: () => {
        if (typeof callbacks.onCheckUpdate === 'function') {
          callbacks.onCheckUpdate();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (typeof callbacks.onQuit === 'function') {
          callbacks.onQuit();
        }
      }
    }
  ]);
}

/**
 * Create the system tray icon and context menu.
 *
 * @param {Object} cbs - Callbacks: { onSyncNow, onSettings, onStatus, onQuit }
 */
function createTray(cbs) {
  callbacks = cbs || {};

  const icon = generateIcon('offline');
  tray = new Tray(icon);

  tray.setToolTip(getTooltip('offline'));
  tray.setContextMenu(buildContextMenu());

  // Double-click opens status window
  tray.on('double-click', () => {
    if (typeof callbacks.onStatus === 'function') {
      callbacks.onStatus();
    }
  });

  return tray;
}

/**
 * Update the tray icon state and tooltip.
 *
 * @param {string} state - One of: 'ok', 'syncing', 'error', 'offline'
 */
function setTrayState(state) {
  currentState = state;

  if (!tray || tray.isDestroyed()) return;

  tray.setImage(generateIcon(state));
  tray.setToolTip(getTooltip(state));
}

/**
 * Destroy the tray icon and clean up.
 */
function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}

module.exports = {
  createTray,
  setTrayState,
  destroyTray
};
