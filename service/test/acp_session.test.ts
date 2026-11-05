import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  PromptRequest,
  PromptResponse,
  Stream,
} from "@agentclientprotocol/sdk";

import {
  Pushable,
  extractAgentDelta,
  openAcpSession,
  type StreamHandle,
} from "../src/acp_session.js";
import type { AgentLauncher } from "../src/agents/types.js";
import { createLogger } from "../src/logger.js";

/** Test launcher — openAcpSession uses streamFactory in tests, so .spawn()
 *  should never be called. The launcher only needs to satisfy the type
 *  and supply the `bypassPermissions` mode that Claude tests expect. */
const fakeLauncher: AgentLauncher = {
  id: "claude",
  sessionMode: "bypassPermissions",
  spawn() {
    throw new Error(
      "spawn should not be called when streamFactory is provided",
    );
  },
};

const logger = createLogger("silent");

// -- Pushable --------------------------------------------------------------

describe("Pushable", () => {
  it("yields buffered values in order", async () => {
    const p = new Pushable<number>();
    p.push(1);
    p.push(2);
    p.push(3);
    p.end();
    const collected: number[] = [];
    for await (const v of p) collected.push(v);
    expect(collected).toEqual([1, 2, 3]);
  });

  it("delivers values pushed mid-iteration to a waiting consumer", async () => {
    const p = new Pushable<string>();
    const consumed: string[] = [];
    const consumer = (async () => {
      for await (const v of p) consumed.push(v);
    })();
    await new Promise((r) => setTimeout(r, 10));
    p.push("a");
    await new Promise((r) => setTimeout(r, 10));
    p.push("b");
    p.end();
    await consumer;
    expect(consumed).toEqual(["a", "b"]);
  });

  it("propagates failures to the consumer", async () => {
    const p = new Pushable<number>();
    p.push(1);
    p.fail(new Error("boom"));
    const collected: number[] = [];
    await expect(async () => {
      for await (const v of p) collected.push(v);
    }).rejects.toThrow("boom");
    expect(collected).toEqual([1]);
  });

  it("ignores pushes after end", async () => {
    const p = new Pushable<number>();
    p.end();
    p.push(1);
    const collected: number[] = [];
    for await (const v of p) collected.push(v);
    expect(collected).toEqual([]);
  });
});

// -- extractAgentDelta -----------------------------------------------------

describe("extractAgentDelta", () => {
  it("forwards non-empty agent text", () => {
    expect(
      extractAgentDelta({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toBe("hello");
  });

  it("drops empty agent text", () => {
    expect(
      extractAgentDelta({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
      }),
    ).toBeNull();
  });

  it("drops non-text content", () => {
    expect(
      extractAgentDelta({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "base64data",
          mimeType: "image/png",
        },
      }),
    ).toBeNull();
  });

  it("drops agent_thought_chunk", () => {
    expect(
      extractAgentDelta({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    ).toBeNull();
  });

  it("drops user_message_chunk", () => {
    expect(
      extractAgentDelta({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "my prompt" },
      }),
    ).toBeNull();
  });
});

// -- openAcpSession integration via paired in-memory streams ---------------

interface FakeAgentBehavior {
  /** Called from inside Agent.prompt to drive sessionUpdate notifications. */
  prompt?: (
    req: PromptRequest,
    push: (text: string) => Promise<void>,
  ) => Promise<PromptResponse>;
  /** Optional override of newSession (otherwise returns a default response). */
  newSessionId?: string;
}

function makeFakeAgent(behavior: FakeAgentBehavior = {}) {
  const sessionId = behavior.newSessionId ?? "fake-session-1";
  return agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default", description: "" },
          { id: "bypassPermissions", name: "Bypass", description: "" },
        ],
      },
    }))
    .onRequest(methods.agent.session.setMode, () => ({}))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(
      methods.agent.session.prompt,
      async ({ params: req, client }) => {
        if (!behavior.prompt) {
          return { stopReason: "end_turn" };
        }
        const push = async (text: string): Promise<void> => {
          await client.notify(methods.client.session.update, {
            sessionId: req.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        };
        return behavior.prompt(req, push);
      },
    )
    .onNotification(methods.agent.session.cancel, () => {});
}

function makePairedStreams(): { client: Stream; agent: Stream } {
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: ndJsonStream(c2a.writable, a2c.readable),
    agent: ndJsonStream(a2c.writable, c2a.readable),
  };
}

