#!/bin/sh
# Reseed CLAUDE.md + .claude/settings.json from image bake into PERSONA_DIR.
# When PERSONA_DIR is mounted as a named Docker volume, first container
# creation seeds the volume from image content but subsequent deploys keep
# the existing volume content and silently mask image updates at the same
# paths. cp -f on every container start guarantees the latest baked
# content wins.

: "${PERSONA_DIR:?PERSONA_DIR must be set}"

mkdir -p "$PERSONA_DIR/.claude"
cp -f /opt/persona-bake/CLAUDE.md "$PERSONA_DIR/.claude/CLAUDE.md"
cp -f /opt/persona-bake/.claude/settings.json "$PERSONA_DIR/.claude/settings.json"
