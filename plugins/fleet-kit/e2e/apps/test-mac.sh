#!/bin/bash
# macOS: Fleet Kit's own code installs the official LibreOffice .dmg into the home folder, without sudo or an
# administrator password; then doc-review's own code converts Word and PowerPoint to PDF.
#   bash test-mac.sh <plugins folder> <samples folder> <report folder>
set -u
FLEET="$1/fleet-kit/src/host/install-app.ts"; DOCREVIEW="$1/doc-review/src/libreoffice.ts"; DOCS="$2"; OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
bad=0
say() { echo "$*" | tee -a "$OUT/summary.txt"; }
result() { if [ "$1" = 0 ]; then say "PASS  $2"; else bad=$((bad + 1)); say "FAIL  $2"; fi; }

URL=$(node -p "require('$HERE/versions.json')['mac-arm64'].url")
SHA=$(node -p "require('$HERE/versions.json')['mac-arm64'].sha256")
PKG="$(mktemp -d)/libreoffice.dmg"
curl -fsSL --retry 3 -o "$PKG" "$URL"
[ "$(shasum -a 256 "$PKG" | cut -d' ' -f1)" = "$SHA" ]; result $? "the .dmg matches versions.json"

APPS="$HOME/Library/Application Support/fleet-kit-ci/runtime/apps/libreoffice"
node --no-warnings --experimental-transform-types "$HERE/try-install.mjs" "$FLEET" "$PKG" dmg "LibreOffice.app/Contents/MacOS/soffice" "$APPS" "$OUT/install.json"
result $? "Fleet Kit installed LibreOffice"
SOFFICE=$(node -p "JSON.parse(require('fs').readFileSync('$OUT/install.json','utf8')).path" 2>/dev/null)
case "$SOFFICE" in "$HOME"/*) result 0 "in the home folder: $SOFFICE";; *) result 1 "outside the home folder: $SOFFICE";; esac
[ ! -e /Applications/LibreOffice.app ]; result $? "nothing in /Applications"
APP="$(dirname "$(dirname "$(dirname "$SOFFICE")")")"
! xattr -l "$APP" | grep -q com.apple.quarantine; result $? "the copy has no quarantine attribute"
codesign --verify --deep --strict "$APP" >>"$OUT/codesign.txt" 2>&1; result $? "the copy keeps its signature"

mkdir -p "$OUT/pdf"
node --no-warnings --experimental-transform-types "$HERE/convert.mjs" "$DOCREVIEW" "$SOFFICE" "$DOCS" "$OUT/pdf" | tee "$OUT/convert.json"
result "${PIPESTATUS[0]}" "doc-review found the program and converted Word and PowerPoint to PDF"
find "$OUT/pdf" -type f -exec ls -la {} + >>"$OUT/summary.txt"
"$SOFFICE" --version >>"$OUT/summary.txt" 2>&1
du -sh "$APPS" >>"$OUT/summary.txt"
say "failures: $bad"
exit $((bad > 0))
