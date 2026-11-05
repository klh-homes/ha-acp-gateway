# ha-acp-gateway

Home Assistant integration that lets the Assist pipeline talk to an
ACP-speaking coding agent — [Claude
Code](https://github.com/agentclientprotocol/claude-agent-acp), [OpenAI
Codex](https://github.com/agentclientprotocol/codex-acp), and any other
agent that ships an [Agent Client
Protocol](https://agentclientprotocol.com/) adapter. The integration sits
in front of a small TypeScript gateway service that owns the ACP session
and streams tokens back to HA as SSE.

## Status

Multi-agent core (Claude + Codex) is in v0.2. The Claude path is the
production-tested one (used as the Jarvis voice persona in `klh-homelab`);
the Codex adapter is wired and compiles cleanly but its end-to-end
voice-pipeline ergonomics are still field-testing.

Acceptance criteria for the core (Claude path; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full text):

| #   | Criterion                                                                      | Status          |
| --- | ------------------------------------------------------------------------------ | --------------- |
| 1   | `/healthz` returns 200 unauthenticated with the active agent id                | ✅              |
| 2   | `/v1/converse` returns a complete SSE stream terminated by `done`              | ✅              |
| 3   | Integration appears in HA _Add Integration_ menu and supports multiple entries | ✅              |
| 4   | Conversation entity is selectable in an Assist pipeline                        | ✅              |
| 5   | Voice round-trip under 5 s on the LAN                                          | ✅ (≈ 3 s warm) |
| 6   | Spoken tool action executes via the persona's MCP                              | ✅              |
| 7   | Long responses stream incrementally to TTS                                     | ✅              |
| 8   | Unreachable deployment surfaces a clean error in HA                            | ✅              |
| 9   | Restarting a deployment spawns a fresh session transparently                   | ✅              |

## Components

- `custom_components/acp_gateway/` — Home Assistant integration (Python).
  Registers one `ConversationEntity` per config entry. Add the integration
  multiple times — once per persona deployment.
- `service/` — TypeScript gateway. Owns ACP sessions, spawns the selected
  agent's ACP wrapper, filters ACP events, streams SSE back to HA.

## Picking an agent

Set `ACP_AGENT` per deployment:

| `ACP_AGENT`        | Auth env vars                                                          | Spawned binary     |
| ------------------ | ---------------------------------------------------------------------- | ------------------ |
| `claude` (default) | `CLAUDE_CODE_OAUTH_TOKEN`                                              | `claude-agent-acp` |
| `codex`            | `OPENAI_API_KEY` (or pre-`codex login` in HOME); optional `CODEX_PATH` | `codex-acp`        |

Each persona deployment is one agent. To run Jarvis on Claude and
Friday on Codex, run two separate service containers with their own
persona dirs and `ACP_AGENT` values.

To add a new agent (Gemini CLI, Kiro, OpenCode, …): write
`service/src/agents/<name>.ts` exporting a `create<Name>Launcher`, widen
the `AgentId` union in `agents/types.ts`, and add a `case` in
`agents/index.ts`. The pool / SSE / HA-side code is agent-agnostic.

## Deployment model

One persona = one deployment of `service/`. A persona is defined by a
directory mounted at `PERSONA_DIR` containing the agent's native config —
`$HOME/.claude/` for Claude, `$HOME/.codex/` for Codex. To add a new
persona, spin up another deployment with a different persona directory and
bearer token, then add a second integration entry in Home Assistant
pointing at it.

Real persona directories belong to the deployment repository (the homelab
that operates this service), not to this repo. Copy-and-edit templates
live under [`examples/personas/`](examples/personas/).

See `docs/ARCHITECTURE.md` for the full rationale and the thin/thick
service boundary.

## Quickstart (service, local dev)

```bash
cd service
cp ../.env.example .env       # then edit — set ACP_AGENT + matching auth
mkdir -p /tmp/test-persona    # empty persona dir is valid (agent defaults)
npm install
npm run dev                   # tsx watch; .env is auto-loaded
```

For Claude: `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token` on a
machine that has the Claude CLI installed. For Codex: an `OPENAI_API_KEY`
works, or set up `codex login` and bind-mount the credentials dir as
PERSONA_DIR. `BEARER_TOKEN` can be anything — `openssl rand -hex 32` is
fine.

Smoke test from another shell:

```bash
curl -i http://localhost:8765/healthz
# → {"status":"ok","agent":"claude"}

source service/.env && curl -N -X POST http://localhost:8765/v1/converse \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"smoke","messages":[{"role":"user","content":"Say hello in five words"}]}'
```

You should see `event: text` frames carrying the reply followed by
`event: done`. Requires Node.js >= 26.

## License

MIT — see [LICENSE](./LICENSE).
