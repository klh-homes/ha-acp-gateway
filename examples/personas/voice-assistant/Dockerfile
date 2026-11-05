# syntax=docker/dockerfile:1
#
# Overlay Dockerfile for a Claude-based voice-assistant persona.
#
# Layers persona content (CLAUDE.md, .claude/settings.json, optional skill
# bundles) and an entrypoint wrapper on top of the upstream ha-acp-gateway
# image. The wrapper:
#   - reseeds image-baked CLAUDE.md + settings.json into PERSONA_DIR on
#     every start (named-volume-masking escape)
#   - rsyncs baked skill bundles into $PERSONA_DIR/.claude/skills/
#   - registers MCP servers via `claude mcp add` so the spawned ACP
#     subprocess picks them up out of $PERSONA_DIR/.claude.json
#
# This example targets ACP_AGENT=claude. For a codex-based persona, use a
# different bake layout under $HOME/.codex/ and skip the claude-code CLI
# install below.
#
# Build context = this directory. Pin the upstream tag explicitly — do not
# use `:latest`, which moves under you when a new image is published.
#
# Operator workflow:
#   1. Copy examples/personas/voice-assistant/ to <deploy-repo>/personas/<name>/
#   2. Edit CLAUDE.md + .claude/settings.json
#   3. Optionally vendor skill packs and add COPY lines below the placeholder
#   4. Reference this Dockerfile from your compose service block

ARG HA_ACP_GATEWAY_VERSION=0.2.1

FROM ghcr.io/klh-homes/ha-acp-gateway:${HA_ACP_GATEWAY_VERSION}

USER root

# Toolkit added on top of the upstream image:
#   tini  — clean PID 1 + signal forwarding (the upstream image has none)
#   rsync — used by lib/install-skills.sh
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini rsync \
 && rm -rf /var/lib/apt/lists/*

# claude-code CLI — used at container start by lib/setup-mcp.sh to register
# MCP servers via `claude mcp add`, which writes to $HOME/.claude.json
# where the spawned claude-agent-acp subprocess reads them back.
RUN npm install -g @anthropic-ai/claude-code --retry 3 \
 && npm cache clean --force

# Persona bake — CLAUDE.md + .claude/settings.json land OUTSIDE the named
# volume that compose will mount at $PERSONA_DIR. lib/install-config.sh
# reseeds them on every container start so image updates always win.
COPY --chown=node:node CLAUDE.md /opt/persona-bake/CLAUDE.md
COPY --chown=node:node .claude /opt/persona-bake/.claude

# Skills bake — each subdirectory of /opt/skills-bake/ is rsynced into
# $PERSONA_DIR/.claude/skills/<basename>/ by lib/install-skills.sh on
# every start. Per-skill COPY so editing one skill doesn't bust the
# layer cache for unrelated skills.
#
# To bake skills, uncomment and adapt the lines below. The path on the
# left is in your build context (this directory + relative path); the
# path on the right is in the image.
#
# COPY --chown=node:node skills/home-assistant-best-practices \
#      /opt/skills-bake/home-assistant-best-practices
#
# COPY --chown=node:node skills/claude-skill-homeassistant \
#      /opt/skills-bake/claude-skill-homeassistant

RUN mkdir -p /opt/skills-bake \
 && chown -R node:node /opt/persona-bake /opt/skills-bake

# Entrypoint wrapper + lib helpers
COPY --chown=node:node lib/ /usr/local/bin/persona-entrypoint/lib/
COPY --chown=node:node entrypoint.sh /usr/local/bin/persona-entrypoint/entrypoint.sh
RUN chmod +x /usr/local/bin/persona-entrypoint/entrypoint.sh \
 && chmod +x /usr/local/bin/persona-entrypoint/lib/*.sh

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/persona-entrypoint/entrypoint.sh"]
CMD ["node", "dist/index.js"]
