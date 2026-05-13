# ha-claude-acp

Home Assistant integration that lets the Assist pipeline talk to Claude via the
[Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol),
backed by a small TypeScript gateway service that spawns `claude` subprocesses
and routes tool calls through [ha-mcp](https://github.com/voska/hass-mcp).

## Status

V1 in progress. The acceptance criteria are tracked in `docs/ARCHITECTURE.md`.

Current state: repo skeleton only. The service exposes `GET /healthz`. Nothing
else is wired up yet.

## Components

- `custom_components/claude_acp/` — Home Assistant integration (Python).
  Registers a `ConversationEntity` named "Claude Agent (ACP)".
- `service/` — TypeScript gateway. Owns ACP sessions, talks to Anthropic via
  the `@anthropic-ai/claude-code` runtime, streams SSE back to HA.

## Quickstart (service, local dev)

```bash
cd service
cp ../.env.example .env   # then edit
npm install
npm run dev               # tsx watch on PORT (default 8765)
curl http://localhost:8765/healthz
```

Requires Node.js >= 24.

## License

MIT — see [LICENSE](./LICENSE).
