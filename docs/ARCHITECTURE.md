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
                                          claude-agent-acp  (ACP adapter)
                                                              │  uses
                                                              ▼
                                              @anthropic-ai/claude-agent-sdk
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

## Persona = a Claude Code $HOME

A persona's configuration is **whatever `claude-agent-acp` reads from its
`$HOME` directory on startup**. The service does not define or parse its own
schema — it just spawns the subprocess with `HOME` pointed at the mounted
persona directory.

That directory is Claude Code's native config root, identical in layout to
what a developer would maintain locally. A typical persona looks like:

```
persona/
└── .claude/
    ├── CLAUDE.md         # system prompt (Claude Code convention)
    ├── settings.json     # model, mcpServers, permissions
    └── (skills/, plugins/, hooks/ — all native Claude Code files)
```

An empty persona directory is valid — the adapter falls back to defaults
(model "default" = Sonnet 4.6, permission mode "default", no MCP servers).
New personas are created by copying an existing directory, editing the
files inside, and starting a new deployment; no service code change.

The persona directory is mounted read-only. The adapter does not write to
`HOME` during normal operation; OAuth is passed via env, not cached on disk
(see [Authentication](#authentication)).

Real persona content lives in the **deployment repo** (e.g. `klh-homelab`),
not in this repo. Copy-and-edit templates live under
[`examples/personas/`](../examples/personas/) — a `minimal/` for first-boot
smoke testing and a `voice-assistant/` tuned for the HA voice pipeline.

### Authentication

`CLAUDE_CODE_OAUTH_TOKEN` is read directly from the subprocess environment
by `@anthropic-ai/claude-agent-sdk`. No `claude auth login` ceremony is
needed inside the container and the persona dir does not need to be writable
for credential caching. One Anthropic account's token can be reused across
all persona deployments.

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
- **ACP event classification.** Forward `agent_message_chunk` text (skipping
  empty leading chunks) to the SSE stream. Drop the following silently
  unless `LOG_LEVEL=debug`: `available_commands_update` (large, fires once
  per session), `usage_update` (token / cost telemetry — V2 may surface),
  `agent_thought_chunk`, `user_message_chunk` (echoes our own prompt),
  `current_mode_update`, `config_option_update`, `session_info_update`,
  `plan`. Log `tool_call` / `tool_call_update` at info level — essential for
  debugging voice failures — but do not forward them.
- **Session mode = `bypassPermissions`.** Immediately after `newSession`,
  call `setSessionMode({ modeId: "bypassPermissions" })`. The adapter
  natively supports this mode and skips all permission prompts. Tool access
  is gated by the persona's `settings.json` (Claude Code's `permissions`
  block + the MCP server list) — not by ACP-level filtering, not by
  service-side denylists.
- **`requestPermission` auto-allow as defense-in-depth.** Under
  `bypassPermissions` the adapter shouldn't call `requestPermission`, but
  the service still implements the `Client` method: auto-select the first
  `allow_*` option and log a warning so any actual prompt surfaces in logs.
- **Session pool.** Key by `conversation_id`. Idle TTL 30 min. Hard cap 8
  concurrent. Stall detection: if no event for N seconds during an active
  request, kill the subprocess and surface a clean error to HA.
- **HA-friendly errors.** Subprocess crash, ACP protocol error, or timeout
  must return text the TTS engine can speak — not let HA hang on the SSE
  connection.
- **Bearer auth** on `/v1/converse`. `/healthz` stays open.
- **Subprocess hygiene.** Spawn with a clean `env: { HOME: PERSONA_DIR,
  PATH: ..., USER: ..., CLAUDE_CODE_OAUTH_TOKEN: ... }`. No other env is
  inherited unless explicitly listed. In particular `BEARER_TOKEN`,
  unrelated host env, and the service's own log config never reach the
  child.
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

The service forwards only `agent_message_chunk` events whose `content.type`
is `text` and whose `text` is non-empty. The first chunk of a response is
often `text: ""` (adapter convention) and must be skipped. All other ACP
update kinds are dropped from the SSE stream (see [Service
responsibilities](#service-responsibilities) for the per-kind handling).

The SSE stream is terminated by an explicit `done` event so HA knows the
response ended cleanly (not a timeout). On error the service emits a
single `error` event with a TTS-friendly message, then closes the stream.

### Spawn / handshake order

```
spawn claude-agent-acp (cwd = HOME, env_clear + allowlist)
  → initialize({ protocolVersion: 1, clientCapabilities: { fs: {} },
                 clientInfo: { name, version } })
  → newSession({ cwd: HOME, mcpServers: [] })
  → setSessionMode({ sessionId, modeId: "bypassPermissions" })
  → [per HA request] prompt({ sessionId, prompt: [{ type: "text", text }] })
       └─ sessionUpdate notifications fan out (filter → SSE)
       └─ prompt resolves with stopReason → emit `done`
```

`mcpServers: []` in `newSession` is intentional — MCP configuration comes
from the persona's `settings.json`, not from the wire request.

### Token economics

The adapter loads a baseline set of built-in slash commands (~16 K cached
tokens on the first turn of a session, regardless of HOME contents). These
tokens enter Anthropic's prompt cache and subsequent turns in the same
session reuse them at the 90 % cached-read discount. The session pool's
long idle TTL exists partly to amortize this cost.

## Session pool

Keyed by `conversation_id`. Each session holds one spawned
`claude-agent-acp` subprocess and its ACP connection.

- Lazy creation on first request for a `conversation_id`.
- Idle TTL: 30 min.
- Concurrency cap: 8 (configurable via `MAX_CONCURRENT_SESSIONS`). When the
  cap is reached, the oldest idle session is evicted; if none are idle the
  new request returns a 503.
- On subprocess exit or stall, the entry is purged so the next request opens
  a fresh subprocess.

## V1 acceptance criteria

Status legend: ✅ verified end-to-end · ⏳ pending HA install.

1. ✅ `GET /healthz` returns `200 {"status":"ok"}` (no auth required).
2. ✅ `POST /v1/converse` with valid bearer returns a complete SSE stream of
   text deltas terminated by a `done` event.
3. ⏳ Integration appears in the HA "Add Integration" menu and supports adding
   multiple entries (one per persona).
4. ⏳ Each Claude conversation entity is selectable in an Assist pipeline.
5. ✅ Voice → response round-trip stays under 5 seconds on the LAN.
   *(Service-side smoke test: 2.5 s for the first turn including spawn +
   handshake, 2.8 s for the second turn using the pool.)*
6. ⏳ A spoken tool action (e.g. "turn on the kitchen light") executes via
   the persona's MCP configuration and Claude reads back a confirmation.
7. ✅ Long responses stream incrementally — TTS receives chunks at clean
   punctuation or ≥60-char boundaries.
8. ⏳ If a deployment is unreachable, HA reports a clean error rather than
   crashing or hanging.
9. ✅ Restarting a deployment drops its in-flight sessions and the next request
   opens a fresh one transparently. *(Pool detects subprocess exit via
   `AcpSession.closed` and purges; next acquire spawns fresh.)*

## What this service is NOT

- Not an agent framework. No memory, no RAG, no tool registry, no persona
  switching at runtime.
- **Not Claude Code's config layer.** The persona directory IS Claude Code's
  native config root. The service does not parse, validate, or translate
  it — the adapter reads its own files.
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
