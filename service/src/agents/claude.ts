import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { StreamHandle } from "../acp_session.js";
import type { Logger } from "../logger.js";
import type { AgentLauncher } from "./types.js";

const DEFAULT_BIN = "claude-agent-acp";

export interface ClaudeLauncherOptions {
  oauthToken: string;
  /** Override the binary on PATH — primarily for tests. */
  bin?: string;
}

export function createClaudeLauncher(
  opts: ClaudeLauncherOptions,
): AgentLauncher {
  const bin = opts.bin ?? DEFAULT_BIN;
  return {
    id: "claude",
    sessionMode: "bypassPermissions",
    spawn({ personaDir, logger }): StreamHandle {
      return spawnAcpSubprocess({
        bin,
        env: {
          HOME: personaDir,
          PATH: process.env.PATH ?? "",
          USER: process.env.USER ?? "",
          CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
        },
        logSource: "claude-agent-acp",
        logger,
      });
    },
  };
}

interface SpawnOpts {
  bin: string;
  env: NodeJS.ProcessEnv;
  logSource: string;
  logger: Logger;
}

/** Shared spawn helper — both Claude and Codex launchers use it. */
export function spawnAcpSubprocess(opts: SpawnOpts): StreamHandle {
  const proc = spawn(opts.bin, [], {
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text.length > 0) {
      opts.logger.warn({ source: opts.logSource }, text);
    }
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const stdin = proc.stdin;
  const stdout = proc.stdout;
  if (!stdin || !stdout) {
    proc.kill("SIGKILL");
    throw new Error(`${opts.bin} subprocess missing stdio pipes`);
  }
  const stream = ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
  );

  return {
    stream,
    exited,
    async close(): Promise<void> {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 1000);
      await exited;
      clearTimeout(killTimer);
    },
  };
}
