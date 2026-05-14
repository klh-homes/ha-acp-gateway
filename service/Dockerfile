# syntax=docker/dockerfile:1.7

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ACP adapter wrappers — small npm packages that expose the agent runtimes
# over ACP via a stdio binary on PATH. The service picks one to spawn per
# request based on ACP_AGENT (see config.ts). The underlying CLI itself
# (claude-code / codex) is NOT installed here — the persona Dockerfile
# layers in whichever runtime its agent needs.
#
#   claude → claude-agent-acp wraps @anthropic-ai/claude-agent-sdk
#   codex  → acp-server (from @agentclientprotocol/codex-acp) wraps codex CLI
RUN npm install -g \
      @agentclientprotocol/claude-agent-acp \
      @agentclientprotocol/codex-acp

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as the node:24 base image's built-in `node` user (UID 1000). PERSONA_DIR
# overlaps with $HOME so the spawned agent subprocess and any operator-side
# entrypoint helpers share one home dir.
RUN chown -R node:node /app
USER node

ENV PORT=8765
ENV PERSONA_DIR=/home/node
EXPOSE 8765

# Persona dir is expected to be a named volume on /home/node when running
# in compose / k8s. See docs/ARCHITECTURE.md and examples/personas/ for
# the layout + the bake-and-reseed pattern that keeps image updates from
# being masked by stale volume content.
VOLUME ["/home/node"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "dist/index.js"]
