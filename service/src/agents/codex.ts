import type { StreamHandle } from "../acp_session.js";
import { spawnAcpSubprocess } from "./claude.js";
import type { AgentLauncher } from "./types.js";

/**
 * `@agentclientprotocol/codex-acp` installs a binary named `codex-acp` that
 * bridges the bundled Codex CLI through ACP via Codex App Server. The wrapper
 * itself does not own auth — Codex uses OPENAI_API_KEY (or its own stored login
 * state). `CODEX_PATH` can select a different Codex binary when needed.
 */
const DEFAULT_BIN = "codex-acp";

export interface CodexLauncherOptions {
  /** Passed through to the subprocess. Required unless the user has run
   *  `codex login` and stored credentials inside the persona dir. */
  openaiApiKey?: string;
  /** Optional absolute path to the codex binary. If unset, the wrapper uses
   *  the compatible Codex runtime bundled with the adapter package. */
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
