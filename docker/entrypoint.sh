#!/usr/bin/env bash
# Prepares a throwaway-but-persistent remote environment, then becomes the
# server. Everything here is idempotent — the volumes survive restarts, so
# a second `up` reuses the auth, the git identity and the sample repo.
set -euo pipefail

DATA_DIR="${HARNESS_DATA_DIR:-/data}"
WORKSPACE="${NESS_WORKSPACE:-/workspace}"
PORT="${NESS_REMOTE_PORT:-37291}"

mkdir -p "$DATA_DIR" "$WORKSPACE"

# --- git identity -------------------------------------------------------
# Worktree creation and any commit an agent makes need one. Only set what
# isn't already there, so a bind-mounted host ~/.gitconfig wins.
git config --global --get user.email >/dev/null 2>&1 \
  || git config --global user.email "ness-remote@invalid.local"
git config --global --get user.name >/dev/null 2>&1 \
  || git config --global user.name "Ness Remote"
# The repos live on a volume owned by a different uid than whatever git
# decides it is; without this every git call fails "dubious ownership".
git config --global --get-all safe.directory 2>/dev/null | grep -qx '\*' \
  || git config --global --add safe.directory '*'

# --- a repo for the server to manage -----------------------------------
# Without at least one repo root the UI comes up empty and you can't
# exercise the thing you're testing (worktrees, agents, PR status).
if [ -n "${NESS_CLONE_URL:-}" ]; then
  REPO_NAME="$(basename "${NESS_CLONE_URL%.git}")"
  REPO_PATH="$WORKSPACE/$REPO_NAME"
  if [ ! -d "$REPO_PATH/.git" ]; then
    echo "[entrypoint] cloning $NESS_CLONE_URL -> $REPO_PATH"
    git clone "$NESS_CLONE_URL" "$REPO_PATH"
  fi
else
  REPO_PATH="$WORKSPACE/sample-app"
  if [ ! -d "$REPO_PATH/.git" ]; then
    echo "[entrypoint] seeding sample repo at $REPO_PATH"
    mkdir -p "$REPO_PATH"
    git -C "$REPO_PATH" init -q -b main
    cat > "$REPO_PATH/README.md" <<'EOF'
# sample-app

A throwaway repo so the containerised Ness remote has something to manage.
Create worktrees against it, run agents in it, break it freely — it is
recreated from scratch whenever the `ness-workspace` volume is reset.
EOF
    cat > "$REPO_PATH/greet.js" <<'EOF'
export function greet(name) {
  return `Hello, ${name}!`
}
EOF
    git -C "$REPO_PATH" add -A
    git -C "$REPO_PATH" commit -qm "Initial commit"
  fi
fi

# --- register the repo in config.json ----------------------------------
# Merge rather than overwrite: the config may already carry repos added
# through the UI, settings, pane layout, and so on.
CONFIG_PATH="$DATA_DIR/config.json" REPO_PATH="$REPO_PATH" node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const path = process.env.CONFIG_PATH
const repo = process.env.REPO_PATH
let config = {}
try {
  config = JSON.parse(readFileSync(path, "utf-8"))
} catch (e) {
  if (e.code !== "ENOENT") {
    // Leave a corrupt config alone — the app has its own recovery flow
    // for it, and clobbering it here would hide the bug being chased.
    console.error(`[entrypoint] ${path} is unreadable (${e.message}); not touching it`)
    process.exit(0)
  }
}
const roots = Array.isArray(config.repoRoots) ? config.repoRoots : []
if (!roots.includes(repo)) {
  config.repoRoots = [...roots, repo]
  writeFileSync(path, JSON.stringify(config, null, 2))
  console.log(`[entrypoint] registered repo root ${repo}`)
}
'

# --- become the server --------------------------------------------------
# 0.0.0.0 so the published port reaches it. The server's own banner
# prints the container-internal IP, which is not reachable from the host,
# so print the URL that actually works first.
echo "[entrypoint] connect from the host: http://127.0.0.1:${NESS_HOST_PORT:-$PORT}/?token=${HARNESS_AUTH_TOKEN:-}"

if [ "$#" -gt 0 ]; then
  exec node /app/dist-headless/main/index.js "$@"
fi
exec node /app/dist-headless/main/index.js --host 0.0.0.0 --port "$PORT"
