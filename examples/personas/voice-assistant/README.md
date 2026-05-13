# voice-assistant

A realistic Home Assistant voice agent template. Copy into your deployment
repo, edit the system prompt to taste, configure MCP for ha-mcp, and
mount as the gateway's `PERSONA_DIR`.

## Files

- **`.claude/CLAUDE.md`** — system prompt tuned for voice: short replies,
  plain prose, action-before-report phrasing.
- **`.claude/settings.json`** — `model` set to the fast default, effort
  set to `low` for snappy turns, `defaultMode: "bypassPermissions"` so
  MCP tool calls don't pop a confirmation dialog (which voice can't
  surface anyway).

## MCP setup (deployment-time, not committed)

This template has no MCP servers configured because tokens are
deployment secrets. After you have a persona dir on disk:

```bash
# from the deployment host, with HOME pointing at the persona dir:
HOME=$(pwd) claude mcp add ha-mcp http://ha-mcp.lan:3000/mcp \
  --transport http \
  --header "Authorization: Bearer ${HA_MCP_TOKEN}"
```

Or hand-edit `~/.claude.json` if you prefer (the schema is documented at
https://docs.anthropic.com/en/docs/claude-code/mcp).

## Notes on permission mode

`bypassPermissions` means MCP tool invocations execute without asking
the client (us) for permission. That's correct for voice — there's no
UI to present a permission dialog through. Tool access is gated by
*which MCP servers you configured* on this persona, not by per-call
prompts.

If you want a persona that can only read state but not act (e.g. a
read-only "house status" agent), pair it with an MCP server that only
exposes read-only tools.
