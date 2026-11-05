import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  InitializeResponse,
  NewSessionResponse,
  SetSessionModeResponse,
  SessionUpdate,
  Stream,
} from "@agentclientprotocol/sdk";
import type { AgentLauncher } from "./agents/types.js";
import type { Logger } from "./logger.js";

// Re-export so existing imports (e.g. `import { ndJsonStream }`) inside
// agent launchers don't have to chase the SDK directly.
export { ndJsonStream };

export interface AcpSessionOptions {
  personaDir: string;
  launcher: AgentLauncher;
  logger: Logger;
  clientInfo?: { name: string; version: string };
  /** Test hook — paired in-memory streams replace the real spawn. */
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
  launcher: AgentLauncher;
  logger: Logger;
}) => Promise<AcpSession>;

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

export async function openAcpSession(
  opts: AcpSessionOptions,
): Promise<AcpSession> {
  const factory =
    opts.streamFactory ??
    (() =>
      Promise.resolve(
        opts.launcher.spawn({
          personaDir: opts.personaDir,
          logger: opts.logger,
        }),
      ));

  const handle = await factory();

  // Single in-flight prompt at a time (V1 — pool of size 1 per session).
  let activeStream: Pushable<string> | null = null;
  let aborted = false;

  const clientApp = client({ name: "ha-acp-gateway" })
    .onRequest(methods.client.session.requestPermission, ({ params: p }) => {
      // Under bypassPermissions this should not fire (Claude path). For
      // agents without a bypass mode (Codex), this is the only fallback —
      // auto-allow the first allow_* option so voice doesn't hang on a
      // permission prompt the user can't see.
      opts.logger.warn(
        { toolCall: p.toolCall.title, options: p.options.map((o) => o.kind) },
        "agent requested permission (auto-allowing)",
      );
      const allow =
        p.options.find((o) => o.kind === "allow_always") ??
        p.options.find((o) => o.kind === "allow_once") ??
        p.options[0];
      if (!allow) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: allow.optionId },
      };
    })
    .onNotification(methods.client.session.update, ({ params: n }) => {
      const delta = extractAgentDelta(n.update);
      if (delta !== null) {
        activeStream?.push(delta);
      } else {
        opts.logger.debug(
          { kind: n.update.sessionUpdate },
          "dropping ACP update",
        );
      }
    });

  const connection = clientApp.connect(handle.stream);
  const agent = connection.agent;

  // Translate subprocess exit into a stream failure on whatever's in flight.
  void handle.exited.then(({ code, signal }) => {
    aborted = true;
    opts.logger.info(
      { code, signal, agent: opts.launcher.id },
      "agent subprocess exited",
    );
    activeStream?.fail(
      new Error(
        `subprocess exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ),
    );
  });

  opts.logger.debug({ agent: opts.launcher.id }, "ACP initialize");
  const _initResp: InitializeResponse = await agent.request(
    methods.agent.initialize,
    {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: {} },
      clientInfo: opts.clientInfo ?? {
        name: "ha-acp-gateway",
        version: "0.2.1",
      },
    },
  );
  void _initResp;

  opts.logger.debug({ personaDir: opts.personaDir }, "ACP newSession");
  const newSess: NewSessionResponse = await agent.request(
    methods.agent.session.new,
    {
      cwd: opts.personaDir,
      mcpServers: [],
    },
  );
  const sessionId = newSess.sessionId;

  if (opts.launcher.sessionMode) {
    opts.logger.debug(
      { sessionId, mode: opts.launcher.sessionMode },
      "ACP setSessionMode",
    );
    const _modeResp: SetSessionModeResponse = await agent.request(
      methods.agent.session.setMode,
      {
        sessionId,
        modeId: opts.launcher.sessionMode,
      },
    );
    void _modeResp;
  }

  opts.logger.info({ sessionId, agent: opts.launcher.id }, "ACP session ready");

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

      const settled = agent
        .request(methods.agent.session.prompt, {
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
            await agent.notify(methods.agent.session.cancel, { sessionId });
          } catch (err) {
            opts.logger.warn(
              { err },
              "cancel after early iterator exit failed",
            );
          }
        }
        await settled;
      }
    },
    async close(): Promise<void> {
      activeStream?.end();
      activeStream = null;
      connection.close();
      await handle.close();
    },
  };
}
