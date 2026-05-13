# ha-claude-acp

Home Assistant integration that lets the Assist pipeline talk to Claude via the
[Agent Client Protocol](https://agentclientprotocol.com/), backed by a small
TypeScript gateway service that spawns
[`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
subprocesses (the ACP adapter for the official Claude Agent SDK) and routes
tool calls through MCP servers configured per persona.

## Status

V1 in progress. Acceptance criteria are tracked in `docs/ARCHITECTURE.md`.

Current state: repo skeleton only. The service exposes `GET /healthz`. Nothing
else is wired up yet.

## Components

- `custom_components/claude_acp/` — Home Assistant integration (Python).
  Registers one `ConversationEntity` per config entry. Add the integration
  multiple times — once per persona deployment.
- `service/` — TypeScript gateway. Owns ACP sessions, spawns
  `claude-agent-acp` (the adapter for `@anthropic-ai/claude-agent-sdk`),
  filters ACP events, streams SSE back to HA.

## Deployment model

One persona = one deployment of `service/`. A persona is defined by a
directory mounted at `PERSONA_DIR` containing `system_prompt.md`,
`mcp_servers.json`, and `settings.json`. To add a new persona, spin up another
deployment with a different persona directory and bearer token, then add a
second integration entry in Home Assistant pointing at it.

Real persona directories belong to the deployment repository (the homelab
that operates this service), not to this repo. This repo will ship
`examples/personas/` as templates once V1's `/v1/converse` lands.

See `docs/ARCHITECTURE.md` for the full rationale and the thin/thick service
boundary.

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
