#!/usr/bin/env bash
# Fetch the two compilers the contracts need, pinned and verified.
#
#   solc    the Solidity frontend
#   resolc  revive — lowers solc's IR to a PolkaVM blob
#
# Neither is committed: resolc alone is 87 MB. This script is what makes the
# repo self-sufficient, which matters because the alternative already bit us —
# tools/pvm-size-spike.mjs reaches into DATUM's hardhat compiler cache to find a
# solc, so it only runs on a machine that has separately built DATUM.
#
#   tools/fetch-toolchain.sh [--force]
#
# Both land in tools/ and are gitignored.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOLC_VERSION="0.8.24"
RESOLC_VERSION="1.4.0"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

say() { printf '%s\n' "$*" >&2; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }
need curl
need sha256sum

# solc and resolc name platforms differently, so resolve both from one detect.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   SOLC_PLATFORM=linux-amd64;   SOLC_ASSET=solc-static-linux
                  RESOLC_ASSET=resolc-x86_64-unknown-linux-musl ;;
  Darwin-arm64|Darwin-x86_64)
                  SOLC_PLATFORM=macosx-amd64;  SOLC_ASSET=solc-macos
                  RESOLC_ASSET=resolc-universal-apple-darwin ;;
  *) die "Unsupported platform $(uname -s)-$(uname -m). Fetch solc $SOLC_VERSION and resolc $RESOLC_VERSION by hand into tools/." ;;
esac

# ── solc ────────────────────────────────────────────────────────────────────
#
# Verified against the sha256 in the official list.json rather than a hash
# pinned in this file. Pinning here would go stale silently on a rebuild;
# list.json is signed infrastructure that publishes a digest per build.
fetch_solc() {
  local dest="$HERE/solc"
  if [[ -x "$dest" && $FORCE -eq 0 ]]; then
    say "solc     $("$dest" --version | tail -1 | tr -d '\n')  (cached)"
    return
  fi

  local base="https://binaries.soliditylang.org/$SOLC_PLATFORM"
  say "solc     fetching $SOLC_VERSION for $SOLC_PLATFORM…"

  local list build want
  list="$(curl -fsSL "$base/list.json")" || die "could not fetch $base/list.json"
  build="$(printf '%s' "$list" | python3 -c '
import json,sys
want = sys.argv[1]
data = json.load(sys.stdin)
for b in data["builds"]:
    if b["version"] == want and b.get("prerelease") is None:
        print(b["path"], b["sha256"])
        break
else:
    sys.exit(1)
' "$SOLC_VERSION")" || die "solc $SOLC_VERSION is not in list.json for $SOLC_PLATFORM"

  local path
  path="${build%% *}"
  want="${build##* }"
  want="${want#0x}"

  curl -fsSL "$base/$path" -o "$dest.tmp" || die "download failed: $base/$path"
  local got
  got="$(sha256sum "$dest.tmp" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dest.tmp"
    die "solc checksum mismatch
       expected $want
       got      $got"
  fi
  chmod +x "$dest.tmp"
  mv "$dest.tmp" "$dest"
  say "solc     $("$dest" --version | tail -1 | tr -d '\n')  ✓ sha256"
}

# ── resolc ──────────────────────────────────────────────────────────────────
#
# Verified against tools/checksums.txt, which ships with the repo. Parity
# publishes no per-release digest file, so the hash is pinned here; refreshing
# resolc means updating that file in the same commit, deliberately.
fetch_resolc() {
  local dest="$HERE/resolc"
  if [[ -x "$dest" && $FORCE -eq 0 ]]; then
    say "resolc   $("$dest" --version | tail -1 | tr -d '\n')  (cached)"
    return
  fi

  local sums="$HERE/checksums.txt"
  [[ -f "$sums" ]] || die "tools/checksums.txt is missing — cannot verify resolc."
  local want
  want="$(awk -v a="$RESOLC_ASSET" '$2 == a { print $1 }' "$sums")"
  [[ -n "$want" ]] || die "no checksum for $RESOLC_ASSET in tools/checksums.txt"

  local url="https://github.com/paritytech/revive/releases/download/v$RESOLC_VERSION/$RESOLC_ASSET"
  say "resolc   fetching $RESOLC_VERSION…"
  curl -fsSL "$url" -o "$dest.tmp" || die "download failed: $url"

  local got
  got="$(sha256sum "$dest.tmp" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dest.tmp"
    die "resolc checksum mismatch
       expected $want
       got      $got
       If this is an intentional version bump, update tools/checksums.txt."
  fi
  chmod +x "$dest.tmp"
  mv "$dest.tmp" "$dest"
  say "resolc   $("$dest" --version | tail -1 | tr -d '\n')  ✓ sha256"
}

fetch_solc
fetch_resolc
say ""
say "Both in $HERE. resolc invokes solc by name, so build scripts put tools/ on PATH."
