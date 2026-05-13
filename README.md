# ha-claude-acp

Home Assistant integration that lets the Assist pipeline talk to Claude via the
[Agent Client Protocol](https://agentclientprotocol.com/), backed by a small
TypeScript gateway service that spawns
[`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
subprocesses (the ACP adapter for the official Claude Agent SDK) and routes
tool calls through MCP servers configured per persona.

## Status

V1 service is functionally complete and smoke-tested end-to-end against a
real Claude account. The Home Assistant integration code is wired but not
yet exercised against a running HA instance — that's the remaining V1
verification step.

V1 acceptance criteria (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for full text):

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `/healthz` returns 200 unauthenticated | ✅ verified |
| 2 | `/v1/converse` returns a complete SSE stream terminated by `done` | ✅ verified |
| 3 | Integration appears in HA *Add Integration* menu and supports multiple entries | ⏳ pending HA install |
| 4 | Claude conversation entity is selectable in an Assist pipeline | ⏳ pending HA install |
| 5 | Voice round-trip under 5 s on the LAN | ✅ verified (2.5–2.8 s end-to-end) |
| 6 | Spoken tool action executes via the persona's MCP | ⏳ pending HA install + MCP |
| 7 | Long responses stream incrementally to TTS | ✅ verified (60+ char chunking with sentence alignment) |
| 8 | Unreachable deployment surfaces a clean error in HA | ⏳ pending HA install |
| 9 | Restarting a deployment spawns a fresh session transparently | ✅ verified (pool purges dead entries on subprocess exit) |

Service-side end-to-end smoke confirmed multi-turn memory via session-pool
reuse: a second prompt on the same `conversation_id` skipped the ACP
handshake and Claude recalled the earlier turn.

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
that operates this service), not to this repo. Copy-and-edit templates
live under [`examples/personas/`](examples/personas/).

See `docs/ARCHITECTURE.md` for the full rationale and the thin/thick service
boundary.

## Quickstart (service, local dev)

```bash
cd service
cp ../.env.example .env       # then edit — CLAUDE_CODE_OAUTH_TOKEN at minimum
mkdir -p /tmp/test-persona    # empty persona dir is valid (adapter defaults)
npm install
npm run dev                   # tsx watch; .env is auto-loaded
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token` on a machine that
has the Claude CLI installed. `BEARER_TOKEN` can be anything — `openssl rand
-hex 32` is fine.

Smoke test from another shell:

```bash
curl -i http://localhost:8765/healthz

source service/.env && curl -N -X POST http://localhost:8765/v1/converse \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"smoke","messages":[{"role":"user","content":"Say hello in five words"}]}'
```

You should see `event: text` frames carrying the reply followed by
`event: done`. Requires Node.js >= 24.

## License

MIT — see [LICENSE](./LICENSE).
