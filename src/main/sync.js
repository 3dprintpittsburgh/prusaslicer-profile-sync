const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getConfig, setConfig, isProfileTracked } = require('./config');

const PROFILE_TYPES = ['printer', 'filament', 'print'];

let syncInProgress = false;
let repoDir = null;

function getRepoDir() {
  if (!repoDir) {
    repoDir = path.join(app.getPath('userData'), 'repo');
  }
  return repoDir;
}

/**
 * Build an authenticated git URL from the configured repoUrl and token.
 * Input: https://github.com/org/repo.git
 * Output: https://{token}@github.com/org/repo.git
 */
function buildAuthUrl() {
  const config = getConfig();
  const { repoUrl, githubToken } = config;

  if (!repoUrl || !githubToken) {
    throw new Error('Repository URL and GitHub token are required');
  }

  // Extract org/repo from the URL
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+(?:\.git)?)/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }

  let orgRepo = match[1];
  if (!orgRepo.endsWith('.git')) {
    orgRepo += '.git';
  }

  return `https://${githubToken}@github.com/${orgRepo}`;
}

/**
 * Get a simple-git instance pointed at the repo directory.
 */
function getGit() {
  return simpleGit(getRepoDir());
}

/**
 * Ensure the repo exists locally. Clone if not present, validate if it exists.
 */
