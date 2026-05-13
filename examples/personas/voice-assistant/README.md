# voice-assistant

A realistic Home Assistant voice agent template. Bakes its persona content
on top of the upstream ha-claude-acp image and registers MCP servers from
runtime env via `claude mcp add`, so secrets never enter the image layer.

Copy this whole directory into your deployment repo, rename it to taste
(e.g. `personas/jarvis/`), edit, and reference its `Dockerfile` from a
compose service block.

## What's here

| File | Purpose |
|---|---|
| `Dockerfile` | Overlay on top of `ghcr.io/klh-homes/ha-claude-acp:<tag>`. Adds tini, rsync, the `claude` CLI, your persona content, optional skill bakes, and the entrypoint wrapper. |
| `entrypoint.sh` | Sources `lib/*.sh` then `exec`s the upstream `CMD`. |
| `lib/install-config.sh` | cp's CLAUDE.md + settings.json from image bake into `$PERSONA_DIR/.claude/`. Runs on every start. |
| `lib/install-skills.sh` | rsyncs each `/opt/skills-bake/<name>/` into `$PERSONA_DIR/.claude/skills/<name>/`. |
| `lib/setup-mcp.sh` | Calls `claude mcp add` for each enabled MCP server, idempotent. Writes to `$PERSONA_DIR/.claude.json`. |
| `.claude/CLAUDE.md` | Voice-tuned system prompt (short replies, plain prose, action-before-report). |
| `.claude/settings.json` | `model`, `effortLevel`, `permissions.defaultMode: bypassPermissions` so MCP tool calls don't pop a confirmation dialog voice can't surface. |
| `.dockerignore` | Skip README from the build context. |

## Why bake + reseed instead of bind-mount?

The gateway service writes runtime state into `$PERSONA_DIR` (most
visibly `.claude.json` after `claude mcp add`). That needs to be a
writable volume. If we also mounted the persona content as a bind-mount,
the operator-side files would shadow the volume.

The bake-into-image + reseed-on-start pattern means:

- Editing `CLAUDE.md` or `settings.json` forces an image rebuild, so the
  image SHA tracks the persona's contract — `docker compose up --build`
  drives recreation automatically.
- The named volume holds runtime mutations (registered MCP servers,
  any future session state) without leaking into image content.
- Skills can be added/removed by editing the Dockerfile's COPY lines;
  `rsync --delete` cleans up removed files on next start.

The same convention is used by the openab/quill agents in the
klh-homelab deployment — see klh-homelab's `CLAUDE.md` for the
authoritative discussion of named-volume-masking and the bake escape.

## MCP setup

`lib/setup-mcp.sh` registers ha-mcp from `$HA_MCP_URL` at every container
start. The pattern is documented in that file and trivially extensible —
add another `claude mcp add ...` block guarded by the relevant env var.

## Skills

Two bake paths in the Dockerfile (currently commented out). Uncomment and
adapt the `COPY` lines to bake any skill bundle into the image; the
runtime `install-skills.sh` will pick them up automatically. Each
subdirectory of `/opt/skills-bake/` becomes one skill at
`$PERSONA_DIR/.claude/skills/<basename>/`.

For a "meta-pack" repo that ships many skills under its own `skills/`
subdirectory, break it apart in the Dockerfile with one COPY line per
inner skill.

## Minimal persona

If all you need is the upstream defaults (Sonnet 4.6, no MCP, no skills,
`permissions.defaultMode: default`), use [`../minimal/`](../minimal/)
instead — an empty `.claude/` directory and no overlay Dockerfile.
