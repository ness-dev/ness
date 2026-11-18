#!/usr/bin/env bash
# Runs `electron-builder --mac`, retrying only when hdiutil flakes during
# DMG creation. GitHub's hosted macOS runners intermittently fail
# `hdiutil create` with "Device not configured" / "Resource busy" on an
# otherwise-good build (electron-builder#9155). Any other failure exits
# immediately so a genuine signing or notarization error isn't
# resubmitted to Apple.
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
    sleep 30
  fi
done

echo "::error::hdiutil kept failing after $MAX_ATTEMPTS attempts."
exit 1
