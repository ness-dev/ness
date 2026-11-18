#!/usr/bin/env bash
# Ness-specific "app under test" bootstrapper for the evidence reviewer.
#
# Usage: boot-ness.sh <checkout-dir> <port> <label>
#
# Expects <checkout-dir> to already contain a built headless bundle
# (dist-headless/). Seeds a deterministic fixture git repo + an isolated
# data dir, launches harness-server on 127.0.0.1:<port>, waits for it to
# advertise its URL, and prints that URL on stdout. The server PID is
# written to $RUNNER_TEMP/evidence-<label>.pid (or /tmp) for cleanup.
#
# Everything app-specific lives here and in .github/evidence-reviewer/;
# scripts/evidence-reviewer/run.mjs only ever sees a URL.

set -euo pipefail

CHECKOUT="$(cd "$1" && pwd)"
PORT="$2"
LABEL="$3"
TMP="${RUNNER_TEMP:-/tmp}/evidence-$LABEL"
rm -rf "$TMP"
mkdir -p "$TMP"

FIXTURE="$TMP/acme-app"
DATA_DIR="$TMP/data"
LOG="$TMP/server.log"
TOKEN="evidence-$LABEL"

git_q() { git -C "$FIXTURE" -c user.name=Fixture -c user.email=fixture@example.com "$@" >/dev/null; }

mkdir -p "$FIXTURE/src"
git -C "$FIXTURE" init -q -b main
printf '# acme-app\n\nA fixture repo for the evidence reviewer.\n' > "$FIXTURE/README.md"
printf 'export function greet(name: string) {\n  return `Hello, ${name}`\n}\n' > "$FIXTURE/src/greet.ts"
git_q add -A
git_q commit -m "Initial commit"
printf 'export const VERSION = "1.0.0"\n' > "$FIXTURE/src/version.ts"
git_q add -A
git_q commit -m "Add version constant"

git_q worktree add -q -b feature/login "$TMP/acme-app-login"
printf 'export function login(user: string) {\n  return { user, ok: true }\n}\n' > "$TMP/acme-app-login/src/login.ts"
git -C "$TMP/acme-app-login" -c user.name=Fixture -c user.email=fixture@example.com add -A >/dev/null
git -C "$TMP/acme-app-login" -c user.name=Fixture -c user.email=fixture@example.com commit -qm "Add login helper"
printf '\n// TODO: rate limiting\n' >> "$TMP/acme-app-login/src/login.ts"

git_q worktree add -q -b fix/readme-typo "$TMP/acme-app-typo"
printf '# acme-app\n\nA fixture repository for the evidence reviewer.\n' > "$TMP/acme-app-typo/README.md"

mkdir -p "$DATA_DIR"
cat > "$DATA_DIR/config.json" <<EOF
{
  "schemaVersion": 8,
  "repoRoots": ["$FIXTURE"],
  "hooksConsent": "declined",
  "onboarding": { "quest": "done" }
}
EOF

# Keep the server off the real GitHub API: the fixture has no remote, and
# a token in env would make PR polling hit api.github.com for nothing.
env -u GITHUB_TOKEN -u GH_TOKEN \
  HARNESS_DATA_DIR="$DATA_DIR" \
  HARNESS_AUTH_TOKEN="$TOKEN" \
  node "$CHECKOUT/dist-headless/main/index.js" --port "$PORT" --host 127.0.0.1 \
  > "$LOG" 2>&1 &
echo $! > "$TMP.pid"

for _ in $(seq 1 100); do
  if grep -q '\[web-client\] open' "$LOG"; then
    echo "http://127.0.0.1:$PORT/?token=$TOKEN"
    exit 0
  fi
  sleep 0.2
done
echo "::error::$LABEL server did not come up within 20s" >&2
cat "$LOG" >&2
exit 1
