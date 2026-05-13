# Persona examples

A persona is a directory mounted into the gateway as `HOME` for the
spawned `claude-agent-acp` subprocess. The adapter reads its config from
`$HOME/.claude/` using Claude Code's native layout. The service does not
parse anything here — it only sets `HOME` and spawns the adapter.

See `docs/ARCHITECTURE.md` for the design rationale.

## What gets read

The `@agentclientprotocol/claude-agent-acp` adapter (as of v0.33.1) reads
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
- **MCP servers** — *not in `settings.json`.* Configure via the Claude
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

| Example | What it is |
|---|---|
| `minimal/` | One-line system prompt, no settings tweaks. Smallest demo. |
| `voice-assistant/` | A realistic HA voice agent: short conversational prompt, `bypassPermissions` mode (so MCP tool calls don't prompt), model and effort tuned for voice latency. MCP setup left to deployment. |

## Where the real personas live

This repo ships templates only. Your actual persona directories — with
real system prompts, real MCP tokens, area-specific tone, your wake-word
mapping — belong in a deployment repo (a homelab repo, an internal
operations repo, etc.) and are mounted into the gateway container at
deploy time.

**Do not commit secrets** (ha-mcp tokens, third-party API keys) into
version control. Inject them at deploy time via volume mounts or env
templates.
