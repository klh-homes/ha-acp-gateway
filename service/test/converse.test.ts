import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import type { AcpFactory, AcpSession } from "../src/acp_session.js";
import { SessionPool } from "../src/session_pool.js";

const TEST_BEARER = "test-bearer-token";
const logger = createLogger("silent");

interface FakeSessionOptions {
  deltas?: string[];
  promptThrows?: unknown;
  onClose?: () => void;
}

function makeFakeAcpFactory(opts: FakeSessionOptions = {}): AcpFactory {
  return () => {
    let closeResolve: () => void = () => {};
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });
    const session: AcpSession = {
      sessionId: `fake-${Math.random().toString(36).slice(2, 8)}`,
      closed,
      async *prompt(_text: string): AsyncIterable<string> {
        if (opts.promptThrows !== undefined) throw opts.promptThrows;
        for (const d of opts.deltas ?? []) {
          yield d;
        }
      },
      close(): Promise<void> {
        opts.onClose?.();
        closeResolve();
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  };
}

function makeApp(opts?: FakeSessionOptions & { factoryThrows?: unknown }) {
  const factory: AcpFactory =
    opts?.factoryThrows !== undefined
      ? () => Promise.reject(opts.factoryThrows as Error)
      : makeFakeAcpFactory(opts);
  const pool = new SessionPool({
    factory,
    logger,
    maxConcurrent: 8,
    idleTtlMs: 60_000,
    idleCheckMs: 0,
  });
  return createApp({
    logger,
    bearerToken: TEST_BEARER,
    personaDir: "/tmp/test-persona",
    oauthToken: "fake-oauth",
    pool,
  });
}

interface SseEvent {
  event: string;
  data: string;
}

async function readSseEvents(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const chunk of text.split("\n\n")) {
    if (!chunk.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    events.push({ event, data });
  }
  return events;
}

function authedHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_BEARER}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/converse — auth", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await makeApp().request("/v1/converse", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a non-Bearer scheme", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: { authorization: `Basic ${TEST_BEARER}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/converse — request validation", () => {
  it("returns 400 on non-JSON body", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when conversation_id is missing", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when messages is empty", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ conversation_id: "c1", messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a message lacks role or content", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user" }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/converse — SSE stream", () => {
  it("streams text deltas through the pool and terminates with done", async () => {
    const res = await makeApp({
      deltas: ["hello", " ", "world"],
    }).request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    expect(res.status).toBe(200);

    const events = await readSseEvents(res);
    const text = events
      .filter((e) => e.event === "text")
      .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
      .join("");
    expect(text).toBe("hello world");
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
  });

  it("emits a generic friendly error when the factory throws", async () => {
    const res = await makeApp({
      factoryThrows: new Error("ENOENT: spawn claude-agent-acp"),
    }).request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    const errors = events.filter((e) => e.event === "error");
    expect(errors).toHaveLength(1);
    const message = (JSON.parse(errors[0]!.data) as { message: string }).message;
    // The raw "ENOENT" should never reach TTS — only the friendly default.
    expect(message).not.toMatch(/ENOENT/);
    expect(message).toMatch(/problem|try again/i);
    expect(events.filter((e) => e.event === "done")).toHaveLength(0);
  });

  it("emits the subprocess-exit-specific friendly message", async () => {
    const res = await makeApp({
      promptThrows: new Error("subprocess exited (code=137, signal=SIGKILL)"),
    }).request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    const errors = events.filter((e) => e.event === "error");
    expect(errors).toHaveLength(1);
    const message = (JSON.parse(errors[0]!.data) as { message: string }).message;
    expect(message).toMatch(/lost contact/i);
  });

  it("emits an error event when prompt throws mid-stream", async () => {
    const res = await makeApp({
      promptThrows: new Error("agent crashed"),
    }).request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(events.filter((e) => e.event === "error")).toHaveLength(1);
    expect(events.filter((e) => e.event === "done")).toHaveLength(0);
  });

  it("emits a friendly error event when there is no user message", async () => {
    const res = await makeApp({ deltas: ["never-yielded"] }).request(
      "/v1/converse",
      {
        method: "POST",
        headers: authedHeaders(),
        body: JSON.stringify({
          conversation_id: "c1",
          messages: [{ role: "system", content: "system only" }],
        }),
      },
    );
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(events.filter((e) => e.event === "error")).toHaveLength(1);
  });
});

describe("POST /v1/converse — singleton session affinity", () => {
  it("collapses different conversation_ids to one session when affinity is entity", async () => {
    let factoryCalls = 0;
    const factory: AcpFactory = () => {
      factoryCalls++;
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      return Promise.resolve({
        sessionId: `sess-${factoryCalls}`,
        closed,
        async *prompt(_text: string): AsyncIterable<string> {
          yield `delta-${factoryCalls}`;
        },
        close(): Promise<void> {
          resolveClosed();
          return Promise.resolve();
        },
      } satisfies AcpSession);
    };
    const pool = new SessionPool({
      factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const app = createApp({
      logger,
      bearerToken: TEST_BEARER,
      personaDir: "/tmp/p",
      oauthToken: "fake",
      pool,
      sessionAffinity: "entity",
    });

    // Two requests with DIFFERENT conversation_ids — singleton mode should
    // route both to the same session entry.
    for (const cid of ["one", "two"]) {
      await app.request("/v1/converse", {
        method: "POST",
        headers: authedHeaders(),
        body: JSON.stringify({
          conversation_id: cid,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    }

    expect(factoryCalls).toBe(1);
    expect(pool.size()).toBe(1);
    await pool.close();
  });
});

describe("POST /v1/converse — pool integration", () => {
  it("reuses the same session for the same conversation_id across requests", async () => {
    let factoryCalls = 0;
    const factory: AcpFactory = () => {
      factoryCalls++;
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      return Promise.resolve({
        sessionId: `sess-${factoryCalls}`,
        closed,
        async *prompt(_text: string): AsyncIterable<string> {
          yield `from sess-${factoryCalls}`;
        },
        close(): Promise<void> {
          resolveClosed();
          return Promise.resolve();
        },
      } satisfies AcpSession);
    };
    const pool = new SessionPool({
      factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const app = createApp({
      logger,
      bearerToken: TEST_BEARER,
      personaDir: "/tmp/p",
      oauthToken: "fake",
      pool,
    });

    const body = JSON.stringify({
      conversation_id: "conv-A",
      messages: [{ role: "user", content: "hi" }],
    });
    await app.request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body,
    });
    await app.request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body,
    });
    expect(factoryCalls).toBe(1);
    expect(pool.size()).toBe(1);
    await pool.close();
  });

  it("returns a friendly error when the pool is at capacity and all sessions are busy", async () => {
    let release: () => void = () => {};
    const releaseSignal = new Promise<void>((r) => {
      release = r;
    });
    const factory: AcpFactory = () => {
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      return Promise.resolve({
        sessionId: "sess-block",
        closed,
        async *prompt(_text: string): AsyncIterable<string> {
          yield "first";
          await releaseSignal;
        },
        close(): Promise<void> {
          resolveClosed();
          return Promise.resolve();
        },
      } satisfies AcpSession);
    };
    const pool = new SessionPool({
      factory,
      logger,
      maxConcurrent: 1,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const app = createApp({
      logger,
      bearerToken: TEST_BEARER,
      personaDir: "/tmp/p",
      oauthToken: "fake",
      pool,
    });

    const first = app.request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "A",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // Let the first request acquire and start streaming.
    await new Promise((r) => setTimeout(r, 30));

    const second = await app.request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "B",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(second.status).toBe(200);
    const events = await readSseEvents(second);
    const errors = events.filter((e) => e.event === "error");
    expect(errors).toHaveLength(1);
    expect((JSON.parse(errors[0]!.data) as { message: string }).message).toMatch(
      /busy|try again/i,
    );

    release();
    await first;
    await pool.close();
  });
});
