#!/usr/bin/env bash
# Builds the prebuilt SAP guest image into DATA_DIR/sap-image.
#
# The browser-side signer normally loads Apple's binaries itself: parsing
# Mach-O, interpreting the dyld bind and rebase opcodes, and relocating three
# images. All of that is deterministic — fixed bytes, fixed load bases, and
# shim addresses the client controls — so it can be done once here instead,
# with ipatool's own loader, and the resulting guest memory shipped as blobs.
#
# This is optional. Without an image the client loads the images itself and
# signs in just the same; see frontend/src/apple/sap/README.md.
#
# Needs a Go toolchain. ipatool downloads libunicorn and Apple's binaries on
# first run and caches them, so the first build is slower and needs network.
#
#   tools/sap-image/build.sh [output-directory]
#
# Default output is ./mnt/asspp-data/sap-image, matching compose.yml's volume.

set -euo pipefail

VERSION="v2.4.0"
REPO="https://github.com/majd/ipatool.git"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$(cd "$here/../.." && pwd)/mnt/asspp-data/sap-image}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

command -v go >/dev/null || { echo "go is required" >&2; exit 1; }

echo "cloning ipatool $VERSION"
git clone --depth 1 --branch "$VERSION" "$REPO" "$work/ipatool" 2>&1 | tail -1

# The dumper reads back the guest memory the loader produced. It lives in a
# patch rather than a fork so the pinned upstream stays obvious.
echo "applying dumper patch"
git -C "$work/ipatool" apply "$here/ipatool-dumper.patch"

echo "building"
(cd "$work/ipatool" && go build ./cmd/dumpsap)

mkdir -p "$out"
echo "dumping to $out"
"$work/ipatool/dumpsap" -out "$out"

echo
echo "done. The backend serves this at /api/sap/image/ and the client uses it"
echo "in place of loading the images itself."
