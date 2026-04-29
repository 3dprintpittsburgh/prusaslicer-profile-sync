# PrusaSlicer Profile Sync — Electron App Dev Context

## Overview
Cross-platform Electron desktop app that syncs PrusaSlicer profiles between machines via a shared GitHub repo. Runs in system tray, watches for file changes, auto-commits/pushes/pulls.

## GitHub
- **App repo (public)**: https://github.com/3dprintpittsburgh/prusaslicer-profile-sync
- **Profiles repo (private)**: https://github.com/3dprintpittsburgh/prusaslicer-profiles
- **GitHub account**: 3dprintpittsburgh (PAT in Bitwarden: `3dprintpgh_github_pat`)
- **Jareth's sync PAT**: In Bitwarden as `jareth_prusaslicer_sync_pat`

## Tech Stack
- Electron 33
- simple-git (git operations)
- chokidar v4 (file watching)
- electron-updater (auto-updates from GitHub releases)
- Plain JSON file store (replaced electron-store due to ESM issues)
- No external CSS frameworks - custom dark theme

## Project Structure
```
src/
├── main/
│   ├── index.js      — Main process: app lifecycle, IPC, sync orchestration, auto-updater
│   ├── config.js     — JSON config store (~/.config/prusaslicer-profile-sync/config.json)
│   ├── sync.js       — Git sync engine (clone, push, pull, file copy)
│   ├── watcher.js    — Chokidar file watcher with 2s debounce
│   ├── tray.js       — System tray with colored state icons + context menu
│   └── preload.js    — Context bridge (window.api)
└── renderer/
    ├── styles.css    — Shared dark theme CSS
    ├── deps.html     — Dependency checker (Git auto-install)
    ├── setup.html    — First-run wizard
    ├── status.html   — Status window (last sync, activity log, update check)
    └── settings.html — Settings (repo, PAT, tracked profiles checkboxes)
```

## Key Design Decisions
- **Push before pull** — local edits pushed first so they aren't overwritten
- **Selective sync** — only checked profiles sync, non-tracked stay local
- **electron-updater** — auto-downloads updates from GitHub releases, installs on restart
- **Process detection** — finds running PrusaSlicer via wmic (Windows) or pgrep (Linux/Mac)
- **Restart notification** — on incoming profile changes, offers to restart PrusaSlicer via click
- **No electron-store** — replaced with plain fs JSON (electron-store v10+ is ESM-only, breaks require())
- **Git identity** — auto-configured per-repo (prusaslicer-sync@3dprintpgh.com) so machines without global git config still work

## Version History
| Version | Changes |
|---------|---------|
| 1.0.0 | Initial release: sync engine, file watcher, tray, settings UI, dependency checker |
| 1.1.0 | PrusaSlicer restart notification when incoming profiles detected while PS is running |
| 1.2.0 | Auto-updates from GitHub releases, "Check for Updates" button in status + tray |

## Bugs Fixed
- **ERR_REQUIRE_ESM** — electron-store v10 is ESM-only, replaced with plain JSON
- **Author identity unknown** — git user.email/name not set, now auto-configured on clone/validate

## Building & Releasing
```bash
# Build Windows installer
npm run build:win

# The build produces:
#   dist/PrusaSlicer Profile Sync Setup X.X.X.exe
#   dist/latest.yml  (needed by electron-updater)

# To release:
# 1. Bump version in package.json
# 2. Build
# 3. Create GitHub release with tag vX.X.X
# 4. Upload both the .exe AND latest.yml to the release assets
# 5. All running instances auto-detect the update within seconds
```

## Config File Location
- **Windows**: `%APPDATA%/prusaslicer-profile-sync/config.json`
- **Linux**: `~/.config/prusaslicer-profile-sync/config.json`
- **macOS**: `~/Library/Application Support/prusaslicer-profile-sync/config.json`

## Multi-User Support
Any GitHub user with access to the profiles repo can use the app with their own PAT. The app doesn't assume any specific account — repo URL + token are user-provided in settings.

## Related Documentation
- Architecture: `/root/projects/client/3dprintpgh-server/custom-quote-tool/PROFILE-SYSTEM-ARCHITECTURE.md`
- Session log: `/root/projects/client/3dprintpgh-server/custom-quote-tool/SESSION-PROFILE-SYSTEM.md`
- Quote tool context: `/root/projects/client/3dprintpgh-server/custom-quote-tool/README.md`
