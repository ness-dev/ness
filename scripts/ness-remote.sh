#!/usr/bin/env bash
#
# Run a Ness remote backend (harness-server) in a container, for developing
# and testing remote / multi-backend features without touching a real server.
#
# Usage: scripts/ness-remote.sh <command> [options]
#
# Commands:
#   up         Build and start the remote, wait for it, print the connect URL
#   down       Stop and remove the container (volumes kept)
#   reset      Stop and remove the container AND its volumes (auth, workspace)
#   restart    Restart the server process without rebuilding
#   logs       Follow the server log
#   shell      Open a shell inside the container
#   url        Print the connect URL
#   status     Show whether it's running and on which port
#
# Options (for `up`):
#   --host-claude   Share the host's ~/.claude credentials instead of authing
#                   separately inside the container (see
#                   docker/compose.host-claude.yaml for the tradeoff)
#   --no-build      Skip the image build and start what's already built
#
# Environment:
#   NESS_REMOTE_PORT   Host port to publish (default 37291)
#   NESS_REMOTE_TOKEN  Auth token (default ness-dev-token)
#   NESS_CLONE_URL     Clone this repo into the remote's workspace instead of
#                      seeding a throwaway sample repo
#   ANTHROPIC_API_KEY  Passed through when set, so agents work without a login
#   OPENAI_API_KEY     Same, for Codex
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/compose.yaml"
HOST_CLAUDE_FILE="$REPO_ROOT/docker/compose.host-claude.yaml"
SERVICE="ness-remote"

PORT="${NESS_REMOTE_PORT:-37291}"
TOKEN="${NESS_REMOTE_TOKEN:-ness-dev-token}"
URL="http://127.0.0.1:${PORT}/?token=${TOKEN}"

# Readiness ceiling. The first `up` after a code change rebuilds the image
# before this clock starts, so it only has to cover server boot.
READY_TIMEOUT_SECS=90

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

command -v docker >/dev/null 2>&1 || err "docker is required but not installed"
docker compose version >/dev/null 2>&1 \
  || err "docker compose v2 is required (got: $(docker --version))"

COMPOSE_ARGS=(-f "$COMPOSE_FILE")

# --- command + option parsing ------------------------------------------
CMD="${1:-up}"
shift || true

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --host-claude)
      [ -e "$HOME/.claude.json" ] \
        || err "~/.claude.json does not exist on the host — run \`claude\` once first, or drop --host-claude"
      COMPOSE_ARGS+=(-f "$HOST_CLAUDE_FILE")
      ;;
    --no-build) BUILD=0 ;;
    *) err "unknown option: $arg" ;;
  esac
done

compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

is_running() {
  [ -n "$(compose ps -q "$SERVICE" 2>/dev/null)" ] \
    && [ "$(docker inspect -f '{{.State.Running}}' "$(compose ps -q "$SERVICE")" 2>/dev/null)" = "true" ]
}

# The web client's HTML is served only to an authenticated request, so a
# 200 here proves the HTTP server, the token and the bundle are all good.
wait_until_ready() {
  local waited=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECS" ]; do
    if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
      return 0
    fi
    if ! is_running; then
      log ''
      log "the container exited during startup — last 40 log lines:"
      compose logs --tail 40 "$SERVICE" || true
      err "remote failed to start"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log ''
  log "last 40 log lines:"
  compose logs --tail 40 "$SERVICE" || true
  err "remote did not answer on $URL within ${READY_TIMEOUT_SECS}s"
}

print_connection() {
  cat <<EOF

  Ness remote is up.

  Web client   $URL
  Add to Ness  paste that URL into the sidebar's backend chip strip (+)
               or File → Add Backend…, then "Test & save"

  Logs         npm run remote:logs
  Shell        npm run remote:shell
  Stop         npm run remote:down

EOF
}

case "$CMD" in
  up)
    if [ "$BUILD" -eq 1 ]; then
      log "=== building image (cached layers reused; first run takes a few minutes) ==="
      compose build "$SERVICE"
    fi
    log "=== starting $SERVICE on port $PORT ==="
    compose up -d "$SERVICE"
    log "=== waiting for the server to answer ==="
    wait_until_ready
    print_connection
    ;;

  down)
    compose down
    log "stopped. volumes kept — \`reset\` discards them."
    ;;

  reset)
    compose down -v
    log "stopped and removed volumes (auth, config and workspace are gone)."
    ;;

  restart)
    is_running || err "not running — start it with: npm run remote:up"
    compose restart "$SERVICE"
    wait_until_ready
    print_connection
    ;;

  logs)
    compose logs -f "$SERVICE"
    ;;

  shell)
    is_running || err "not running — start it with: npm run remote:up"
    compose exec "$SERVICE" zsh
    ;;

  url)
    printf '%s\n' "$URL"
    ;;

  status)
    if is_running; then
      log "running — $URL"
      compose ps "$SERVICE"
    else
      log "not running"
    fi
    ;;

  -h|--help|help)
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;

  *)
    err "unknown command: $CMD (try: up, down, reset, restart, logs, shell, url, status)"
    ;;
esac
