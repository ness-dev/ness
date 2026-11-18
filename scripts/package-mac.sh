#!/usr/bin/env bash
# Runs `electron-builder --mac`, retrying only when hdiutil flakes during
# DMG creation. GitHub's hosted macOS runners intermittently fail
# `hdiutil create` with "Device not configured" / "Resource busy" on an
# otherwise-good build (electron-builder#9155). Any other failure exits
# immediately, so a genuine signing or notarization error isn't retried.
#
# A retry re-runs the whole build, including sign + notarize: the DMG is
# built after notarization, so each retry is another Apple submission
# (~5 min per arch). Rebuilding only the DMG via --prepackaged would avoid
# that, but needs per-arch app dirs and a second code path; a rare flake
# doesn't justify it.
set -uo pipefail

MAX_ATTEMPTS=3
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "::group::electron-builder --mac (attempt $attempt/$MAX_ATTEMPTS)"
  npx electron-builder --mac --publish=never "$@" 2>&1 | tee "$LOG"
  status=${PIPESTATUS[0]}
  echo "::endgroup::"

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if ! grep -qE 'hdiutil: .*(create failed|Device not configured|Resource busy)' "$LOG"; then
    echo "::error::electron-builder failed (exit $status) with a non-hdiutil error; not retrying."
    exit "$status"
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    echo "::warning::hdiutil flaked on attempt $attempt; retrying in 30s."
    # A volume left mounted by the failed attempt can itself cause
    # "Resource busy" on the next hdiutil create.
    for vol in /Volumes/Ness*; do
      [ -d "$vol" ] && hdiutil detach -force "$vol" || true
    done
    sleep 30
  fi
done

echo "::error::hdiutil kept failing after $MAX_ATTEMPTS attempts."
exit 1
