Unsigned pre-release for Apple silicon Macs on macOS 14 or newer, and for Linux x64 on Debian 12 or newer and Ubuntu 22.04 or newer.

- Each agent's computer is a small virtual machine banda ships. It starts with the app, and with `banda serve`; Docker is not required. `banda serve --box container` still uses Docker when asked.
- The browser downloads on first use. General settings shows its preparation and running pages.
- Files and installed tools persist under `~/.banda/computer`.

**Mac.** Open the DMG and drag banda to Applications. This build is unsigned and not notarized. Follow [Apple's instructions for opening an unidentified app](https://support.apple.com/en-us/102445) if you choose to install it.

**Linux.** Install the package with `sudo apt install ./banda-*-linux-amd64.deb`. The computer needs hardware virtualization: your account must be able to read and write `/dev/kvm` (on most distributions, `sudo usermod -aG kvm $USER`, then sign in again). It runs under X11 and Wayland.

**Coming from an earlier pre-release.** A home whose computer ran in Docker brings its workspace, work folder and installed tools into `~/.banda/computer` the first time this version opens it, if Docker is running then; the Docker volumes are only read and stay where they are. The browser's signed-in sites are not brought. Keep a backup of an existing `~/.banda` before upgrading; a home from a much older pre-release may still need a fresh start.

The command-line archive includes Node.js. Unpack it and put `banda/bin` on your PATH. The desktop app and `banda serve` use the same home.

`SHA256SUMS` covers the downloads.
