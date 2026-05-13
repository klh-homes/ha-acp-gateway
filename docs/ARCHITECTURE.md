# Architecture (V1)

A Home Assistant integration that exposes Claude as a `ConversationEntity` for
the Assist pipeline, backed by a TypeScript gateway that owns ACP sessions.

```
Voice → STT → Assist pipeline → conversation.claude_acp
                                       │
                                       │  HTTPS + SSE (Bearer auth)
                                       ▼
                              service (Node.js + Hono)
                                       │
                                       │  ACP stdio JSON-RPC
                                       ▼
                       claude (@anthropic-ai/claude-code)
                                       │
                                       ▼
                              Anthropic API (OAuth)

Tool calls from claude → MCP → ha-mcp → Home Assistant REST
```

## V1 acceptance criteria

1. `GET /healthz` returns `200 {"status":"ok"}` (no auth required).
2. `POST /v1/converse` with valid bearer returns a complete SSE stream of text
   deltas terminated by a `done` event.
3. Integration appears in the HA "Add Integration" menu.
4. The Claude conversation entity is selectable in the Assist pipeline.
5. Voice → response round-trip stays under 5 seconds on the LAN.
6. A spoken tool action (e.g. "turn on the kitchen light") executes via ha-mcp
   and Claude reads back a confirmation.
7. Long responses stream incrementally — TTS receives chunks every >=60 chars.
8. If the service is unreachable, HA reports a clean error rather than crashing.
9. Restarting the service drops in-flight sessions and the next request opens a
   fresh one transparently.

## Stream filtering

The service forwards only ACP `agent_message_chunk` events with text content as
SSE `text` events. `thinking`, `tool_use`, `tool_result`, `plan`, and `status`
events are observed for logging but not relayed to HA.

## Session pool

Sessions are keyed by `conversation_id`. Each session spawns one `claude`
subprocess. Idle TTL = 30 minutes. Hard cap = 8 concurrent sessions.

## Out of scope for V1

- `AITaskEntity` for structured generation
- HA LLM API tool routing (only ha-mcp for now)
- On-disk session persistence across restarts
- Per-area personas
- Custom wake-word training
