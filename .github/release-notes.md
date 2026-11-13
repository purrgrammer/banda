Unsigned Mac pre-release for Apple silicon on macOS 14 or newer.

- The computer starts with the app. Docker is not required on Mac.
- The browser downloads on first use. General settings shows its preparation and running pages.
- Files and installed tools persist under `~/.banda/computer`.

Open the DMG and drag banda to Applications. This build is unsigned and not notarized. Follow [Apple's instructions for opening an unidentified app](https://support.apple.com/en-us/102445) if you choose to install it.

Older pre-release homes may need a fresh start. Keep a backup of an existing `~/.banda` before upgrading.

The command-line archive includes Node.js. Unpack it and put `banda/bin` on your PATH. The desktop app and `banda serve` use the same home.

`SHA256SUMS` covers the downloads. `computer-distribution.json` binds the app, browser, source shards and notice materials. `RELEASE-REVIEW.md` explains how to reconstruct and verify the sources and notices.

This release publishes Mac assets only. Other platforms retain their previous downloads. Native Linux qualification and clean-Mac installation testing remain open.