function makeTestHarness(behavior?: FakeAgentBehavior): {
  factory: () => Promise<StreamHandle>;
  signalExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const { client, agent: agentStream } = makePairedStreams();
  const fakeAgent = makeFakeAgent(behavior);
  fakeAgent.connect(agentStream);

  let resolveExit: (v: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void = () => {};
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveExit = resolve;
  });

  return {
    factory: () =>
      Promise.resolve({
        stream: client,
        exited,
        close: async (): Promise<void> => {
          resolveExit({ code: 0, signal: null });
        },
      }),
    signalExit: (code, signal) => resolveExit({ code, signal }),
  };
}

describe("openAcpSession", () => {
  it("performs initialize → newSession → setSessionMode and exposes sessionId", async () => {
    const { factory } = makeTestHarness({ newSessionId: "abc-123" });
    const session = await openAcpSession({
      personaDir: "/tmp/test-persona",
      launcher: fakeLauncher,
      logger,
      streamFactory: factory,
    });
    expect(session.sessionId).toBe("abc-123");
    await session.close();
  });

  it("streams agent_message_chunk deltas in order", async () => {
    const { factory } = makeTestHarness({
      prompt: async (_req, push) => {
        await push(""); // empty leading chunk — should be filtered
        await push("hello");
        await push(" ");
        await push("world");
        return { stopReason: "end_turn" };
      },
    });
    const session = await openAcpSession({
      personaDir: "/tmp/test-persona",
      launcher: fakeLauncher,
      logger,
      streamFactory: factory,
    });
    const collected: string[] = [];
    for await (const delta of session.prompt("hi")) {
      collected.push(delta);
    }
    expect(collected).toEqual(["hello", " ", "world"]);
    await session.close();
  });

  it("rejects new prompts after the subprocess has exited", async () => {
    // Note: the more complete scenario — subprocess exits *during* an
    // in-flight prompt — is covered by the production path. There the
    // closed stdio pipes cause the SDK client connection to reject the pending
    // RPC, which resolves the `settled` chain in the wrapper. The paired
    // in-memory streams here don't model EOF cleanly, so we exercise only
    // the post-exit "aborted" guard, which is what's specific to this
    // wrapper anyway.
    const { factory, signalExit } = makeTestHarness();
    const session = await openAcpSession({
      personaDir: "/tmp/test-persona",
      launcher: fakeLauncher,
      logger,
      streamFactory: factory,
    });
    signalExit(137, "SIGKILL");
    // Let the exited promise's .then handler run.
    await new Promise((r) => setTimeout(r, 20));
    await expect(async () => {
      for await (const _delta of session.prompt("hi")) {
        // never reached
      }
    }).rejects.toThrow(/subprocess has exited/);
  });

  it("rejects a second concurrent prompt", async () => {
    let release: () => void = () => {};
    const releaseSignal = new Promise<void>((r) => {
      release = r;
    });
    const { factory } = makeTestHarness({
      prompt: async (_req, push) => {
        await push("slow");
        await releaseSignal;
        return { stopReason: "end_turn" };
      },
    });
    const session = await openAcpSession({
      personaDir: "/tmp/test-persona",
      launcher: fakeLauncher,
      logger,
      streamFactory: factory,
    });
    const first = (async () => {
      const out: string[] = [];
      for await (const d of session.prompt("first")) out.push(d);
      return out;
    })();

    // Give the first prompt a moment to register as active.
    await new Promise((r) => setTimeout(r, 20));

    await expect(async () => {
      for await (const _ of session.prompt("second")) {
        // never reached
      }
    }).rejects.toThrow(/already streaming/);

    release();
    expect(await first).toEqual(["slow"]);
    await session.close();
  });
});
