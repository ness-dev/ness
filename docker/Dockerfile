# A `harness-server` (Ness remote backend) running in a container, for
# local development of remote/multi-backend features.
#
# This builds the headless server from the working tree rather than
# installing a released tarball, so the loop is: edit code on the host,
# `npm run remote:up`, reconnect. To test the *shipping* artifact instead,
# run `npm run pack:headless` inside the container (see CONTRIBUTING).
#
# Debian (glibc) base on purpose: json-claude-manager picks the
# `-musl` platform package when it can't find a glibc runtime version,
# and we want the same binary a real Linux remote would run.
FROM node:22-bookworm-slim

# zsh is load-bearing, not a convenience: PtyManager spawns terminals as
# `zsh -ilc <cmd>`. python3/make/g++ are node-pty's build toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      g++ \
      git \
      less \
      make \
      procps \
      python3 \
      ripgrep \
      zsh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer, keyed on the lockfile so source edits don't re-resolve.
#
# --ignore-scripts skips the `electron-builder install-app-deps` postinstall,
# which would download Electron (~100MB we never run) and rebuild node-pty
# against Electron's ABI — wrong for a plain-Node server. node-pty is then
# built explicitly against this image's Node. --legacy-peer-deps matches the
# host install (electron-vite@5's peer range vs the installed vite).
#
# Two things --ignore-scripts skips that we do have to run by hand:
#   - node-pty's build, against this image's Node rather than Electron's.
#   - claude-code's install.cjs. The platform binary that Chat tabs exec
#     directly works without it, but the wrapper's bin/claude.exe launcher
#     refuses to run until it has been set up — which is the `claude` that
#     terminal tabs get off PATH. It needs no network.
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts \
    && npm rebuild node-pty --build-from-source \
    && node node_modules/@anthropic-ai/claude-code/install.cjs

COPY . .

RUN npm run build:headless

# `claude` and `codex` on PATH for terminal tabs, pointed at the same
# versions package.json pins for Chat tabs — no second global install to
# drift out of sync.
ENV PATH="/app/node_modules/.bin:${PATH}"

# Fail the build rather than the first agent session. The CLIs were once
# broken by an install-script flag; the MCP scripts by a .dockerignore
# entry, which left Chat tabs pointing --permission-prompt-tool at nothing.
RUN claude --version && codex --version \
    && test -f dist-headless/mcp/permission-prompt-mcp.js \
    && test -f dist-headless/mcp/mcp-bridge.js

# Config + the persisted auth token live here; the sample workspace and
# its worktrees live in /workspace. Both are volumes in compose.yaml so
# auth and repo state survive a rebuild.
ENV HARNESS_DATA_DIR=/data
ENV NESS_WORKSPACE=/workspace

EXPOSE 37291

# Belt-and-braces: COPY preserves the mode, but a checkout that lost the
# exec bit would otherwise fail at `docker run` rather than at build.
RUN chmod +x /app/docker/entrypoint.sh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
