# Persona examples

A persona is a directory mounted into the gateway as `HOME` for the
spawned agent subprocess. Each agent reads its own native config layout
from `$HOME`:

| Agent    | Config layout                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `$HOME/.claude/` — `CLAUDE.md`, `settings.json`, optional `skills/`, MCP via `claude mcp add` writing to `$HOME/.claude.json` |
| `codex`  | `$HOME/.codex/` — codex CLI's native config; see https://developers.openai.com/codex/cli                                      |

The gateway service does not parse anything here — it only sets `HOME`
and spawns the agent's ACP wrapper.

See `docs/ARCHITECTURE.md` for the design rationale.

## Claude — what gets read

The `@agentclientprotocol/claude-agent-acp` adapter (as of v0.100.0) reads
the following files from the mounted `HOME` on startup:

- **`.claude/settings.json`** — `ClaudeCodeSettings` shape:
  ```ts
  {
    permissions?: { defaultMode?: string },  // e.g. "bypassPermissions"
    env?: Record<string, string>,
    model?: string,                          // "default" | "haiku" | "opus" | ...
    effortLevel?: string,                    // "low" | "medium" | "high" | "max"
    availableModels?: string[],
  }
  ```
- **`.claude/CLAUDE.md`** — Claude Code's system-prompt file. Read on
  session start and prepended to the conversation context.
- **MCP servers** — _not in `settings.json`._ Configure via the Claude
  CLI from a host with `HOME` set to the persona dir:
  ```bash
  HOME=/path/to/persona claude mcp add ha-mcp http://ha-mcp.lan:3000/mcp \
    --transport http --header "Authorization: Bearer <token>"
  ```
  This writes to whichever file the current `claude` version maintains
  (`~/.claude.json` historically). See the official Claude Code MCP docs
  for the authoritative procedure:
  https://docs.anthropic.com/en/docs/claude-code/mcp

## Empty persona is valid

An empty directory with no `.claude/` works — the adapter falls back to
its defaults (Sonnet 4.6, no MCP, permission mode `default`). Useful for
first-boot smoke testing the gateway in isolation.

## Examples in this directory

Both examples target **Claude** (`ACP_AGENT=claude`). Codex / Gemini /
other-agent persona examples will land here when the upstream wrappers
stabilise — the gateway side is already agent-agnostic.

| Example            | What it is                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal/`         | One-line system prompt in a bind-mounted `.claude/` directory. Smallest demo; nothing baked, no overlay Dockerfile. The simplest possible deployment.                                                                                                                                                                                                                                 |
| `voice-assistant/` | A realistic HA voice agent: short conversational prompt, `bypassPermissions` mode, model and effort tuned for voice latency. Ships with an **overlay Dockerfile** that bakes persona content into a per-persona image and an entrypoint that reseeds the volume + registers MCP servers via `claude mcp add` on every start. This is the pattern recommended for production homelabs. |

## Two deployment patterns

There are two ways to consume `examples/personas/`:

1. **Bind-mount the persona dir** (`minimal/`-style). Mount the directory
   read-only into the upstream image at the path it expects (see the
   upstream `service/Dockerfile` for the current `PERSONA_DIR`). The
   operator edits files on the host and they take effect at container
   restart. No build step.

2. **Bake-and-reseed** (`voice-assistant/`-style). A per-persona overlay
   Dockerfile layers content onto the upstream image. The compose
   service mounts a named volume at `PERSONA_DIR` for runtime state
   (MCP registrations, future session storage); image-baked content is
   reseeded into the volume on every start via `lib/install-config.sh`
   and `lib/install-skills.sh`. Editing the persona forces an image
   rebuild, so image SHA tracks the persona's contract.

The bake-and-reseed pattern exists because Docker named volumes mask
image content at the same path after first creation. `cp -f` /
`rsync --delete` from a bake location OUTSIDE the volume on every
container start guarantees image updates always win.

## Where the real personas live

This repo ships templates only. Your actual persona directories — with
real system prompts, real MCP tokens, area-specific tone, your wake-word
mapping — belong in a deployment repo (a homelab repo, an internal
operations repo, etc.) and are mounted into the gateway container at
deploy time.

**Do not commit secrets** (ha-mcp tokens, third-party API keys) into
version control. Inject them at deploy time via volume mounts or env
templates.

## Multi-deployment example

See [`../docker-compose.example.yaml`](../docker-compose.example.yaml) for
a two-persona compose layout (one wake word per service block). The
deployment repo's `personas/` directory holds the actual content and is
mounted read-only into each container.
