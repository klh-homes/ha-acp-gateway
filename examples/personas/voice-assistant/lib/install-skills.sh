#!/bin/sh
# Install/refresh skill bundles under $PERSONA_DIR/.claude/skills/.
# rsync --delete per-skill so upstream-removed files inside a managed
# skill get cleaned up, while unmanaged skills (operator drops something
# into the volume by hand) stay untouched.
#
# Skill bake layout: each subdirectory of /opt/skills-bake/ is treated as
# one skill. To bake a "meta-pack" (a repo containing many skills under
# its own skills/ subdir), break it apart in the Dockerfile with one
# COPY line per inner skill, e.g.:
#
#   COPY vendor/skills/<meta-pack>/skills/<skill-name> \
#        /opt/skills-bake/<skill-name>

: "${PERSONA_DIR:?PERSONA_DIR must be set}"

mkdir -p "$PERSONA_DIR/.claude/skills"

sync_skill() {
  src=$1
  dest=$2
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  rsync -a --delete "$src"/ "$dest"/
}

for d in /opt/skills-bake/*/; do
  [ -d "$d" ] || continue
  sync_skill "$d" "$PERSONA_DIR/.claude/skills/$(basename "$d")"
done
