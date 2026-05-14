import { createClaudeLauncher } from "./claude.js";
import { createCodexLauncher } from "./codex.js";
import type { AgentId, AgentLauncher } from "./types.js";

export type { AgentId, AgentLauncher } from "./types.js";
export { createClaudeLauncher } from "./claude.js";
export { createCodexLauncher } from "./codex.js";

/**
 * Build the launcher for the agent selected via `ACP_AGENT` (parsed in
 * config.ts). Each branch reads only the env vars its agent needs, so the
 * service can run with just OPENAI_API_KEY set when ACP_AGENT=codex.
 *
 * To add a new agent (Gemini, Kiro, OpenCode, ...): create
 * `agents/<name>.ts` exporting a `create<Name>Launcher`, widen the
 * `AgentId` union in `agents/types.ts`, and add a `case` here.
 */
export function createLauncher(agent: AgentId): AgentLauncher {
  switch (agent) {
    case "claude": {
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!oauthToken) {
        throw new Error(
          "CLAUDE_CODE_OAUTH_TOKEN must be set when ACP_AGENT=claude",
        );
      }
      return createClaudeLauncher({ oauthToken });
    }
    case "codex": {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      const codexPath = process.env.CODEX_PATH;
      return createCodexLauncher({
        ...(openaiApiKey ? { openaiApiKey } : {}),
        ...(codexPath ? { codexPath } : {}),
      });
    }
  }
}
