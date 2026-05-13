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

RUN npm install -g @anthropic-ai/claude-code

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN useradd --system --create-home --shell /usr/sbin/nologin app \
 && chown -R app:app /app
USER app

ENV PORT=8765
ENV PERSONA_DIR=/config/persona
EXPOSE 8765

# Persona dir is expected to be mounted by the operator (read-only is fine).
# See docs/ARCHITECTURE.md and examples/personas/ for the layout.
VOLUME ["/config/persona"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "dist/index.js"]
