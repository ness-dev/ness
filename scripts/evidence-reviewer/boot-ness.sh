#!/usr/bin/env bash
# Ness-specific "app under test" bootstrapper for the evidence reviewer.
#
# Usage: boot-ness.sh <checkout-dir> <port> <label>
#
# Expects <checkout-dir> to already contain a built headless bundle
# (dist-headless/). Seeds a deterministic fixture git repo + an isolated
# data dir, launches harness-server on 127.0.0.1:<port>, waits for it to
# advertise its URL, and prints that URL on stdout. The server's log and
# PID go to $RUNNER_TEMP/evidence-<label>.{log,pid} (or /tmp).
#
# Everything app-specific lives here and in .github/evidence-reviewer/;
# scripts/evidence-reviewer/run.mjs only ever sees a URL.
#
# Agents inside Ness work too: the server gets an isolated $HOME whose
# ~/.claude/settings.json points Claude Code at run.mjs's local proxy
# (127.0.0.1:$EVIDENCE_AGENT_PROXY_PORT) with a dummy token and every model
# alias mapped to EVIDENCE_AGENT_MODEL. The proxy adds the real OpenRouter
# key, so no config or env an agent here can read contains it.
# Chat tabs (bundled binary) and Claude Code terminal tabs (PATH claude,
# the same bundled binary here) both read this config.
#
# With EVIDENCE_SANDBOX_USER set (CI), the server, and so every agent and
# shell tab it spawns, runs as that unprivileged user with no sudo. That
# user can't read /proc/<pid>/environ of run.mjs (which holds the key) or
# the runner's memory. The checkout is bind-mounted at /srv/evidence/<dir>
# because $GITHUB_WORKSPACE sits under a home directory it can't traverse,
# and the fixture lives in /tmp, owned by that user. Unset (local runs), the
# server runs as you.

set -euo pipefail

CHECKOUT="$(cd "$1" && pwd)"
PORT="$2"
LABEL="$3"
SANDBOX_USER="${EVIDENCE_SANDBOX_USER:-}"
OUTSIDE="${RUNNER_TEMP:-/tmp}"
LOG="$OUTSIDE/evidence-$LABEL.log"

if [ -n "$SANDBOX_USER" ]; then
  id "$SANDBOX_USER" >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash "$SANDBOX_USER"
  APP="/srv/evidence/$(basename "$CHECKOUT")"
  sudo mkdir -p "$APP"
  mountpoint -q "$APP" || sudo mount --bind "$CHECKOUT" "$APP"
  TMP="/tmp/evidence-$LABEL"
  sudo rm -rf "$TMP"
  RUN_AS=(sudo -u "$SANDBOX_USER" --)
else
  APP="$CHECKOUT"
  TMP="$OUTSIDE/evidence-$LABEL"
  rm -rf "$TMP"
  RUN_AS=()
fi
mkdir -p "$TMP"

FIXTURE="$TMP/acme-app"
DATA_DIR="$TMP/data"
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

SERVER_HOME="$TMP/home"
mkdir -p "$SERVER_HOME/.claude"
MODEL="${EVIDENCE_AGENT_MODEL:-anthropic/claude-haiku-5.5}"
jq -n --arg port "${EVIDENCE_AGENT_PROXY_PORT:-37700}" --arg model "$MODEL" '{
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:\($port)",
      ANTHROPIC_AUTH_TOKEN: "evidence-proxy",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: $model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: $model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: $model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: $model,
      ANTHROPIC_SMALL_FAST_MODEL: $model,
      CLAUDE_CODE_SUBAGENT_MODEL: $model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1"
    }
  }' > "$SERVER_HOME/.claude/settings.json"
# Skip Claude Code's first-run theme picker and folder-trust prompt, which
# would otherwise be the first thing every terminal tab shows.
jq -n --args '{
  hasCompletedOnboarding: true,
  projects: ($ARGS.positional | map({key: ., value: {hasTrustDialogAccepted: true}}) | from_entries)
}' "$(cd "$FIXTURE" && pwd -P)" "$(cd "$TMP/acme-app-login" && pwd -P)" "$(cd "$TMP/acme-app-typo" && pwd -P)" \
  > "$SERVER_HOME/.claude.json"

if [ -n "$SANDBOX_USER" ]; then
  sudo chown -R "$SANDBOX_USER:" "$TMP"
  sudo chmod 700 "$TMP"
fi

# Keep the server off the real GitHub API: the fixture has no remote, and
# a token in env would make PR polling hit api.github.com for nothing.
# Inherited CLAUDE*/ANTHROPIC* vars (e.g. when run from inside a Claude Code
# session) would override settings.json or mark agents as child sessions.
# The log is opened by this shell, so it stays readable outside the sandbox.
UNSET=(-u GITHUB_TOKEN -u GH_TOKEN -u OPENROUTER_API_KEY)
for v in $(compgen -e | grep -E '^(CLAUDE|ANTHROPIC)'); do UNSET+=(-u "$v"); done
${RUN_AS[@]+"${RUN_AS[@]}"} env "${UNSET[@]}" \
  HOME="$SERVER_HOME" \
  PATH="$APP/node_modules/.bin:$PATH" \
  HARNESS_DATA_DIR="$DATA_DIR" \
  HARNESS_AUTH_TOKEN="$TOKEN" \
  node "$APP/dist-headless/main/index.js" --port "$PORT" --host 127.0.0.1 \
  > "$LOG" 2>&1 &
echo $! > "$OUTSIDE/evidence-$LABEL.pid"

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
