#!/usr/bin/env bash
# Publish an evidence-reviewer report to a PR.
#
# Usage: publish.sh <out-dir> <pr-number>
# Env:   GH_TOKEN (contents:write + pull-requests:write), GITHUB_REPOSITORY,
#        GITHUB_RUN_ID, GITHUB_SERVER_URL
#
# PR comments can't embed uploaded images through the API, so screenshots
# are committed to an orphan `evidence-reviewer-assets` branch and the
# report links them by raw URL. One comment per PR, edited in place on
# re-runs (found by the marker below).

set -euo pipefail

OUT="$(cd "$1" && pwd)"
PR="$2"
BRANCH=evidence-reviewer-assets
MARKER='<!-- evidence-reviewer -->'
DEST="pr-$PR/$GITHUB_RUN_ID"
RAW="https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$BRANCH/$DEST"

shopt -s nullglob
PNGS=("$OUT"/*.png)
if [ ${#PNGS[@]} -gt 0 ]; then
  WORK="$(mktemp -d)"
  REMOTE="https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git"
  if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK"
  else
    git -C "$WORK" init -q -b "$BRANCH"
    git -C "$WORK" remote add origin "$REMOTE"
    printf 'Screenshots published by .github/workflows/evidence-review.yml. Safe to prune.\n' > "$WORK/README.md"
  fi
  mkdir -p "$WORK/$DEST"
  cp "${PNGS[@]}" "$WORK/$DEST/"
  git -C "$WORK" add -A
  git -C "$WORK" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -qm "Evidence for PR #$PR (run $GITHUB_RUN_ID)"
  for _ in 1 2 3; do
    git -C "$WORK" push -q origin "$BRANCH" && break
    git -C "$WORK" pull -q --rebase origin "$BRANCH"
  done
fi

RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
BODY="$(mktemp)"
{
  echo "$MARKER"
  sed -E "s#\]\(\./([^)]+\.png)\)#]($RAW/\1)#g" "$OUT/report.md"
  echo
  echo "<sub>Automated evidence review · [run log + transcript]($RUN_URL) · re-run with the \`evidence-review\` workflow</sub>"
} > "$BODY"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$BODY" >> "$GITHUB_STEP_SUMMARY"

EXISTING="$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | head -1)"
if [ -n "$EXISTING" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$EXISTING" -F body=@"$BODY" >/dev/null
  echo "updated comment $EXISTING"
else
  gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -F body=@"$BODY" >/dev/null
  echo "posted new comment"
fi
