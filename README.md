# PrusaSlicer Profile Sync

A cross-platform desktop app that keeps PrusaSlicer profiles synchronized between machines using Git. Runs in your system tray and automatically syncs when profiles change.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **System Tray App** - Runs quietly in the background, syncs automatically
- **Selective Sync** - Choose which profiles to track; untracked profiles stay local
- **Real-Time File Watching** - Detects when PrusaSlicer saves a profile and syncs immediately
- **Multi-User** - Anyone with repo access can sync using their own GitHub token
- **Auto-Sync on Wake** - Syncs immediately when your computer wakes from sleep
- **Version History** - Git tracks every profile change with full history and rollback
- **Cross-Platform** - Windows, macOS, and Linux

## Download

Download the latest installer from [Releases](../../releases).

| Platform | Download |
|----------|----------|
| Windows | `PrusaSlicer Profile Sync Setup X.X.X.exe` |
| macOS | Coming soon |
| Linux | Coming soon |

## Quick Start

1. **Download and install** the app for your platform
2. **First run** opens a setup wizard:
   - Enter the GitHub repository URL for your shared profiles
   - Enter your GitHub Personal Access Token ([create one here](https://github.com/settings/tokens) with `repo` scope)
   - Confirm your PrusaSlicer data directory (auto-detected)
3. **Right-click the tray icon** → Settings → check the profiles you want to sync
4. That's it! The app syncs automatically every 30 seconds and when you save a profile.

## How It Works

```
You save a profile in PrusaSlicer
  → App detects the change (2-second debounce)
  → Commits and pushes to GitHub
  → Other machines pull on next sync cycle (30 seconds)
  → Updated profile appears in their PrusaSlicer
```

## System Tray

| Icon | Status |
|------|--------|
| Green | Synced and up to date |
| Yellow | Sync in progress |
| Red | Error (click to see details) |
| Grey | Not configured |

- **Left-click** or **double-click**: Open status window
- **Right-click**: Context menu (Sync Now, Settings, Status, Quit)

## Multi-User Setup

This app supports multiple users syncing to the same repository:

1. The repo owner creates a private GitHub repo and pushes their profiles
2. They add collaborators to the repo (Settings → Collaborators)
3. Each collaborator installs the app with:
   - The same repo URL
   - Their **own** GitHub PAT (with `repo` scope)
4. Everyone syncs independently using their own credentials

## Configuration

Settings are stored per-user and accessible via the Settings window:

| Setting | Default | Description |
|---------|---------|-------------|
| Repo URL | - | GitHub repository for shared profiles |
| GitHub Token | - | Your personal access token |
| PrusaSlicer Dir | Auto-detected | Path to PrusaSlicer config directory |
| Sync Interval | 30 seconds | How often to check for remote changes |
| Launch on Startup | Off | Start app when you log in |
| Show Notifications | On | Desktop notifications on sync |

## Building from Source

```bash
# Clone the repo
git clone https://github.com/3dprintpittsburgh/prusaslicer-profile-sync.git
cd prusaslicer-profile-sync

# Install dependencies
npm install

# Run in development
npm start

# Build installer for your platform
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

## Tech Stack

- [Electron](https://www.electronjs.org/) - Desktop app framework
- [simple-git](https://github.com/steveukx/git-js) - Git operations
- [chokidar](https://github.com/paulmillr/chokidar) - File system watching
- [electron-store](https://github.com/sindresorhus/electron-store) - Settings persistence
- [electron-builder](https://www.electron.build/) - Packaging and distribution

## License

MIT - Created by [3D Print Pittsburgh](https://3dprintpgh.com)
