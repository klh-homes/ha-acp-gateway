import type { StreamHandle } from "../acp_session.js";
import { spawnAcpSubprocess } from "./claude.js";
import type { AgentLauncher } from "./types.js";

/**
 * `@agentclientprotocol/codex-acp` installs a binary named `acp-server`
 * that bridges Codex CLI through ACP. The wrapper itself does not own
 * auth — the underlying `codex` binary uses OPENAI_API_KEY (or its own
 * stored login state). `CODEX_PATH` tells `acp-server` where to find the
 * codex binary; if unset, it falls back to whichever `codex` is on PATH.
 */
const DEFAULT_BIN = "acp-server";

export interface CodexLauncherOptions {
  /** Passed through to the subprocess. Required unless the user has run
   *  `codex login` and stored credentials inside the persona dir. */
  openaiApiKey?: string;
  /** Optional absolute path to the codex binary. If unset, the wrapper
   *  resolves `codex` via PATH inside the container. */
  codexPath?: string;
  /** Override the wrapper binary on PATH — primarily for tests. */
  bin?: string;
}

export function createCodexLauncher(
  opts: CodexLauncherOptions = {},
): AgentLauncher {
  const bin = opts.bin ?? DEFAULT_BIN;
  return {
    id: "codex",
    // Codex doesn't define an ACP session mode equivalent to Claude's
    // `bypassPermissions`. Leave unset; openAcpSession skips setSessionMode.
    spawn({ personaDir, logger }): StreamHandle {
      const env: NodeJS.ProcessEnv = {
        HOME: personaDir,
        PATH: process.env.PATH ?? "",
        USER: process.env.USER ?? "",
      };
      if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
      if (opts.codexPath) env.CODEX_PATH = opts.codexPath;
      return spawnAcpSubprocess({
        bin,
        env,
        logSource: "codex-acp",
        logger,
      });
    },
  };
}
