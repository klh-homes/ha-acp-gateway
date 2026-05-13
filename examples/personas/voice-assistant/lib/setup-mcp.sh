#!/bin/sh
# Register MCP servers with the persona's Claude Code config. Idempotent
# and graceful: missing env or registration failure does not block the
# gateway from starting.
#
# The `claude` CLI writes its MCP entries to $HOME/.claude.json. We point
# HOME at PERSONA_DIR so the claude-agent-acp adapter — which the gateway
# spawns later with the same HOME — reads the registered servers back.

: "${PERSONA_DIR:?PERSONA_DIR must be set}"

if [ -n "$HA_MCP_URL" ]; then
  if ! HOME="$PERSONA_DIR" claude mcp list 2>/dev/null | grep -q "ha-mcp"; then
    HOME="$PERSONA_DIR" claude mcp add ha-mcp "$HA_MCP_URL" \
      --transport http --scope user 2>/dev/null || true
  fi
fi

# Register additional MCP servers in the same pattern. Example:
#
# if [ -n "$CONTEXT7_API_KEY" ] && \
#    ! HOME="$PERSONA_DIR" claude mcp list 2>/dev/null | grep -q "context7"; then
#   HOME="$PERSONA_DIR" claude mcp add context7 https://mcp.context7.com/mcp \
#     --transport http --scope user \
#     --header "CONTEXT7_API_KEY: $CONTEXT7_API_KEY" 2>/dev/null || true
# fi
