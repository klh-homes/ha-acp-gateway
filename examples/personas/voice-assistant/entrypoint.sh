#!/bin/sh
# Voice-assistant persona entrypoint. Runs the install/setup helpers (which
# reseed image-baked content into the persona's named volume and register
# MCP servers from runtime env) before exec'ing the upstream gateway CMD.
set -e

LIB="$(dirname "$0")/lib"

. "$LIB/install-config.sh"
. "$LIB/install-skills.sh"
. "$LIB/setup-mcp.sh"

exec "$@"
