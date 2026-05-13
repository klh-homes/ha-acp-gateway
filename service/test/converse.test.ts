import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";

const TEST_BEARER = "test-bearer-token";

function makeApp() {
  return createApp({
    logger: createLogger("silent"),
    bearerToken: TEST_BEARER,
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

describe("POST /v1/converse — SSE echo stream", () => {
  it("streams the last user message as text deltas terminated by done", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c1",
        messages: [
          { role: "user", content: "ignored earlier message" },
          { role: "assistant", content: "previous reply" },
          { role: "user", content: "hello world this is the prompt" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^text\/event-stream/);

    const events = await readSseEvents(res);
    const textEvents = events.filter((e) => e.event === "text");
    const doneEvents = events.filter((e) => e.event === "done");

    expect(textEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);

    const reconstructed = textEvents
      .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
      .join("");
    expect(reconstructed).toBe("hello world this is the prompt");
  });

  it("falls back to a placeholder when there is no user message", async () => {
    const res = await makeApp().request("/v1/converse", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        conversation_id: "c2",
        messages: [{ role: "system", content: "just a system message" }],
      }),
    });
    expect(res.status).toBe(200);

    const events = await readSseEvents(res);
    const reconstructed = events
      .filter((e) => e.event === "text")
      .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
      .join("");
    expect(reconstructed).toBe("(no user message)");
  });
});
