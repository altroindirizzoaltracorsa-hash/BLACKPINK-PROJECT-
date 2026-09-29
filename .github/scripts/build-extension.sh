#!/usr/bin/env bash
# Package the Vote Counter into the two zips the /voting page links to.
#
# There are two builds off ONE source tree (see vote-extension/README.md):
#   chrome  — manifest.json as-is, Manifest V3, desktop Chrome/Chromium.
#   android — manifest-mv2.json copied in AS manifest.json, Manifest V2, for the
#             Kiwi-family Android browsers (Kiwi, Lemur, Quetta). Those forks do
#             not reliably inject MV3 content scripts, so MV2 is deliberate, not
#             legacy. Chromium prints a "Manifest version 2 is deprecated" WARNING
#             on install there; the extension still loads and runs.
#
# Packing this by hand is how you ship the wrong manifest in the wrong zip, so
# the script asserts the result instead of trusting itself: each zip must contain
# exactly one manifest, at the right manifest_version, with the version both
# manifests agree on, and exactly the expected file list.
#
#   ./.github/scripts/build-extension.sh
#
# Writes ./vote-extension-v<version>-chrome.zip and -android.zip at the repo root.

set -euo pipefail
cd "$(dirname "$0")/../.."

SRC=vote-extension
[ -d "$SRC" ] || { echo "no $SRC directory here" >&2; exit 1; }

ver() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$1"; }
mver() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['manifest_version'])" "$1"; }

V3_VER=$(ver "$SRC/manifest.json")
V2_VER=$(ver "$SRC/manifest-mv2.json")
if [ "$V3_VER" != "$V2_VER" ]; then
  echo "version mismatch: manifest.json is $V3_VER but manifest-mv2.json is $V2_VER" >&2
  echo "bump both together — the two zips must be the same release." >&2
  exit 1
fi
VERSION=$V3_VER
echo "building v$VERSION"

# Everything the extension needs at runtime. Neither README.md nor the unused
# manifest ships: a stray manifest-mv2.json inside the chrome zip is refused by
# Chrome, and the README is just weight.
PAYLOAD=(manifest.json background.js panel.js popup.html popup.js bu-link.js assets)

build() {
  local flavour=$1 manifest=$2 want_mv=$3
  local out; out="$PWD/vote-extension-v$VERSION-$flavour.zip"
  local tmp; tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  cp -r "$SRC/background.js" "$SRC/panel.js" "$SRC/popup.html" "$SRC/popup.js" \
        "$SRC/bu-link.js" "$SRC/assets" "$tmp/"
  cp "$SRC/$manifest" "$tmp/manifest.json"

  rm -f "$out"
  ( cd "$tmp" && zip -q -r -X "$out" "${PAYLOAD[@]}" )

  # ── assertions, not hope ──
  local got_mv; got_mv=$(unzip -p "$out" manifest.json | python3 -c "import json,sys;print(json.load(sys.stdin)['manifest_version'])")
  [ "$got_mv" = "$want_mv" ] || { echo "$flavour: manifest_version is $got_mv, expected $want_mv" >&2; exit 1; }
  local got_ver; got_ver=$(unzip -p "$out" manifest.json | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
  [ "$got_ver" = "$VERSION" ] || { echo "$flavour: zip says v$got_ver, expected v$VERSION" >&2; exit 1; }
  local n_manifest; n_manifest=$(unzip -Z1 "$out" | grep -c 'manifest' || true)
  [ "$n_manifest" = "1" ] || { echo "$flavour: $n_manifest manifests in the zip, expected exactly 1" >&2; exit 1; }
  unzip -Z1 "$out" | grep -q 'README' && { echo "$flavour: README leaked into the zip" >&2; exit 1; }

  local listing; listing=$(unzip -Z1 "$out" | sed 's:/$::' | sort | tr '\n' ' ')
  local expected="assets assets/heart.png assets/lightstick.png background.js bu-link.js manifest.json panel.js popup.html popup.js "
  [ "$listing" = "$expected" ] || { echo "$flavour: unexpected file list:" >&2; echo "  got:      $listing" >&2; echo "  expected: $expected" >&2; exit 1; }

  echo "  ok  $(basename "$out")  (MV$got_mv, $(unzip -Z1 "$out" | wc -l) entries, $(du -h "$out" | cut -f1))"
}

build chrome  manifest.json     3
build android manifest-mv2.json 2

echo
echo "Built v$VERSION. Remember the three places the site names a version:"
echo "  index.html            — EXT_LATEST_VERSION, the update popup, the download links"
echo "  vote-counter-guide.html — the kicker and the footer"
