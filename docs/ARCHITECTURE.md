# Architecture

A Home Assistant integration that exposes an ACP-speaking coding agent as
one or more `ConversationEntity` instances for the Assist pipeline, backed
by a TypeScript gateway service that owns ACP sessions and forwards them
as SSE.

```
Wake word "Hey Jarvis" → Assist pipeline "Jarvis" → ConversationEntity "Jarvis (ACP Gateway)"
                                                              │
                                                              │  HTTPS + SSE (Bearer)
                                                              ▼
                                                  acp-gateway-jarvis  (service)
                                                              │
                                                              │  ACP stdio JSON-RPC
                                                              ▼
                            claude-agent-acp │ codex-acp │ …   (selected by ACP_AGENT)
                                                              │  uses
                                                              ▼
                  @anthropic-ai/claude-agent-sdk │ codex CLI │ …
                                                              │
                                                              │  MCP (configured in persona dir)
                                                              ▼
                                                  ha-mcp → Home Assistant REST
```

## Multi-agent

The gateway is agent-agnostic at the protocol layer — every supported
agent speaks ACP, and ACP is the only interface the service knows. The
choice of agent runtime is a per-deployment env var (`ACP_AGENT`) and a
matching auth env var; the session pool, SSE framing, HA integration code
all stay identical.

| `ACP_AGENT`        | Wrapper binary                                      | Auth env vars                                                  | Persona config root |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------- | ------------------- |
| `claude` (default) | `claude-agent-acp`                                  | `CLAUDE_CODE_OAUTH_TOKEN`                                      | `$HOME/.claude/`    |
| `codex`            | `codex-acp` (from `@agentclientprotocol/codex-acp`) | `OPENAI_API_KEY` (or pre-`codex login`); optional `CODEX_PATH` | `$HOME/.codex/`     |

Adding a new agent (Gemini CLI, Kiro, OpenCode, …) means writing one new
file under `service/src/agents/<name>.ts` that exports a `createXLauncher`
returning an `AgentLauncher`, widening the `AgentId` union in
`agents/types.ts`, and adding a `case` in `agents/index.ts`. The pool /
SSE / HA-side code does not change.

The `AgentLauncher` interface is intentionally small:

```ts
interface AgentLauncher {
  readonly id: AgentId;
  spawn(opts: { personaDir: string; logger: Logger }): StreamHandle;
  /** Optional ACP session mode entered after newSession.
   *  Claude needs "bypassPermissions"; Codex has no equivalent. */
  readonly sessionMode?: string;
}
```

Each launcher owns its own env-var contract: the Claude launcher reads
`CLAUDE_CODE_OAUTH_TOKEN`, the Codex launcher reads `OPENAI_API_KEY` and
optional `CODEX_PATH`. The service core never sees a token directly.

## Deployment model: one persona, one deployment

A **persona** is a self-contained agent identity: its own agent runtime,
its own system prompt, its own MCP server allowlist, optionally its own
skills, optionally its own model selection. Each persona is a separate
deployment of this service. A homelab with three wake words
("Hey Jarvis" / "Hey Friday" / "Hey Kid") runs three deployments — they
can even use different agents (Jarvis on Claude, Friday on Codex).

Why per-deployment, not per-request:

- The service stays simple — no catalog endpoint, no per-request
  init-param shuffling, no `(conversation_id, profile_hash)` session keys.
- Personas can be hard-isolated: separate bearer token, separate
  container, separate resource limits, separate agent config dir.
- New persona = `cp -r` an existing persona dir, edit, add a compose
  service. No code change to this repo.
- Per-deployment matches how every supported agent thinks about config
  (one home dir per process).

The cost is N container processes' baseline memory. For a homelab with
3–5 personas, this is well under 1 GB and acceptable.

## Persona = an agent's `$HOME`

A persona's configuration is **whatever the spawned ACP wrapper reads
from `$HOME`**. The service does not define or parse its own schema — it
just spawns the wrapper subprocess with `HOME` pointed at the mounted
persona directory.

For a Claude persona that looks like:

