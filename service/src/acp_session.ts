import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  InitializeResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionModeResponse,
  SessionUpdate,
  Stream,
} from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.js";

export interface AcpSessionOptions {
  personaDir: string;
  oauthToken: string;
  logger: Logger;
  spawnBin?: string;
  clientInfo?: { name: string; version: string };
  streamFactory?: () => Promise<StreamHandle>;
}

export interface StreamHandle {
  stream: Stream;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close: () => Promise<void>;
}

export interface AcpSession {
  readonly sessionId: string;
  /** Resolves when the underlying subprocess has exited, for any reason. */
  readonly closed: Promise<void>;
  prompt(text: string): AsyncIterable<string>;
  close(): Promise<void>;
}

export type AcpFactory = (opts: {
  personaDir: string;
  oauthToken: string;
  logger: Logger;
}) => Promise<AcpSession>;

const DEFAULT_BIN = "claude-agent-acp";

/**
 * Pure event filter. Returns the forwardable text delta, or null if the
 * update should be dropped. Exported for unit tests.
 */
export function extractAgentDelta(update: SessionUpdate): string | null {
  if (update.sessionUpdate !== "agent_message_chunk") return null;
  if (update.content.type !== "text") return null;
  if (update.content.text === "") return null;
  return update.content.text;
}

/**
 * Single-producer / single-consumer async queue. The session-update handler
 * pushes deltas; the caller iterates with `for await`.
 */
export class Pushable<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<{
    resolve: (v: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = undefined;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = err;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(err);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.ended) {
        if (this.failure !== undefined) {
          if (this.failure instanceof Error) throw this.failure;
          throw new Error(
            typeof this.failure === "string"
              ? this.failure
              : JSON.stringify(this.failure),
          );
        }
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function spawnSubprocess(opts: {
  spawnBin: string;
  personaDir: string;
  oauthToken: string;
  logger: Logger;
}): StreamHandle {
  const proc = spawn(opts.spawnBin, [], {
    env: {
      HOME: opts.personaDir,
      PATH: process.env.PATH ?? "",
      USER: process.env.USER ?? "",
      CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text.length > 0) {
      opts.logger.warn({ source: "claude-agent-acp" }, text);
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
    throw new Error("claude-agent-acp subprocess missing stdio pipes");
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

export async function openAcpSession(
  opts: AcpSessionOptions,
): Promise<AcpSession> {
  const factory =
    opts.streamFactory ??
    (() =>
      Promise.resolve(
        spawnSubprocess({
          spawnBin: opts.spawnBin ?? DEFAULT_BIN,
          personaDir: opts.personaDir,
          oauthToken: opts.oauthToken,
          logger: opts.logger,
        }),
      ));

  const handle = await factory();

  // Single in-flight prompt at a time (V1 — pool of size 1 per session).
  let activeStream: Pushable<string> | null = null;
  let aborted = false;

  const client: Client = {
    requestPermission(
      p: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      // Under bypassPermissions this should not fire. Log loudly so a
      // misconfigured persona surfaces in operator logs, then auto-allow
      // the first allow_* option as defense-in-depth.
      opts.logger.warn(
        { toolCall: p.toolCall.title, options: p.options.map((o) => o.kind) },
        "unexpected requestPermission under bypassPermissions",
      );
      const allow =
        p.options.find((o) => o.kind === "allow_always") ??
        p.options.find((o) => o.kind === "allow_once") ??
        p.options[0];
      if (!allow) {
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      }
      return Promise.resolve({
        outcome: { outcome: "selected", optionId: allow.optionId },
      });
    },
    sessionUpdate(n: SessionNotification): Promise<void> {
      const delta = extractAgentDelta(n.update);
      if (delta !== null) {
        activeStream?.push(delta);
      } else {
        opts.logger.debug(
          { kind: n.update.sessionUpdate },
          "dropping ACP update",
        );
      }
      return Promise.resolve();
    },
  };

  const conn = new ClientSideConnection(() => client, handle.stream);

  // Translate subprocess exit into a stream failure on whatever's in flight.
  void handle.exited.then(({ code, signal }) => {
    aborted = true;
    opts.logger.info({ code, signal }, "claude-agent-acp exited");
    activeStream?.fail(
      new Error(`subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
  });

  // The SDK re-exports schema types via `export type *`, which the current
  // typescript-eslint version cannot follow back to the concrete shape,
  // so it sees these awaited responses as `unknown`. tsc resolves them
  // correctly; the disables below cover only this interop quirk.

  opts.logger.debug("ACP initialize");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const _initResp: InitializeResponse = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: {} },
    clientInfo: opts.clientInfo ?? { name: "ha-claude-acp", version: "0.1.0" },
  });
  void _initResp;

  opts.logger.debug({ personaDir: opts.personaDir }, "ACP newSession");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const newSess: NewSessionResponse = await conn.newSession({
    cwd: opts.personaDir,
    mcpServers: [],
  });
  const sessionId = newSess.sessionId;

  opts.logger.debug({ sessionId }, "ACP setSessionMode(bypassPermissions)");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const _modeResp: SetSessionModeResponse = await conn.setSessionMode({
    sessionId,
    modeId: "bypassPermissions",
  });
  void _modeResp;

  opts.logger.info({ sessionId }, "ACP session ready");

  return {
    sessionId,
    closed: handle.exited.then(() => undefined),
    async *prompt(text: string): AsyncIterable<string> {
      if (activeStream) {
        throw new Error("session is already streaming a prompt");
      }
      if (aborted) {
        throw new Error("session subprocess has exited");
      }
      const pushable = new Pushable<string>();
      activeStream = pushable;
      let promptDone = false;

      const settled = conn
        .prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        })
        .then(() => {
          promptDone = true;
          pushable.end();
        })
        .catch((err: unknown) => {
          promptDone = true;
          pushable.fail(err);
        })
        .finally(() => {
          activeStream = null;
        });

      try {
        for await (const delta of pushable) {
          yield delta;
        }
      } finally {
        if (!promptDone) {
          // Caller bailed early — cancel the in-flight turn.
          try {
            await conn.cancel({ sessionId });
          } catch (err) {
            opts.logger.warn({ err }, "cancel after early iterator exit failed");
          }
        }
        await settled;
      }
    },
    async close(): Promise<void> {
      activeStream?.end();
      activeStream = null;
      await handle.close();
    },
  };
}