async function ensureRepo() {
  const dir = getRepoDir();
  const gitDir = path.join(dir, '.git');

  if (fs.existsSync(gitDir)) {
    // Repo exists, validate it by checking if it's a valid git repo
    const git = getGit();
    try {
      await git.status();
      // Update remote URL in case token changed
      const authUrl = buildAuthUrl();
      await git.remote(['set-url', 'origin', authUrl]);
      // Ensure git identity is configured (fix for repos cloned before this was added)
      await git.addConfig('user.email', 'prusaslicer-sync@3dprintpgh.com');
      await git.addConfig('user.name', 'PrusaSlicer Sync');
      return { success: true, action: 'validated' };
    } catch (err) {
      // Invalid repo, remove and re-clone
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Clone the repo
  try {
    const authUrl = buildAuthUrl();
    fs.mkdirSync(dir, { recursive: true });
    await simpleGit().clone(authUrl, dir);

    // Configure git identity for this repo (required for commits)
    const git = getGit();
    await git.addConfig('user.email', 'prusaslicer-sync@3dprintpgh.com');
    await git.addConfig('user.name', 'PrusaSlicer Sync');

    // Ensure profile type directories exist in the repo
    for (const type of PROFILE_TYPES) {
      const typeDir = path.join(dir, type);
      if (!fs.existsSync(typeDir)) {
        fs.mkdirSync(typeDir, { recursive: true });
      }
    }

    return { success: true, action: 'cloned' };
  } catch (err) {
    return { success: false, action: 'clone-failed', error: err.message };
  }
}

/**
 * Copy tracked profiles from PrusaSlicer data directory to the repo directory.
 * Then git add, commit, and push if there are changes.
 */
async function pushFromLocal() {
  const config = getConfig();
  const { prusaslicerDataDir, trackedProfiles } = config;
  const dir = getRepoDir();

  if (!prusaslicerDataDir) {
    throw new Error('PrusaSlicer data directory not configured');
  }

  const changedFiles = [];

  // Copy tracked profiles from PrusaSlicer dir to repo
  for (const type of PROFILE_TYPES) {
    const names = trackedProfiles[type] || [];
    for (const name of names) {
      const srcFile = path.join(prusaslicerDataDir, type, `${name}.ini`);
      const destFile = path.join(dir, type, `${name}.ini`);

      if (!fs.existsSync(srcFile)) continue;

      // Ensure destination directory exists
      const destDir = path.join(dir, type);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Only copy if content differs
      const srcContent = fs.readFileSync(srcFile, 'utf-8');
      let destContent = '';
      try {
        destContent = fs.readFileSync(destFile, 'utf-8');
      } catch {
        // File doesn't exist in repo yet
      }

      if (srcContent !== destContent) {
        fs.writeFileSync(destFile, srcContent, 'utf-8');
        changedFiles.push(`${type}/${name}.ini`);
      }
    }
  }

  if (changedFiles.length === 0) {
    return { pushed: false, changedFiles: [] };
  }

  // Git add, commit, push
  const git = getGit();
  await git.add(changedFiles);

  // Verify there are staged changes
  const status = await git.status();
  if (status.staged.length === 0) {
    return { pushed: false, changedFiles: [] };
  }

  // Build commit message
  let commitMsg;
  if (changedFiles.length === 1) {
    commitMsg = `Sync: Update ${changedFiles[0].replace('.ini', '')}`;
  } else {
    commitMsg = `Sync: Update ${changedFiles.length} profiles`;
  }

  await git.commit(commitMsg);
  await git.push('origin', 'main');

  return { pushed: true, changedFiles };
}

/**
 * Copy tracked profiles from the repo to the PrusaSlicer data directory.
 * Only copies if file content actually differs.
 */
async function pullToLocal() {
  const config = getConfig();
  const { prusaslicerDataDir, trackedProfiles } = config;
  const dir = getRepoDir();

  if (!prusaslicerDataDir) {
    throw new Error('PrusaSlicer data directory not configured');
  }

  const copiedFiles = [];

  for (const type of PROFILE_TYPES) {
    const names = trackedProfiles[type] || [];
    for (const name of names) {
      const srcFile = path.join(dir, type, `${name}.ini`);
      const destFile = path.join(prusaslicerDataDir, type, `${name}.ini`);

      if (!fs.existsSync(srcFile)) continue;

      // Ensure destination directory exists
      const destDir = path.join(prusaslicerDataDir, type);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Only copy if content differs
      const srcContent = fs.readFileSync(srcFile, 'utf-8');
      let destContent = '';
      try {
        destContent = fs.readFileSync(destFile, 'utf-8');
      } catch {
        // File doesn't exist locally yet
      }

      if (srcContent !== destContent) {
        fs.writeFileSync(destFile, srcContent, 'utf-8');
        copiedFiles.push(`${type}/${name}.ini`);
      }
    }
  }

  return { copiedFiles };
}

/**
 * Git fetch and pull from remote, using "theirs" strategy for conflict resolution.
 */
async function gitPull() {
  const git = getGit();

  await git.fetch('origin', 'main');
  try {
    await git.pull('origin', 'main', { '--strategy-option': 'theirs' });
  } catch (err) {
    // If pull fails due to merge conflict, try a harder resolution
    if (err.message && err.message.includes('CONFLICT')) {
      await git.raw(['checkout', '--theirs', '.']);
      await git.add('.');
      await git.commit('Sync: Resolve merge conflicts (accept remote)');
    } else {
      throw err;
    }
  }
}

/**
 * Full sync cycle: push local changes, pull remote, copy to local.
 * Returns { success, changedFiles, error }
 */
async function fullSync() {
  if (syncInProgress) {
    return { success: false, changedFiles: [], error: 'Sync already in progress' };
  }

  syncInProgress = true;

  try {
    // Step 1: Push local changes first so edits aren't lost
    const pushResult = await pushFromLocal();

    // Step 2: Pull remote changes
    await gitPull();

    // Step 3: Copy updated profiles from repo to PrusaSlicer dir
    const pullResult = await pullToLocal();

    // Combine changed files from both operations
    const allChanged = [
      ...pushResult.changedFiles.map(f => `pushed: ${f}`),
      ...pullResult.copiedFiles.map(f => `pulled: ${f}`)
    ];

    // Update config with sync status
    setConfig('lastSync', new Date().toISOString());
    setConfig('lastSyncStatus', 'ok');
    setConfig('lastError', null);

    syncInProgress = false;
    return { success: true, changedFiles: allChanged, error: null };
  } catch (err) {
    setConfig('lastSyncStatus', 'error');
    setConfig('lastError', err.message);

    syncInProgress = false;
    return { success: false, changedFiles: [], error: err.message };
  }
}

/**
 * Detect conflicts between local PrusaSlicer profiles and repo versions.
 * Returns an array of conflict objects for the UI to resolve.
 * Each conflict: { type, name, relPath, localModified, repoModified, localNewer, recommendation }
 */
async function detectConflicts() {
  const config = getConfig();
  const { prusaslicerDataDir, trackedProfiles } = config;
  const dir = getRepoDir();
  const git = getGit();
  const conflicts = [];

  if (!prusaslicerDataDir) return conflicts;

  for (const type of PROFILE_TYPES) {
    const names = trackedProfiles[type] || [];
    for (const name of names) {
      const localFile = path.join(prusaslicerDataDir, type, `${name}.ini`);
      const repoFile = path.join(dir, type, `${name}.ini`);
      const relPath = `${type}/${name}.ini`;

      const localExists = fs.existsSync(localFile);
      const repoExists = fs.existsSync(repoFile);

      // Only a conflict if both exist
      if (!localExists || !repoExists) continue;

      // Check if content actually differs
      const localContent = fs.readFileSync(localFile, 'utf-8');
      const repoContent = fs.readFileSync(repoFile, 'utf-8');
      if (localContent === repoContent) continue;

      // Get local file modification time
      const localStat = fs.statSync(localFile);
      const localModified = localStat.mtime;

      // Get repo file's last commit date
      let repoModified = null;
      try {
        const log = await git.log({ file: relPath, n: 1 });
        if (log.latest) {
          repoModified = new Date(log.latest.date);
        }
      } catch {
        // File might be new in repo, use file mtime as fallback
        const repoStat = fs.statSync(repoFile);
        repoModified = repoStat.mtime;
      }

      const localNewer = repoModified ? localModified > repoModified : true;

      conflicts.push({
        type,
        name,
        relPath,
        localModified: localModified.toISOString(),
        repoModified: repoModified ? repoModified.toISOString() : null,
        localNewer,
        recommendation: localNewer ? 'local' : 'remote',
        // Default resolution: keep the newer version
        resolution: localNewer ? 'local' : 'remote',
      });
    }
  }

  return conflicts;
}

/**
 * Apply conflict resolutions and then do a normal sync.
 * resolutions: array of { relPath, resolution: 'local' | 'remote' }
 */
async function resolveAndSync(resolutions) {
  if (syncInProgress) {
    return { success: false, changedFiles: [], error: 'Sync already in progress' };
  }

  syncInProgress = true;
  const config = getConfig();
  const { prusaslicerDataDir } = config;
  const dir = getRepoDir();
  const git = getGit();
  const changedFiles = [];

  try {
    for (const { relPath, resolution } of resolutions) {
      const localFile = path.join(prusaslicerDataDir, relPath);
      const repoFile = path.join(dir, relPath);

      if (resolution === 'local') {
        // Copy local → repo (local wins)
        if (fs.existsSync(localFile)) {
          const destDir = path.dirname(repoFile);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(localFile, repoFile);
          changedFiles.push(`resolved (keep local): ${relPath}`);
        }
      } else {
        // Copy repo → local (remote wins)
        if (fs.existsSync(repoFile)) {
          const destDir = path.dirname(localFile);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(repoFile, localFile);
          changedFiles.push(`resolved (keep remote): ${relPath}`);
        }
      }
    }

    // Commit any local-wins to the repo
    const status = await git.status();
    if (status.modified.length > 0 || status.not_added.length > 0) {
      await git.add('.');
      await git.commit('Sync: Resolve conflicts from new machine setup');
      await git.push('origin', 'main');
    }

    // Now do a normal pull to get everything in sync
    await gitPull();
    const pullResult = await pullToLocal();
    changedFiles.push(...pullResult.copiedFiles.map(f => `pulled: ${f}`));

    setConfig('lastSync', new Date().toISOString());
    setConfig('lastSyncStatus', 'ok');
    setConfig('lastError', null);
    setConfig('firstSyncDone', true);

    syncInProgress = false;
    return { success: true, changedFiles, error: null };
  } catch (err) {
    setConfig('lastSyncStatus', 'error');
    setConfig('lastError', err.message);
    syncInProgress = false;
    return { success: false, changedFiles, error: err.message };
  }
}

/**
 * Get information about the last commit in the repo.
 */
async function getLastCommitInfo() {
  try {
    const git = getGit();
    const log = await git.log({ n: 1 });

    if (!log.latest) {
      return { hash: null, message: null, date: null };
    }

    return {
      hash: log.latest.hash,
      message: log.latest.message,
      date: log.latest.date
    };
  } catch {
    return { hash: null, message: null, date: null };
  }
}

/**
 * List .ini profile files available in the git repo for each type.
 * Returns { printer: [...], filament: [...], print: [...] } with names (no extension).
 */
function listRemoteProfiles() {
  const dir = getRepoDir();
  const result = { printer: [], filament: [], print: [] };

  for (const type of PROFILE_TYPES) {
    const typeDir = path.join(dir, type);
    try {
      const files = fs.readdirSync(typeDir);
      result[type] = files
        .filter(f => f.endsWith('.ini'))
        .map(f => f.replace(/\.ini$/, ''))
        .sort();
    } catch {
      result[type] = [];
    }
  }

  return result;
}

/**
 * Check if a sync operation is currently running.
 */
function isSyncInProgress() {
  return syncInProgress;
}

module.exports = {
  ensureRepo,
  fullSync,
  pushFromLocal,
  pullToLocal,
  gitPull,
  getLastCommitInfo,
  listRemoteProfiles,
  isSyncInProgress,
  getRepoDir,
  detectConflicts,
  resolveAndSync
};
