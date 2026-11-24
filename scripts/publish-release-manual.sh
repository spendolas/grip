#!/usr/bin/env bash
# Publish a release that CI built and signed but could not publish itself (a flavour whose
# releasesApi names another repo and no RELEASES_PUBLISH_TOKEN secret exists).
# Usage: scripts/publish-release-manual.sh <run-id> [<build-repo>]
# Run it in a checkout of the build repo (it reads flavour/flavour.json for the target),
# signed in with `gh auth login` as someone who can write to the target repo.
# It never signs anything: the files and signature are exactly what CI produced.
set -euo pipefail
RUN="${1:?usage: $0 <run-id> [<build-repo>]}"
BUILD_REPO="${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL_REPO="$(node -e "const u=require('$ROOT/flavour/flavour.json').releasesApi;const m=/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(u);if(!m){console.error('releasesApi is not a github releases/latest URL');process.exit(1)}console.log(m[1])")"
if [ "$REL_REPO" = "$BUILD_REPO" ]; then echo "Target equals the build repo: CI publishes this itself."; exit 1; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" -R "$BUILD_REPO" -n grip-release -D "$TMP"
DIST="$TMP/dist"
V="$(node -p "require('$DIST/compat.json').version")"
echo "Build $RUN is version $V, target $REL_REPO"
( cd "$DIST" && shasum -a 256 -c SHA256SUMS.txt )
test -s "$DIST/SHA256SUMS.txt.sig" || { echo "missing SHA256SUMS.txt.sig"; exit 1; }
if gh release view "v$V" -R "$REL_REPO" >/dev/null 2>&1; then echo "Release v$V already exists in $REL_REPO; nothing done."; exit 1; fi
PRE=""; case "$V" in *-*) PRE="--prerelease" ;; esac
TARGET="$(gh api "repos/$REL_REPO" --jq .default_branch)"
read -r -p "Publish v$V to $REL_REPO? [y/N] " yn
[ "$yn" = "y" ] || { echo "Cancelled."; exit 1; }
# A draft first, so users never see a release with assets still uploading.
gh release create "v$V" -R "$REL_REPO" --draft --target "$TARGET" --title "v$V" --notes-file "$TMP/notes.md" $PRE "$DIST"/*
gh release edit "v$V" -R "$REL_REPO" --draft=false
echo "Published: https://github.com/$REL_REPO/releases/tag/v$V"
