# Architecture (V1)

A Home Assistant integration that exposes Claude as one or more
`ConversationEntity` instances for the Assist pipeline, backed by a TypeScript
gateway service that owns ACP sessions and forwards them as SSE.

```
Wake word "Hey Jarvis" → Assist pipeline "Jarvis" → ConversationEntity "Jarvis (ACP)"
                                                              │
                                                              │  HTTPS + SSE (Bearer)
                                                              ▼
                                                  claude-acp-jarvis  (service)
                                                              │
                                                              │  ACP stdio JSON-RPC
                                                              ▼
                                                  claude  (@anthropic-ai/claude-code)
                                                              │
                                                              │  MCP (configured in persona dir)
                                                              ▼
                                                  ha-mcp → Home Assistant REST
```

## Deployment model: one persona, one deployment

A **persona** is a self-contained agent identity: its own system prompt, its
own MCP server allowlist, optionally its own skills, optionally its own model
selection. In V1 each persona is a separate deployment of this service. A
homelab with three wake words ("Hey Jarvis" / "Hey Friday" / "Hey Kid") runs
three deployments.

Why per-deployment, not per-request:

- The service stays simple — no catalog endpoint, no per-request init-param
  shuffling, no `(conversation_id, profile_hash)` session keys.
- Personas can be hard-isolated: separate bearer token, separate container,
  separate resource limits, separate Claude Code config dir.
- New persona = `cp -r` an existing persona dir, edit, add a compose service.
  No code change to this repo.
- Per-deployment matches how Claude Code itself thinks about config (one home
  dir per process).

The cost is N container processes' baseline memory. For a homelab with
3–5 personas, this is well under 1 GB and acceptable.

## Persona configuration

Each deployment mounts a **persona directory** at the path given by
`PERSONA_DIR` (default `/config/persona`). The service reads it on startup
and forwards relevant fields into the ACP `initialize` call.

V1 persona dir layout:

```
persona/
├── system_prompt.md        # raw text → ACP customSystemPrompt
├── mcp_servers.json        # full MCP server config → ACP mcpServers
└── settings.json           # model, max_tokens default, tool restrictions
```

The actual persona content lives in the **deployment repo** (for example
`klh-homelab`), not in this repo. This repo only ships `examples/personas/` as
copy-and-edit templates. Treat persona dirs as deployment data, not source
code.

V2 may add `skills/*.md` discovered from the persona dir; deferred.

## Service responsibilities

The service is intentionally thin about agent behavior, thick about transport.

**Thin about (do not reinvent — let Claude / Anthropic API handle):**

- Conversation memory beyond a single ACP session.
- Multi-agent orchestration, persona switching, A2A.
- Tool registration or schema. MCP servers declare their own tools; the
  service does not curate or filter them at the protocol layer.
- Anything platform-agnostic that Claude Code already does (skills loading,
  CLAUDE.md, model fallback).

**Thick about (must do well, voice UX depends on it):**

- **SSE streaming with TTS-friendly chunking.** Forward
  `agent_message_chunk.text` deltas to HA, but emit chunk boundaries at
  punctuation or every ≥60 chars so the TTS engine has clean splits.
- **ACP event classification.** Pass `agent_message_chunk` text through; log
  but drop `thinking`, `plan`, `status`; log `tool_use` / `tool_result` at
  info level (essential for debugging) without forwarding to HA.
- **Tool permission auto-reply.** Voice cannot pop a confirmation dialog. All
  `session/request_permission` requests from the ACP subprocess are
  auto-approved and logged. (V2 may add an allowlist filter; V1 trusts the
  persona's MCP configuration as the access control surface.)
- **Session pool.** Key by `conversation_id`. Idle TTL 30 min. Hard cap 8
  concurrent. Stall detection: if no event for N seconds during an active
  request, kill the subprocess and surface a clean error to HA.
- **HA-friendly errors.** Subprocess crash, ACP protocol error, or timeout
  must return text the TTS engine can speak — not let HA hang on the SSE
  connection.
- **Bearer auth** on `/v1/converse`. `/healthz` stays open.
- **Subprocess hygiene.** Spawn with `env: {}` plus an explicit allowlist
  (`HOME`, `PATH`, `USER`, plus persona-specific overrides). Never leak the
  service's own env (especially `BEARER_TOKEN`, OAuth token) into the child.
- **Structured logging.** All log lines include `conversation_id` once
  established, so per-conversation traces can be grepped out.

## Home Assistant integration

The Python `custom_components/claude_acp` registers one `ConversationEntity`
per config entry. The config_flow supports adding multiple entries — one per
persona. Each entry points to one deployment.

Config entry fields:

- `name` — display name (e.g. "Jarvis"), used as entity friendly name.
- `gateway_url` — base URL of one deployment.
- `bearer_token` — matching deployment's token.
- `max_tokens` — response budget (default 300).
- `request_timeout_s` — per-request timeout (default 30 s).

Model, system prompt, and MCP configuration are **not** in the integration —
they belong to the deployment.

Wake-word routing happens in HA itself: each wake word maps to an Assist
pipeline, each pipeline points at one Claude conversation entity. Different
wake words → different pipelines → different entities → different deployments.

## Stream filtering

The service forwards only `agent_message_chunk` events whose payload is text.
Other ACP event types are dropped from the SSE stream but logged. The SSE
stream is terminated by an explicit `done` event so HA knows the response
ended cleanly (not a timeout).

## Session pool

Keyed by `conversation_id`. Each session holds one spawned `claude`
subprocess and its ACP connection.

- Lazy creation on first request for a `conversation_id`.
- Idle TTL: 30 min.
- Concurrency cap: 8 (configurable via `MAX_CONCURRENT_SESSIONS`). When the
  cap is reached, the oldest idle session is evicted; if none are idle the
  new request returns a 503.
- On subprocess exit or stall, the entry is purged so the next request opens
  a fresh subprocess.

## V1 acceptance criteria

1. `GET /healthz` returns `200 {"status":"ok"}` (no auth required).
2. `POST /v1/converse` with valid bearer returns a complete SSE stream of
   text deltas terminated by a `done` event.
3. Integration appears in the HA "Add Integration" menu and supports adding
   multiple entries (one per persona).
4. Each Claude conversation entity is selectable in an Assist pipeline.
5. Voice → response round-trip stays under 5 seconds on the LAN.
6. A spoken tool action (e.g. "turn on the kitchen light") executes via the
   persona's MCP configuration and Claude reads back a confirmation.
7. Long responses stream incrementally — TTS receives chunks at clean
   punctuation or ≥60-char boundaries.
8. If a deployment is unreachable, HA reports a clean error rather than
   crashing or hanging.
9. Restarting a deployment drops its in-flight sessions and the next request
   opens a fresh one transparently.

## What this service is NOT

- Not an agent framework. No memory, no RAG, no tool registry, no persona
  switching at runtime.
- Not a generic gateway. It speaks ACP on one side and HA's SSE delta format
  on the other, on purpose.
- Not opinionated about deployment topology beyond "one container per
  persona". Bring your own compose / Helm / nomad / systemd unit.

## Out of scope for V1

- `AITaskEntity` for structured generation.
- Persona switching from a single deployment (would need catalog endpoint
  and per-request init params).
- Skills discovery from persona dir.
- HA LLM API tool routing (only the persona's MCP servers in V1).
- On-disk session persistence across service restart.
- Per-area personas decoupled from wake word.
- Custom wake-word training.
