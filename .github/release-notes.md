A pre-release build of banda, for convenience. It is not a qualified release: expect rough edges.

## Pick a download

| You have | Desktop app | Command line only |
|---|---|---|
| Mac with Apple silicon | `banda-<version>-mac-arm64.dmg` | `banda-cli-<version>-mac-arm64.tar.gz` |
| Mac with Intel | `banda-<version>-mac-x64.dmg` | `banda-cli-<version>-mac-x64.tar.gz` |
| Windows | `banda-<version>-win-x64.exe` | `banda-cli-<version>-win-x64.zip` |
| Linux | `banda-<version>-linux-x64.AppImage` or `.deb` | `banda-cli-<version>-linux-x64.tar.gz` |
| Linux on ARM | `banda-<version>-linux-arm64.AppImage` or `.deb` | `banda-cli-<version>-linux-arm64.tar.gz` |

`SHA256SUMS` lists every file's checksum.

## Before you start

- **Docker is required.** The agents' computer runs in a container. Install Docker Desktop, OrbStack or Colima (macOS),
  Docker Desktop (Windows) or Docker Engine (Linux), and start it. Without it banda runs, but says its computer is off.
- **These builds are unsigned.**
  - macOS: open the app once, then System Settings → Privacy & Security → Open Anyway. Or run
    `xattr -dr com.apple.quarantine /Applications/banda.app`.
  - Windows: SmartScreen → More info → Run anyway.
- **A home from another version won't open.** Before 1.0, banda changes how it stores things without converting them.
  If the app says so, rename `~/.banda` to keep it and start fresh, or go back to the version that made it.

## The command line

Unpack the archive, put its `banda/bin` folder on your PATH, and run `banda serve`. It brings its own Node.js.
`banda --help` lists the commands. The desktop app and `banda serve` share `~/.banda`. If `banda serve` is already
running, the app opens it instead of starting another, and quitting the app stops it.
