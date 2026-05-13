import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import type { AcpFactory } from "../src/converse.js";
import type { AcpSession } from "../src/acp_session.js";

const TEST_BEARER = "test-bearer-token";

interface FakeSessionOptions {
  deltas?: string[];
  promptThrows?: unknown;
  onClose?: () => void;
}

function makeFakeAcpFactory(opts: FakeSessionOptions = {}): AcpFactory {
  return () =>
    Promise.resolve({
      sessionId: "fake-session-1",
      async *prompt(_text: string): AsyncIterable<string> {
        if (opts.promptThrows !== undefined) throw opts.promptThrows;
        for (const d of opts.deltas ?? []) {
          yield d;
        }
      },
      close(): Promise<void> {
        opts.onClose?.();
        return Promise.resolve();
      },
    } satisfies AcpSession);
}

function makeApp(opts?: FakeSessionOptions & { factoryThrows?: unknown }) {
  const factory: AcpFactory =
    opts?.factoryThrows !== undefined
      ? () => Promise.reject(opts.factoryThrows as Error)
      : makeFakeAcpFactory(opts);
  return createApp({
    logger: createLogger("silent"),
    bearerToken: TEST_BEARER,
    personaDir: "/tmp/test-persona",
    oauthToken: "fake-oauth",
    acpFactory: factory,
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
  it("streams text deltas from the ACP session and terminates with done", async () => {
    let closed = false;
    const res = await makeApp({
      deltas: ["hello", " ", "world"],
      onClose: () => {
        closed = true;
      },
    }).request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "previous reply" },
          { role: "user", content: "current prompt" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);

    const events = await readSseEvents(res);
    const text = events
      .filter((e) => e.event === "text")
      .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
      .join("");
    const done = events.filter((e) => e.event === "done");

    expect(text).toBe("hello world");
    expect(done).toHaveLength(1);
    expect(closed).toBe(true);
  });

  it("emits an error event and closes the session when the factory throws", async () => {
    const res = await makeApp({
      factoryThrows: new Error("spawn failed"),
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
    const done = events.filter((e) => e.event === "done");

    expect(errors).toHaveLength(1);
    expect((JSON.parse(errors[0]!.data) as { message: string }).message).toMatch(
      /spawn failed/,
    );
    expect(done).toHaveLength(0);
  });

  it("emits an error event when prompt throws mid-stream and still closes the session", async () => {
    let closed = false;
    const res = await makeApp({
      promptThrows: new Error("agent crashed"),
      onClose: () => {
        closed = true;
      },
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
    expect(closed).toBe(true);
  });

  it("emits an error event when there is no user message", async () => {
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
    const errors = events.filter((e) => e.event === "error");
    expect(errors).toHaveLength(1);
    expect((JSON.parse(errors[0]!.data) as { message: string }).message).toMatch(
      /no user message/i,
    );
  });
});
