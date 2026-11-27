#!/bin/sh
# Gap G: what Electron 45.2.3 offers for an OS re-authentication. Nothing is run and nobody is prompted: the typings
# come from the npm tarball (npm pack runs no install script) and the implementation from the v45.2.3 tag.
set -eu
D=$(mktemp -d)
cd "$D"
npm pack electron@45.2.3 --silent >/dev/null
tar xzf electron-45.2.3.tgz package/electron.d.ts
grep -n "promptTouchID\|canPromptTouchID" package/electron.d.ts
grep -c "@platform darwin" package/electron.d.ts >/dev/null
curl -s -o system_preferences_mac.mm \
  https://raw.githubusercontent.com/electron/electron/v45.2.3/shell/browser/api/electron_api_system_preferences_mac.mm
grep -n "LAPolicy\|biometryType\|kSecAccessControl\|evaluateAccessControl\|LAAccessControlOperation" system_preferences_mac.mm
grep -rn "promptTouchID\|UserPresence\|polkit" package/electron.d.ts | grep -v "@platform darwin" | head
