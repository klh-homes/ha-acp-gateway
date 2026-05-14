import type { StreamHandle } from "../acp_session.js";
import type { Logger } from "../logger.js";

/**
 * An ACP-speaking agent runtime that can be spawned as a subprocess.
 *
 * Each launcher closes over its own auth (read from env at construction
 * time) and knows which binary on PATH to spawn. The session pool / ACP
 * client layer stays agent-agnostic; switching agents is a config flip
 * (`ACP_AGENT=claude|codex`), not a code edit.
 */
export interface AgentLauncher {
  /** Stable identifier — used in logs and the /healthz response. */
  readonly id: AgentId;

  /**
   * Spawn the agent subprocess and return a duplex stream + lifecycle
   * handle. Wired into `openAcpSession` via `streamFactory` so the same
   * test harness (paired in-memory streams) works for every agent.
   */
  spawn(opts: { personaDir: string; logger: Logger }): StreamHandle;

  /**
   * Optional ACP session mode to enter after `newSession`. Claude needs
   * `bypassPermissions` so tool calls don't pause for confirmation; Codex
   * has no equivalent mode today, so leave this undefined and the session
   * setup skips `setSessionMode`.
   */
  readonly sessionMode?: string;
}

export type AgentId = "claude" | "codex";