```
persona/
└── .claude/
    ├── CLAUDE.md         # system prompt (Claude Code convention)
    ├── settings.json     # model, mcpServers, permissions
    └── (skills/, plugins/, hooks/ — all native Claude Code files)
```

For a Codex persona it follows Codex CLI's own `$HOME/.codex/` layout.
An empty persona directory is valid for either — each agent falls back
to its defaults.

The persona directory is mounted read-only in most patterns. Each agent
caches credentials via env, not on disk (see [Authentication](#authentication)).

Real persona content lives in the **deployment repo** you operate this
service from, not in this repo. Copy-and-edit templates live under
[`examples/personas/`](../examples/personas/).

### Authentication

Each agent launcher reads only the env vars its agent needs:

- **Claude** — `CLAUDE_CODE_OAUTH_TOKEN`, passed to
  `@anthropic-ai/claude-agent-sdk` via the subprocess environment. No
  `claude auth login` ceremony inside the container; one Anthropic
  account's token can be reused across all persona deployments.
- **Codex** — `OPENAI_API_KEY`, or a pre-existing `codex login` state in
  the mounted `$HOME/.codex/`. The wrapper picks whichever it finds.

The gateway's own bearer token (`BEARER_TOKEN`, used to authenticate HA →
gateway calls) is never passed into the agent subprocess.

## Service responsibilities

The service is intentionally thin about agent behavior, thick about
transport.

**Thin about (do not reinvent — let the chosen agent handle):**

- Conversation memory beyond a single ACP session.
- Multi-agent orchestration, persona switching, A2A.
- Tool registration or schema. MCP servers declare their own tools; the
  service does not curate or filter them at the protocol layer.
- Anything the agent itself does (skills loading, system-prompt parsing,
  model fallback).

**Thick about (must do well, voice UX depends on it):**

- **SSE streaming with TTS-friendly chunking.** Forward
  `agent_message_chunk.text` deltas to HA, but emit chunk boundaries at
  punctuation or every ≥60 chars so the TTS engine has clean splits.
- **ACP event classification.** Forward `agent_message_chunk` text
  (skipping empty leading chunks) to the SSE stream. Drop the following
  silently unless `LOG_LEVEL=debug`: `available_commands_update`,
  `usage_update`, `agent_thought_chunk`, `user_message_chunk`,
  `current_mode_update`, `config_option_update`, `session_info_update`,
  `plan`. Log `tool_call` / `tool_call_update` at info level for
  debugging.
- **Per-agent session mode.** Claude needs
  `setSessionMode({ modeId: "bypassPermissions" })` immediately after
  `newSession` so tool calls don't pause for confirmation. Codex has no
  equivalent today, so the session-mode call is skipped (controlled by
  the launcher's optional `sessionMode` property).
- **`requestPermission` auto-allow as defense-in-depth.** When a wrapper
  does call `requestPermission` (Codex may, in scenarios that map onto
  Claude's `bypassPermissions`), the service auto-selects the first
  `allow_*` option and logs a warning so any actual prompt surfaces in
  logs. The voice satellite can't render an interactive dialog.
- **Session pool.** Key by `conversation_id` (or singleton in
  `SESSION_AFFINITY=entity` mode). Idle TTL 30 min. Max-age cap optional.
  Hard cap 8 concurrent. On subprocess exit or stall, the entry is
  purged so the next request opens a fresh subprocess.
- **HA-friendly errors.** Subprocess crash, ACP protocol error, or
  timeout must return text the TTS engine can speak — not let HA hang on
  the SSE connection.
- **Bearer auth** on `/v1/converse`. `/healthz` stays open and reports
  the active agent id.
- **Subprocess hygiene.** Spawn with a clean per-agent env (HOME, PATH,
  USER, plus the agent's own auth var). `BEARER_TOKEN`, unrelated host
  env, and the service's own log config never reach the child.
- **Structured logging.** All log lines include `conversation_id` once
  established, so per-conversation traces can be grepped out.

## Home Assistant integration

The Python `custom_components/acp_gateway/` registers one
`ConversationEntity` per config entry. The config_flow supports adding
multiple entries — one per persona. Each entry points to one deployment.

Config entry fields:

- `name` — display name (e.g. "Jarvis"), used as entity friendly name.
- `gateway_url` — base URL of one deployment.
- `bearer_token` — matching deployment's token.
- `max_tokens` — response budget (default 300).
- `request_timeout_s` — per-request timeout (default 30 s).

Agent choice, system prompt, and MCP configuration are **not** in the
integration — they belong to the deployment.

Wake-word routing happens in HA itself: each wake word maps to an Assist
pipeline, each pipeline points at one ACP Gateway conversation entity.
Different wake words → different pipelines → different entities →
different deployments.

The integration also sets `continue_conversation=True` when the spoken
reply ends with `?` or `？`, so questions keep the satellite mic open
for a follow-up; statements close the conversation. Agents are
instructed via persona CLAUDE.md / equivalent to use this convention.

## Stream filtering

The service forwards only `agent_message_chunk` events whose
`content.type` is `text` and whose `text` is non-empty. The first chunk
of a response is often `text: ""` (adapter convention) and must be
skipped. All other ACP update kinds are dropped from the SSE stream.

The SSE stream is terminated by an explicit `done` event so HA knows the
response ended cleanly (not a timeout). On error the service emits a
single `error` event with a TTS-friendly message, then closes the
stream.

### Spawn / handshake order

```
launcher.spawn(personaDir, logger)   # HOME = personaDir, agent-specific env
  → initialize({ protocolVersion, clientCapabilities: { fs: {} },
                 clientInfo: { name: "ha-acp-gateway", version } })
  → newSession({ cwd: HOME, mcpServers: [] })
  → if launcher.sessionMode: setSessionMode({ sessionId, modeId })
  → [per HA request] prompt({ sessionId, prompt: [{ type: "text", text }] })
       └─ sessionUpdate notifications fan out (filter → SSE)
       └─ prompt resolves with stopReason → emit `done`
```

`mcpServers: []` in `newSession` is intentional — MCP configuration
comes from the persona's native config, not from the wire request.

### Token economics

Agents that ship with built-in tools / prompts load a baseline set into
the prompt cache on the first turn of a session (Claude: ~16 K cached
tokens). The session pool's long idle TTL exists partly to amortize this
cost across multiple HA turns.

For voice deployments specifically, `SESSION_AFFINITY=entity` collapses
every HA conversation to one shared session — every wake-word cycle
after the first hits warm cache instead of paying the cold-cache cost
per new conversation_id. Pair with `SESSION_MAX_AGE_SEC` so the singleton
resets periodically and context can't grow without bound.

## Session pool

Keyed by `conversation_id` (or the singleton key in entity-affinity
mode). Each session holds one spawned agent subprocess and its ACP
connection.

- Lazy creation on first request for a key.
- Idle TTL: 30 min (configurable).
- Max-age cap: optional (`SESSION_MAX_AGE_SEC`).
- Concurrency cap: 8 (configurable via `MAX_CONCURRENT_SESSIONS`). When
  the cap is reached, the oldest idle session is evicted; if none are
  idle the new request returns a friendly error to HA.
- On subprocess exit or stall, the entry is purged so the next request
  opens a fresh subprocess.

## What this service is NOT

- Not an agent framework. No memory, no RAG, no tool registry, no
  persona switching at runtime.
- **Not any agent's config layer.** The persona directory IS the chosen
  agent's native config root. The service does not parse, validate, or
  translate it.
- Not a generic gateway. It speaks ACP on the agent side and HA's SSE
  delta format on the other, on purpose.
- Not opinionated about deployment topology beyond "one container per
  persona". Bring your own compose / Helm / nomad / systemd unit.

## Out of scope

- `AITaskEntity` for structured generation.
- Persona switching from a single deployment (would need catalog
  endpoint and per-request init params).
- HA LLM API tool routing (only the persona's MCP servers).
- On-disk session persistence across service restart.
- Custom wake-word training.
