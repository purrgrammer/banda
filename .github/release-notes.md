A pre-release build of banda, for convenience. It is not a qualified release: expect rough edges.

Every release has three parts: the **desktop app**, the **command line** and the **phone app**. `SHA256SUMS` lists
every file's checksum.

**Docker is required** on the computer that runs banda: the agents' computer runs in a container. Install Docker
Desktop, OrbStack or Colima (macOS), Docker Desktop (Windows) or Docker Engine (Linux), and start it. Without it banda
runs, but says its computer is off.

**A home from another version won't open.** Before 1.0, banda changes how it stores things without converting them. If
the app says so, rename `~/.banda` to keep it and start fresh, or go back to the version that made it.

## Desktop

| You have | Download |
|---|---|
| Mac with Apple silicon | `banda-<version>-mac-arm64.dmg` |
| Windows | `banda-<version>-win-x64.exe` |
| Linux | `banda-<version>-linux-x64.AppImage` or `.deb` |
| Linux on ARM | `banda-<version>-linux-arm64.AppImage` or `.deb` |

- **macOS requires Apple silicon.** Open the `.dmg` and drag banda onto Applications. The app is not notarized yet, so the first time, open
  it, then go to System Settings → Privacy & Security → Open Anyway. Or run
  `xattr -dr com.apple.quarantine /Applications/banda.app`.
- **Windows:** the installer is unsigned: SmartScreen → More info → Run anyway.

## Command line

| You have | Download |
|---|---|
| Mac with Apple silicon | `banda-cli-<version>-mac-arm64.tar.gz` |
| Windows | `banda-cli-<version>-win-x64.zip` |
| Linux | `banda-cli-<version>-linux-x64.tar.gz` |
| Linux on ARM | `banda-cli-<version>-linux-arm64.tar.gz` |

Unpack the archive, put its `banda/bin` folder on your PATH, and run `banda serve`. It brings its own Node.js.
`banda --help` lists the commands. The desktop app and `banda serve` share `~/.banda`. If `banda serve` is already
running, the app opens it instead of starting another, and quitting the app stops it.

## Phone

| You have | Download |
|---|---|
| Android phone (arm64) | `banda-<version>-android-arm64.apk` |

Install the APK on an Android phone (allow installs from your browser or files app when it asks). Open it, then on
the computer that runs banda open Settings → Devices → Pair a phone and scan the code. Approve the phone there and it
opens your band, at home or away: it reaches your computer through Iroh's relays, never through an open port. A newer
APK installs over this one. Your computer reaches no relay until you pair a phone.
