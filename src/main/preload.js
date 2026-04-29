const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (key, val) => ipcRenderer.invoke('set-config', key, val),
  getAvailableProfiles: () => ipcRenderer.invoke('get-available-profiles'),
  getRemoteProfiles: () => ipcRenderer.invoke('get-remote-profiles'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getActivityLog: () => ipcRenderer.invoke('get-activity-log'),
  onSyncUpdate: (cb) => {
    ipcRenderer.on('sync-update', (event, data) => cb(data));
  },
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  finishSetup: (config) => ipcRenderer.invoke('finish-setup', config),
  detectConflicts: () => ipcRenderer.invoke('detect-conflicts'),
  resolveConflicts: (resolutions) => ipcRenderer.invoke('resolve-conflicts', resolutions),
  skipConflicts: () => ipcRenderer.invoke('skip-conflicts'),
  checkDeps: () => ipcRenderer.invoke('check-deps'),
  installDep: (name) => ipcRenderer.invoke('install-dep', name),
  depsContinue: () => ipcRenderer.invoke('deps-continue'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
